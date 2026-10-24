package engine

import (
	"bufio"
	"compress/gzip"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// PruneOptions bounds a data dir (see PruneDataDir).
type PruneOptions struct {
	// Limit is the most the data dir may hold, in bytes. 0 removes only the
	// leftovers nothing will ever use again.
	Limit int64
	// KeepEngines names engine versions never removed (the one the app set
	// up with, which it checks for at launch).
	KeepEngines []string
}

// PruneResult is what a PruneDataDir call found and freed.
type PruneResult struct {
	Before, After int64
	Removed       []string // data-dir-relative paths, in removal order
}

// PruneDataDir keeps a data dir under opts.Limit by deleting what was used
// longest ago. Every re-simulation can pull in a new game build, a new map
// and a new engine version, and nothing else ever removes one, so a host that
// re-simulates game after game grows without end (a volunteer's FogOfWar
// folder reached 45 GB, then pr-downloader refused the next game for want of
// 1 GiB and every run failed).
//
// First it removes what nothing will use: unfinished downloads
// (packages/*.incomplete), widget streams a killed run left behind, and pool
// files no remaining game package lists. Then, while over the limit, the
// oldest by modification time of: demos, game packages (each followed by the
// pool files only it used), maps and engine versions. EnsureContent and
// EnsureEngine touch what a run uses, so the time is the last use. The newest
// of each kind always stays (the content the last run needed), and so do
// opts.KeepEngines; everything removed can be downloaded again.
//
// It takes the data dir's lock, so it never runs under a re-simulation.
func PruneDataDir(dataDir string, opts PruneOptions) (PruneResult, error) {
	var res PruneResult
	unlock, err := LockDataDir(dataDir)
	if err != nil {
		return res, err
	}
	defer unlock()

	total, err := dirSize(dataDir)
	if err != nil {
		return res, err
	}
	res.Before = total
	remove := func(rel string) {
		p := filepath.Join(dataDir, rel)
		n, _ := dirSize(p)
		if err := os.RemoveAll(p); err != nil {
			fmt.Fprintf(os.Stderr, "engine: prune: %v\n", err)
			n -= sizeOr0(p) // whatever could not be removed is still there
		}
		total -= n
		res.Removed = append(res.Removed, filepath.ToSlash(rel))
	}

	// Leftovers.
	for _, pat := range []string{"packages/*.incomplete", "LuaUI/Config/barreplay/*.brepstream"} {
		m, _ := filepath.Glob(filepath.Join(dataDir, filepath.FromSlash(pat)))
		for _, p := range m {
			rel, _ := filepath.Rel(dataDir, p)
			remove(rel)
		}
	}
	gc := func() {
		freed, removed := gcPool(dataDir)
		total -= freed
		if removed > 0 {
			res.Removed = append(res.Removed, fmt.Sprintf("pool (%d unused files)", removed))
		}
	}
	gc()

	if total > opts.Limit {
		keep := map[string]bool{}
		for _, v := range opts.KeepEngines {
			keep[filepath.ToSlash(filepath.Join("engine", v))] = true
		}
		for _, c := range pruneCandidates(dataDir, keep) {
			if total <= opts.Limit {
				break
			}
			remove(c.rel)
			if c.kind == "game" {
				gc()
			}
		}
	}
	res.After = total
	return res, nil
}

type pruneItem struct {
	kind, rel string
	mod       time.Time
}

// pruneCandidates lists what may go, in the order it goes: demos first (a
// re-download is a few MB), then the rest oldest first. The newest of each
// kind is left out.
func pruneCandidates(dataDir string, keep map[string]bool) []pruneItem {
	var all []pruneItem
	add := func(kind, dir string, want func(fs.DirEntry) bool) {
		entries, _ := os.ReadDir(filepath.Join(dataDir, dir))
		var items []pruneItem
		for _, e := range entries {
			if !want(e) {
				continue
			}
			rel := dir + "/" + e.Name()
			if keep[rel] {
				continue
			}
			fi, err := e.Info()
			if err != nil {
				continue
			}
			items = append(items, pruneItem{kind, rel, fi.ModTime()})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
		if len(items) > 0 {
			items = items[:len(items)-1] // the newest stays
		}
		all = append(all, items...)
	}
	file := func(exts ...string) func(fs.DirEntry) bool {
		return func(e fs.DirEntry) bool {
			if e.IsDir() {
				return false
			}
			ext := strings.ToLower(filepath.Ext(e.Name()))
			for _, x := range exts {
				if ext == x {
					return true
				}
			}
			return false
		}
	}
	add("demo", "demos", file(".sdfz"))
	demos := len(all)
	add("game", "packages", file(".sdp"))
	add("map", "maps", file(".sd7", ".sdz"))
	add("engine", "engine", func(e fs.DirEntry) bool { return e.IsDir() && !strings.HasPrefix(e.Name(), ".") })
	rest := all[demos:]
	sort.SliceStable(rest, func(i, j int) bool { return rest[i].mod.Before(rest[j].mod) })
	return all
}

// gcPool removes the pool files no game package lists. It removes nothing
// when any package cannot be read, since a file it lists would then look
// unused.
func gcPool(dataDir string) (freed int64, removed int) {
	pkgs, _ := filepath.Glob(filepath.Join(dataDir, "packages", "*.sdp"))
	used := map[string]bool{}
	for _, p := range pkgs {
		if err := sdpFiles(p, used); err != nil {
			fmt.Fprintf(os.Stderr, "engine: prune: not cleaning the pool: %s: %v\n", filepath.Base(p), err)
			return 0, 0
		}
	}
	dirs, _ := os.ReadDir(filepath.Join(dataDir, "pool"))
	for _, d := range dirs {
		if !d.IsDir() || len(d.Name()) != 2 {
			continue
		}
		dir := filepath.Join(dataDir, "pool", d.Name())
		files, _ := os.ReadDir(dir)
		for _, f := range files {
			name := f.Name()
			if f.IsDir() || !strings.HasSuffix(name, ".gz") {
				continue
			}
			if used[strings.ToLower(d.Name()+strings.TrimSuffix(name, ".gz"))] {
				continue
			}
			fi, err := f.Info()
			if err != nil {
				continue
			}
			if os.Remove(filepath.Join(dir, name)) == nil {
				freed += fi.Size()
				removed++
			}
		}
	}
	return freed, removed
}

// sdpFiles adds the md5 of every file a rapid package lists to used (the
// format is in gameWidgetNames).
func sdpFiles(path string, used map[string]bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	r := bufio.NewReader(zr)
	for {
		n, err := r.ReadByte()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		rec := make([]byte, int(n)+24)
		if _, err := io.ReadFull(r, rec); err != nil {
			return fmt.Errorf("truncated package index: %w", err)
		}
		used[hex.EncodeToString(rec[n:n+16])] = true
	}
}

// touch marks content as just used, for PruneDataDir's order.
func touch(p string) {
	now := time.Now()
	_ = os.Chtimes(p, now, now)
}

func dirSize(p string) (int64, error) {
	var n int64
	err := filepath.WalkDir(p, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if !d.IsDir() && d.Name() != LockName {
			if fi, err := d.Info(); err == nil {
				n += fi.Size()
			}
		}
		return nil
	})
	return n, err
}

func sizeOr0(p string) int64 {
	n, _ := dirSize(p)
	return n
}
