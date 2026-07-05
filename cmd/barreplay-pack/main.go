// Command barreplay-pack converts existing captures (.jsonl or raw .brsnap)
// into the compact binary .brp format — typically a ~40x size reduction. Use it
// to shrink captures recorded before .brp became the default output.
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
	"os"
	"path/filepath"
	"strings"

	"github.com/mabn/barreplay/internal/viz"
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

func pack(in, outDir string) error {
	ext := strings.ToLower(filepath.Ext(in))
	if ext != ".jsonl" && ext != ".brsnap" {
		return fmt.Errorf("unsupported input type %q (want .jsonl or .brsnap)", ext)
	}
	rep, err := viz.Load(in)
	if err != nil {
		return err
	}
	gameID := strings.TrimSuffix(filepath.Base(in), filepath.Ext(in))
	if rep.Meta.GameID == "" {
		rep.Meta.GameID = gameID
	}
	dir := outDir
	if dir == "" {
		dir = filepath.Dir(in)
	}
	w, err := snapshot.NewBRPWriter(dir, gameID)
	if err != nil {
		return err
	}
	if err := w.WriteMeta(rep.Meta); err != nil {
		w.Close()
		return err
	}
	for _, fr := range rep.Frames {
		if err := w.WriteFrame(fr); err != nil {
			w.Close()
			return err
		}
	}
	for _, e := range rep.Events {
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
		in, mb(inSize), outPath, mb(outSize), ratio, len(rep.Frames), len(rep.Events))
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
