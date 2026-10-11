package main

import (
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"

	"github.com/mabn/barreplay/internal/packer"
)

// objectCache keeps a copy of every replay object this command downloads,
// under dir/<key>, so a re-run reads its .brp files (and an old replay's
// pieces) from disk instead of downloading them again. That matters because
// the summary takes several passes over the same catalog: -all to publish,
// -upload= -all -out to collect the files for cmd/winfit, and -all again
// after a refit bumps the insights version.
//
// A copy never goes stale because the bucket is append-only: a revision's
// pieces are never rewritten (the publishers refuse to overwrite them), and a
// changed summary is a new file name. The one rewrite is -force, which
// republishes a summary under its old name, and that goes through put too.
// Misses are not remembered: a 404 becomes an object as soon as something is
// published there.
//
// It is shared by every replay in flight (-j). Two of them missing the same
// key both download it and both store it, each through its own temporary
// file, so the last rename wins with the same bytes; only the tallies need
// the lock.
//
// A nil *objectCache is a cache that holds nothing.
type objectCache struct {
	dir string
	// What this run read from disk and what it stored, for the closing line.
	mu                    sync.Mutex
	hits, stored          int
	hitBytes, storedBytes int64
}

// cacheDir resolves -cache for a destination: "" for no cache, else the
// directory its objects are kept in, which is always per bucket host so two
// destinations' objects of the same name never meet. "auto" caches only the
// real bucket: the dev simulator's bucket is a scratch copy that gets wiped
// and refilled, so a main replay's name there can come back holding another
// capture, and a kept copy would then be wrong.
func cacheDir(flagVal string, t packer.UploadTarget) string {
	root := flagVal
	switch flagVal {
	case "":
		return ""
	case "auto":
		if t.Name != "r2" {
			return ""
		}
		var err error
		if root, err = autoCacheRoot(); err != nil {
			fmt.Fprintf(os.Stderr, "insights: no cache (%v); -cache names a directory\n", err)
			return ""
		}
	}
	return filepath.Join(root, hostDir(t.DataURL))
}

func autoCacheRoot() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "barreplay"), nil
}

// autoCacheHelp says where -cache auto keeps the real bucket's objects.
func autoCacheHelp() string {
	where := "the user cache dir"
	if root, err := autoCacheRoot(); err == nil {
		t, _ := packer.LookupTarget("r2")
		where = filepath.Join(root, hostDir(t.DataURL))
	}
	return where + " for r2, none for local"
}

// hostDir is a data origin's host as a directory name.
func hostDir(origin string) string {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return "default"
	}
	return strings.ReplaceAll(u.Host, ":", "_")
}

// file maps a bucket key to its path, or "" for a key that is not a plain
// relative path (the rid in it came from the catalog, so it is checked).
func (c *objectCache) file(key string) string {
	if c == nil || key == "." || path.Clean(key) != key || !filepath.IsLocal(filepath.FromSlash(key)) {
		return ""
	}
	return filepath.Join(c.dir, filepath.FromSlash(key))
}

func (c *objectCache) get(key string) ([]byte, bool) {
	p := c.file(key)
	if p == "" {
		return nil, false
	}
	b, err := os.ReadFile(p)
	if err != nil || len(b) == 0 {
		// An empty file is a failed download an older build cached; a miss
		// fetches it again and the put replaces it.
		return nil, false
	}
	c.mu.Lock()
	c.hits++
	c.hitBytes += int64(len(b))
	c.mu.Unlock()
	return b, true
}

// put stores b under key. Best-effort: a cache that cannot be written costs
// a download next time, never this run.
func (c *objectCache) put(key string, b []byte) {
	p := c.file(key)
	if p == "" {
		return
	}
	if err := writeAtomic(p, b); err != nil {
		fmt.Fprintf(os.Stderr, "insights: cache: %v\n", err)
		return
	}
	c.mu.Lock()
	c.stored++
	c.storedBytes += int64(len(b))
	c.mu.Unlock()
}

// writeAtomic writes through a temporary file and a rename, so a run killed
// mid-write leaves no truncated copy for the next run to trust.
func writeAtomic(p string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(p), ".part-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), p)
}

// summary is the closing line: what came from disk and what was downloaded.
func (c *objectCache) summary() string {
	if c == nil {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return fmt.Sprintf("cache %s: %d files read from disk (%s), %d stored (%s)",
		c.dir, c.hits, mb(c.hitBytes), c.stored, mb(c.storedBytes))
}

func mb(n int64) string {
	return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
}
