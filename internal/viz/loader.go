// Package viz loads recorded barreplay snapshots and serves an interactive,
// browser-based playback of the game state (unit positions/teams/health over
// time). It is a separate tool from the capture pipeline: it only ever reads
// finished snapshot files.
//
// Three on-disk shapes are understood:
//
//   - .brp    — the compact binary v2 format owned by the snapshot package.
//     This is the normal input; the server additionally serves its data
//     sections to the browser without decoding (see server.go).
//   - .jsonl  — the legacy v1 line-delimited JSON format (snapshot.NewReader).
//   - .brsnap — the raw tagged stream the Lua widget writes during a run
//     (parsed by internal/capture). Useful for inspecting a run whose capture
//     file was never produced (e.g. the engine was killed before Consume ran).
//
// Both are decoded into the same in-memory Replay, which the server encodes
// into a compact wire format for the front-end.
package viz

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/mabn/barreplay/internal/capture"
	"github.com/mabn/barreplay/snapshot"
)

// Replay is a fully-loaded capture held in memory: the static metadata plus the
// ordered periodic frames and lifecycle events.
type Replay struct {
	Meta   snapshot.Meta
	Frames []snapshot.Frame
	Events []snapshot.Event
}

// memWriter is a snapshot.Writer that accumulates everything in memory. It is
// the sink used when re-parsing a raw .brsnap stream through internal/capture,
// and mirrors the shape a jsonl read produces.
type memWriter struct {
	rep *Replay
}

func (m *memWriter) WriteMeta(md snapshot.Meta) error { m.rep.Meta = md; return nil }
func (m *memWriter) WriteFrame(f snapshot.Frame) error {
	m.rep.Frames = append(m.rep.Frames, f)
	return nil
}
func (m *memWriter) WriteEvent(e snapshot.Event) error {
	m.rep.Events = append(m.rep.Events, e)
	return nil
}
func (m *memWriter) Close() error { return nil }

// Load reads a snapshot file, dispatching on its extension. .brp is decoded by
// the snapshot package, .brsnap is parsed through internal/capture; anything
// else is treated as JSONL.
func Load(path string) (*Replay, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	switch strings.ToLower(filepath.Ext(path)) {
	case ".brp":
		meta, frames, events, err := snapshot.ReadBRP(f)
		if err != nil {
			return nil, fmt.Errorf("viz: reading brp: %w", err)
		}
		return &Replay{Meta: meta, Frames: frames, Events: events}, nil
	case ".brsnap":
		return loadBRSNAP(f, gameIDFromPath(path))
	}
	return loadJSONL(f)
}

// loadJSONL decodes the v1 line-delimited JSON format via snapshot.Reader.
func loadJSONL(r io.Reader) (*Replay, error) {
	rep := &Replay{}
	rd := snapshot.NewReader(r)
	sawMeta := false
	for {
		meta, frame, event, err := rd.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("viz: reading jsonl: %w", err)
		}
		switch {
		case meta != nil:
			rep.Meta = *meta
			sawMeta = true
		case frame != nil:
			rep.Frames = append(rep.Frames, *frame)
		case event != nil:
			rep.Events = append(rep.Events, *event)
		}
	}
	if !sawMeta {
		return nil, fmt.Errorf("viz: no meta record found (is this a barreplay .jsonl?)")
	}
	return rep, nil
}

// loadBRSNAP re-parses the raw widget stream. The stream's D/T preamble carries
// the unit-def and team tables; the rest of Meta (versions, map) is not in the
// stream, so only the gameId (from the filename) is seeded.
func loadBRSNAP(r io.Reader, gameID string) (*Replay, error) {
	rep := &Replay{}
	base := snapshot.Meta{GameID: gameID}
	if err := capture.Consume(r, base, &memWriter{rep: rep}); err != nil {
		return nil, fmt.Errorf("viz: parsing brsnap: %w", err)
	}
	return rep, nil
}

func gameIDFromPath(path string) string {
	base := filepath.Base(path)
	return strings.TrimSuffix(base, filepath.Ext(base))
}
