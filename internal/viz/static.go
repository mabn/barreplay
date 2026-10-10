package viz

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/mabn/barreplay/snapshot"
)

// This file turns a .brp capture into a directory of plain static files so the
// viewer can be hosted with no server on the playback path (see the worker/
// Cloudflare project). The .brp format was designed for exactly this: the head
// is a pure function of the file's meta, and the keyframes section and each
// chunk's delta frames are independently-gzipped byte ranges — so serving them
// is a Range read of the stored file, not a re-encode. A bundle is three files:
//
//	replays/<gameId>.brw        the head (meta, icons, chunk index WITH the
//	                            absolute byte ranges of the keys and chunks)
//	replays/<gameId>.resources  per-frame team economy (JSON, decoded from X)
//	replays/<gameId>.brp        the capture itself, byte-for-byte; the viewer
//	                            Range-reads the K section and each chunk's
//	                            delta bytes out of it
//
// Bundles published before the .brp was uploaded were split instead, into
// replays/<gameId>.keys plus one replays/<gameId>/c<i> per chunk. Nothing
// writes those any more; the viewer still reads them for those old heads.
//
// index.json lists every replay in the bundle (rebuilt from disk, so a growing
// mirror stays correct). Unit and rank icons are NOT emitted here: they are a
// fixed, vendored set that ships with the viewer as bundled static assets.

// StaticReplay is one entry in the bundle's index.json (the replay picker).
type StaticReplay struct {
	// File is the key the viewer uses to build every other URL for this replay
	// (its gameId, e.g. "1234"); the head is replays/<File>.brw, etc.
	File   string `json:"file"`
	GameID string `json:"gameId"`
	// Size is the replay's on-disk static footprint in bytes (head + resources +
	// the .brp, or the split keys/chunks of an older bundle), shown in the picker.
	Size int64 `json:"size"`
}

// WriteStaticBundle writes the static-hosting artifacts for one .brp capture
// into outDir (a local mirror of the R2 bucket). It reuses the exact encoders
// behind /api/replay and /api/replay/resources, so the output is byte-identical
// to the dynamic server's. Returns the replay's gameId.
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

	replaysDir := filepath.Join(outDir, "replays")
	if err := os.MkdirAll(replaysDir, 0o755); err != nil {
		return "", err
	}

	// Head (.brw) and per-frame economy (.resources) — the same bytes the server
	// builds for /api/replay and /api/replay/resources.
	head, err := brpWirePayload(bf)
	if err != nil {
		return "", fmt.Errorf("head for %s: %w", gameID, err)
	}
	if err := os.WriteFile(filepath.Join(replaysDir, gameID+".brw"), head, 0o644); err != nil {
		return "", err
	}
	// Stored as plain JSON (not pre-gzipped): the host compresses it in transit,
	// and a pre-gzipped body would be double-compressed on Cloudflare.
	res, err := brpResourcesJSON(bf)
	if err != nil {
		return "", fmt.Errorf("resources for %s: %w", gameID, err)
	}
	if err := os.WriteFile(filepath.Join(replaysDir, gameID+".resources"), res, 0o644); err != nil {
		return "", err
	}

	// The frame data is the .brp itself: the viewer Range-reads the K section
	// and each chunk's delta bytes out of it at the absolute offsets the head
	// carries, so ONE object replaces the .keys file and the per-chunk c<n>
	// files the bundle used to be split into. Copied byte-for-byte — the
	// offsets in the head are offsets into exactly these bytes. Check the
	// ranges here so a malformed index fails the publish, not the viewer.
	if _, ok := bf.Sections[snapshot.SecKeyframes]; !ok {
		return "", fmt.Errorf("%s has no keyframes section", gameID)
	}
	sec := bf.Sections[snapshot.SecFrames]
	for i, c := range bf.Chunks {
		if end := c.FOff + c.FLen; c.FOff < 0 || end > int64(len(sec)) {
			return "", fmt.Errorf("%s chunk %d range [%d,%d) outside frames section (%d bytes)", gameID, i, c.FOff, end, len(sec))
		}
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	out, err := os.Create(filepath.Join(replaysDir, gameID+".brp"))
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(out, f); err != nil {
		out.Close()
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	return gameID, nil
}

// WriteIndex (re)writes outDir/index.json listing every replay bundle found
// under outDir/replays (one *.brw per replay). Rebuilding from disk keeps a
// growing mirror correct without threading prior state through.
func WriteIndex(outDir string) (int, error) {
	dir := filepath.Join(outDir, "replays")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, fmt.Errorf("reading %s: %w", dir, err)
	}
	infos := []StaticReplay{}
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".brw") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		infos = append(infos, StaticReplay{File: id, GameID: id, Size: replayBundleSize(dir, id)})
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].File < infos[j].File })
	b, err := json.MarshalIndent(infos, "", "  ")
	if err != nil {
		return 0, err
	}
	return len(infos), os.WriteFile(filepath.Join(outDir, "index.json"), b, 0o644)
}

// replayBundleSize sums the stored footprint of one replay: its head,
// resources, and its .brp (or, for an older split bundle, its keys and chunk
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
