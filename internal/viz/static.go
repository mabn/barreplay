package viz

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/mabn/barreplay/internal/insights"
	"github.com/mabn/barreplay/snapshot"
)

// This file turns a .brp capture into a directory of plain static files so the
// viewer can be hosted with no server on the playback path (see the worker/
// Cloudflare project). A bundle is ONE file:
//
//	replays/<gameId>.brp   the capture, read by the viewer with HTTP Range
//	                       requests: the head of the file (meta, events,
//	                       comms) first, then the keyframes, each chunk's
//	                       delta bytes and the economy section at the
//	                       positions the meta's section layout gives
//
// The .brp format was designed for exactly this: every section the browser
// reads is an independently-gzipped byte range, so serving one is a Range
// read of the stored file, not a re-encode. Everything the viewer used to be
// sent precomputed — unit names, footprints, army costs, the icon table —
// is derived in the browser from the meta's unit-def table, and the icon
// table, being fixed per BAR version, ships with the viewer instead.
//
// Bundles published before this were several files: replays/<gameId>.brw (a
// precomputed head), replays/<gameId>.resources (the economy as JSON), and
// either the .brp or, older still, replays/<gameId>.keys plus one
// replays/<gameId>/c<i> per chunk. Nothing writes those any more; they stay
// in the bucket and the viewer still reads them when a replay has no .brp.
//
// index.json lists every replay in the bundle (rebuilt from disk, so a growing
// mirror stays correct). Unit and rank icons are NOT emitted here: they are a
// fixed, vendored set that ships with the viewer as bundled static assets.

// StaticReplay is one entry in the bundle's index.json (the replay picker).
type StaticReplay struct {
	// File is the key the viewer uses to build every URL for this replay (its
	// gameId, e.g. "1234"); the capture is replays/<File>.brp.
	File   string `json:"file"`
	GameID string `json:"gameId"`
	// Size is the replay's on-disk static footprint in bytes (the .brp, or
	// every piece of an older bundle), shown in the picker.
	Size int64 `json:"size"`
}

// WriteStaticBundle writes the static-hosting artifact for one .brp capture
// into outDir (a local mirror of the R2 bucket): replays/<gameId>.brp. The
// file is validated first, so a malformed index fails the publish rather than
// the viewer, and passed through snapshot.IndexBRP, which adds the section
// layout to a capture packed before the layout existed (a fresh capture is
// copied byte-for-byte). Returns the replay's gameId.
func WriteStaticBundle(brpPath, outDir string) (string, error) {
	f, err := os.Open(brpPath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	bf, err := snapshot.ParseBRP(f)
	if err != nil {
		return "", fmt.Errorf("parse %s: %w", brpPath, err)
	}
	gameID := strings.TrimSuffix(filepath.Base(brpPath), filepath.Ext(brpPath))
	if _, ok := bf.Sections[snapshot.SecKeyframes]; !ok {
		return "", fmt.Errorf("%s has no keyframes section", gameID)
	}
	fsec, xsec := bf.Sections[snapshot.SecFrames], bf.Sections[snapshot.SecExtra]
	for i, c := range bf.Chunks {
		if end := c.FOff + c.FLen; c.FOff < 0 || end > int64(len(fsec)) {
			return "", fmt.Errorf("%s chunk %d range [%d,%d) outside frames section (%d bytes)", gameID, i, c.FOff, end, len(fsec))
		}
		if end := c.XOff + c.XLen; c.XOff < 0 || c.XKeyLen > c.XLen || end > int64(len(xsec)) {
			return "", fmt.Errorf("%s chunk %d economy range [%d,%d) outside extra section (%d bytes)", gameID, i, c.XOff, end, len(xsec))
		}
	}

	replaysDir := filepath.Join(outDir, "replays")
	if err := os.MkdirAll(replaysDir, 0o755); err != nil {
		return "", err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := snapshot.IndexBRP(f, &buf); err != nil {
		return "", fmt.Errorf("%s: %w", gameID, err)
	}
	if err := os.WriteFile(filepath.Join(replaysDir, gameID+".brp"), buf.Bytes(), 0o644); err != nil {
		return "", err
	}

	// The game summary's data. A failure costs the summary, never the
	// publish: the replay itself is complete without it.
	if publishInsights {
		if err := WriteInsights(bf, filepath.Join(replaysDir, insights.FileName(gameID))); err != nil {
			fmt.Fprintf(os.Stderr, "warning: insights for %s: %v\n", gameID, err)
		}
	}
	return gameID, nil
}

// publishInsights gates writing the insights piece on publish. Pieces are
// immutable, so it stays off until the file's first version is complete:
// a partial v1 written now could never be replaced under the same name.
const publishInsights = false

// WriteInsights computes a parsed .brp's game summary and writes it to path.
func WriteInsights(bf *snapshot.BRPFile, path string) error {
	in, err := insights.FromBRP(bf)
	if err != nil {
		return err
	}
	ins, err := insights.Compute(in)
	if err != nil {
		return err
	}
	b, err := insights.Marshal(ins)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// WriteIndex (re)writes outDir/index.json listing every replay bundle found
// under outDir/replays (one *.brp — or, for an older bundle, *.brw — per
// replay). Rebuilding from disk keeps a
// growing mirror correct without threading prior state through.
func WriteIndex(outDir string) (int, error) {
	dir := filepath.Join(outDir, "replays")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, fmt.Errorf("reading %s: %w", dir, err)
	}
	infos := []StaticReplay{}
	seen := map[string]bool{}
	for _, e := range entries {
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if e.IsDir() || (ext != ".brp" && ext != ".brw") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		if seen[id] {
			continue
		}
		seen[id] = true
		infos = append(infos, StaticReplay{File: id, GameID: id, Size: replayBundleSize(dir, id)})
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].File < infos[j].File })
	b, err := json.MarshalIndent(infos, "", "  ")
	if err != nil {
		return 0, err
	}
	return len(infos), os.WriteFile(filepath.Join(outDir, "index.json"), b, 0o644)
}

// replayBundleSize sums the stored footprint of one replay: its .brp plus
// whatever an older bundle also carries (head, resources, keys and chunk
// files). Best-effort — unreadable files count as 0.
func replayBundleSize(replaysDir, id string) int64 {
	var total int64
	add := func(p string) {
		if fi, err := os.Stat(p); err == nil {
			total += fi.Size()
		}
	}
	add(filepath.Join(replaysDir, id+".brw"))
	add(filepath.Join(replaysDir, id+".resources"))
	add(filepath.Join(replaysDir, id+".brp"))
	add(filepath.Join(replaysDir, id+".keys"))
	if chunks, err := os.ReadDir(filepath.Join(replaysDir, id)); err == nil {
		for _, c := range chunks {
			if fi, err := c.Info(); err == nil {
				total += fi.Size()
			}
		}
	}
	return total
}
