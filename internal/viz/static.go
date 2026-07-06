package viz

import (
	"encoding/json"
	"fmt"
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
// chunk's delta frames are independently-gzipped byte ranges — so serving is a
// byte copy, not a re-encode. The artifacts below are byte-identical to what
// internal/viz serves dynamically (the URL scheme is shared):
//
//	replays/<gameId>.brw        == GET /replays/<gameId>.brw
//	replays/<gameId>.resources  == GET /replays/<gameId>.resources
//	replays/<gameId>.keys       == GET /replays/<gameId>.keys   (the K section:
//	                               every keyframe, one gzip stream, streamed
//	                               keys-first by the viewer)
//	replays/<gameId>/c<i>       == GET /replays/<gameId>/c<i>   (chunk i's delta
//	                               frames; not written when the chunk has none)
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
	// all chunks) — what the viewer downloads, shown in the picker.
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
	if err := os.MkdirAll(filepath.Join(replaysDir, gameID), 0o755); err != nil {
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

	// The keyframes section byte-for-byte: the viewer streams this one file to
	// make the whole timeline scrubbable before any chunk arrives.
	keys, ok := bf.Sections[snapshot.SecKeyframes]
	if !ok {
		return "", fmt.Errorf("%s has no keyframes section", gameID)
	}
	if err := os.WriteFile(filepath.Join(replaysDir, gameID+".keys"), keys, 0o644); err != nil {
		return "", err
	}

	// One file per frame chunk: its DELTA frames, the frames-section slice
	// [FOff, FOff+FLen). Independently gzipped, so this is a byte copy. A
	// single-frame chunk has no delta bytes and gets no file (the index in the
	// head says len == 0, so the viewer never asks).
	sec := bf.Sections[snapshot.SecFrames]
	for i, c := range bf.Chunks {
		end := c.FOff + c.FLen
		if c.FOff < 0 || end > int64(len(sec)) {
			return "", fmt.Errorf("%s chunk %d range [%d,%d) outside frames section (%d bytes)", gameID, i, c.FOff, end, len(sec))
		}
		if c.FLen == 0 {
			continue
		}
		p := filepath.Join(replaysDir, gameID, fmt.Sprintf("c%d", i))
		if err := os.WriteFile(p, sec[c.FOff:end], 0o644); err != nil {
			return "", err
		}
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

// replayBundleSize sums the download footprint of one replay: its head,
// resources, and every chunk file. Best-effort — unreadable files count as 0.
func replayBundleSize(replaysDir, id string) int64 {
	var total int64
	add := func(p string) {
		if fi, err := os.Stat(p); err == nil {
			total += fi.Size()
		}
	}
	add(filepath.Join(replaysDir, id+".brw"))
	add(filepath.Join(replaysDir, id+".resources"))
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
