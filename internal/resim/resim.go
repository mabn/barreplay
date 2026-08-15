// Package resim re-simulates a game headlessly in the Recoil engine to
// produce a FULL-view capture: the same download -> parse -> provision ->
// widget-inject -> run -> consume pipeline cmd/barreplay drives
// interactively, packaged as one call for programmatic use — notably the
// ingest daemon's -resim mode, which upgrades a one-sided live upload (a
// player's point of view) to the complete game state the engine can recover
// from the demo's deterministic input stream.
//
// It needs a working engine host: spring-headless matching the demo's engine
// version (or provisionable into DataDir), the game/map content
// (pr-downloader fetches what's missing), and working GL (see the GPU
// caveat in CLAUDE.md). A run takes minutes of wall time — callers should
// treat it as batch work, not part of an interactive request.
package resim

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/capture"
	"github.com/mabn/barreplay/internal/demofile"
	"github.com/mabn/barreplay/internal/engine"
	"github.com/mabn/barreplay/snapshot"
)

// Options configures one re-simulation. DataDir is required; everything
// else has working defaults.
type Options struct {
	// DataDir is the BAR/Spring data directory (engine/, games/, maps/; also
	// the engine's --write-dir). Required.
	DataDir string
	// OutDir receives <gameId>.brp (and the raw .brsnap stream, best-effort).
	// Required.
	OutDir string
	// Every is the sampling interval in sim frames (0 = 30 = 1 Hz).
	Every int
	// EngineBinary / PRDownloaderBinary override auto-location.
	EngineBinary       string
	PRDownloaderBinary string
	// SkipProvision assumes engine/game/map content is already installed.
	SkipProvision bool
}

// Run downloads the demo for gameID via the BAR API, re-simulates it with
// the snapshot widget injected, and writes <OutDir>/<gameId>.brp seeded with
// the demo startscript's metadata. Returns the .brp path and the demo's raw
// [modoptions] map (the catalog PUT's settings source, exactly like
// packer.Pack's demo fetch).
func Run(ctx context.Context, client *barapi.Client, gameID string, o Options) (string, map[string]string, error) {
	if o.DataDir == "" {
		return "", nil, fmt.Errorf("resim: DataDir is required")
	}
	if o.OutDir == "" {
		return "", nil, fmt.Errorf("resim: OutDir is required")
	}
	every := o.Every
	if every <= 0 {
		every = 30
	}

	// Demo: resolve + download by gameId, then parse header + startscript.
	r, err := client.Resolve(ctx, gameID)
	if err != nil {
		return "", nil, err
	}
	demoPath, err := client.Download(ctx, r, filepath.Join(o.DataDir, "demos"))
	if err != nil {
		return "", nil, err
	}
	f, err := os.Open(demoPath)
	if err != nil {
		return "", nil, err
	}
	demo, err := demofile.Parse(f)
	f.Close()
	if err != nil {
		return "", nil, fmt.Errorf("parsing demo %s: %w", r.FileName, err)
	}
	h := demo.Header
	base := demofile.BaseMeta(demo)
	base.SampleEvery = int32(every)

	// The widget can only write a RELATIVE path inside the engine write-dir
	// (Spring's LuaIO sandbox rejects absolute paths); read it back from there.
	relStream := "barreplay/" + h.GameID + ".brsnap"
	streamPath := filepath.Join(o.DataDir, "barreplay", h.GameID+".brsnap")
	if err := os.MkdirAll(filepath.Dir(streamPath), 0o755); err != nil {
		return "", nil, err
	}

	eng, err := engine.Locate(engine.Config{
		DataDir:            o.DataDir,
		EngineBinary:       o.EngineBinary,
		PRDownloaderBinary: o.PRDownloaderBinary,
		SampleEvery:        every,
		SkipProvision:      o.SkipProvision,
		SnapshotStreamPath: relStream,
		DisableWidgets:     true,
		ThrottleDraw:       true,
	}, h.EngineVersion)
	if err != nil {
		return "", nil, err
	}
	if err := eng.EnsureContent(ctx, demo.Startscript.GameType, demo.Startscript.MapName); err != nil {
		return "", nil, err
	}
	if _, err := eng.WriteWidget(); err != nil {
		return "", nil, err
	}
	if _, err := eng.WriteEngineConfig(); err != nil {
		return "", nil, err
	}
	restoreCfg, err := eng.EnableWidget()
	if err != nil {
		return "", nil, err
	}
	defer func() {
		if rerr := restoreCfg(); rerr != nil {
			fmt.Fprintf(os.Stderr, "resim: warning: could not restore widget config: %v\n", rerr)
		}
	}()
	scriptPath, err := eng.BuildStartscript(demoPath)
	if err != nil {
		return "", nil, err
	}

	w, err := snapshot.NewBRPWriter(o.OutDir, h.GameID)
	if err != nil {
		return "", nil, err
	}
	outPath := filepath.Join(o.OutDir, h.GameID+".brp")

	fmt.Fprintf(os.Stderr, "resim: %s: engine %s, %ds of game time — launching headless replay\n",
		h.GameID, h.EngineVersion, h.GameTime)
	runStart := time.Now()
	stdout, wait, err := eng.Run(ctx, scriptPath)
	if err != nil {
		w.Close()
		return "", nil, err
	}
	// Drain stdout so the engine's pipe never blocks the sim.
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
		}
		io.Copy(io.Discard, stdout)
	}()
	waitErr := wait()

	var stats capture.Stats
	var consumeErr error
	if raw, oerr := os.Open(streamPath); oerr != nil {
		consumeErr = fmt.Errorf("open widget output %s: %w (did the widget load and run? see the GL caveat in CLAUDE.md)", streamPath, oerr)
	} else {
		consumeErr = capture.ConsumeStats(raw, base, w, &stats)
		raw.Close()
	}
	closeErr := w.Close()
	for _, e := range []error{consumeErr, closeErr} {
		if e != nil {
			return "", nil, e
		}
	}
	// The engine exits via quitforce; a non-zero code there is not fatal.
	if waitErr != nil {
		fmt.Fprintf(os.Stderr, "resim: engine exited: %v\n", waitErr)
	}
	// Keep the raw stream next to the output (best-effort; it lives in the
	// data dir because the widget can only write inside the write-dir).
	if merr := os.Rename(streamPath, filepath.Join(o.OutDir, h.GameID+".brsnap")); merr != nil {
		fmt.Fprintf(os.Stderr, "resim: warning: could not move raw stream: %v\n", merr)
	}
	fmt.Fprintf(os.Stderr, "resim: %s: %d frames in %s -> %s\n",
		h.GameID, stats.Frames, time.Since(runStart).Round(time.Second), outPath)

	// Sanity: the produced capture must be the requested game.
	if !strings.EqualFold(h.GameID, gameID) {
		fmt.Fprintf(os.Stderr, "resim: warning: demo gameId %s != requested %s\n", h.GameID, gameID)
	}
	return outPath, demo.Startscript.ModOptions, nil
}
