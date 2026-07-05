// Command barreplay-pack converts legacy captures (.jsonl or raw .brsnap)
// into the compact binary .brp format — typically a ~35x size reduction, and
// the only format the viewer serves. Use it once per legacy capture.
//
// Usage:
//
//	barreplay-pack [flags] <capture.jsonl|capture.brsnap> [...]
//	barreplay-pack -out ./snapshots ./snapshots/*.jsonl
//
// Each input produces "<gameId>.brp" (gameId = the input's basename) in the
// input's own directory, or in -out when set. Inputs are processed
// independently; a failure on one is reported and the rest continue.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/mabn/barreplay/internal/capture"
	"github.com/mabn/barreplay/snapshot"
)

func main() {
	var (
		outDir = flag.String("out", "", "output directory (default: next to each input)")
	)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: barreplay-pack [flags] <capture.jsonl|capture.brsnap> [...]\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}
	failed := 0
	for _, in := range flag.Args() {
		if err := pack(in, *outDir); err != nil {
			fmt.Fprintf(os.Stderr, "barreplay-pack: %s: %v\n", in, err)
			failed++
		}
	}
	if failed > 0 {
		os.Exit(1)
	}
}

// loaded is an in-memory capture; it doubles as the snapshot.Writer sink when
// re-parsing a raw .brsnap through internal/capture.
type loaded struct {
	meta   snapshot.Meta
	frames []snapshot.Frame
	events []snapshot.Event
}

func (l *loaded) WriteMeta(m snapshot.Meta) error { l.meta = m; return nil }
func (l *loaded) WriteFrame(f snapshot.Frame) error {
	l.frames = append(l.frames, f)
	return nil
}
func (l *loaded) WriteEvent(e snapshot.Event) error {
	l.events = append(l.events, e)
	return nil
}
func (l *loaded) Close() error { return nil }

// load reads a legacy capture. .jsonl decodes through snapshot.NewReader;
// .brsnap (the raw widget stream) re-parses through internal/capture — the
// exact parser the capture pipeline uses. A .brsnap carries no versions/map,
// so only the gameId (from the filename) is seeded.
func load(path, gameID string) (*loaded, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	l := &loaded{}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".jsonl":
		rd := snapshot.NewReader(f)
		sawMeta := false
		for {
			meta, frame, event, err := rd.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, fmt.Errorf("reading jsonl: %w", err)
			}
			switch {
			case meta != nil:
				l.meta = *meta
				sawMeta = true
			case frame != nil:
				l.frames = append(l.frames, *frame)
			case event != nil:
				l.events = append(l.events, *event)
			}
		}
		if !sawMeta {
			return nil, fmt.Errorf("no meta record found (is this a barreplay .jsonl?)")
		}
	case ".brsnap":
		if err := capture.Consume(f, snapshot.Meta{GameID: gameID}, l); err != nil {
			return nil, fmt.Errorf("parsing brsnap: %w", err)
		}
	default:
		return nil, fmt.Errorf("unsupported input type %q (want .jsonl or .brsnap)", filepath.Ext(path))
	}
	return l, nil
}

func pack(in, outDir string) error {
	gameID := strings.TrimSuffix(filepath.Base(in), filepath.Ext(in))
	l, err := load(in, gameID)
	if err != nil {
		return err
	}
	if l.meta.GameID == "" {
		l.meta.GameID = gameID
	}
	dir := outDir
	if dir == "" {
		dir = filepath.Dir(in)
	}
	w, err := snapshot.NewBRPWriter(dir, gameID)
	if err != nil {
		return err
	}
	if err := w.WriteMeta(l.meta); err != nil {
		w.Close()
		return err
	}
	for _, fr := range l.frames {
		if err := w.WriteFrame(fr); err != nil {
			w.Close()
			return err
		}
	}
	for _, e := range l.events {
		if err := w.WriteEvent(e); err != nil {
			w.Close()
			return err
		}
	}
	if err := w.Close(); err != nil {
		return err
	}

	outPath := filepath.Join(dir, gameID+".brp")
	inSize, outSize := fileSize(in), fileSize(outPath)
	ratio := ""
	if outSize > 0 {
		ratio = fmt.Sprintf(", %.0fx smaller", float64(inSize)/float64(outSize))
	}
	fmt.Fprintf(os.Stderr, "%s (%.1f MB) -> %s (%.2f MB%s): %d frames, %d events\n",
		in, mb(inSize), outPath, mb(outSize), ratio, len(l.frames), len(l.events))
	return nil
}

func fileSize(path string) int64 {
	fi, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return fi.Size()
}

func mb(n int64) float64 { return float64(n) / (1024 * 1024) }
