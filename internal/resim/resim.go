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
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
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
	// ProgressEvery prints the same frame/ETA line cmd/barreplay's -progress
	// does, polled off the engine's infolog, this often. 0 disables it. A
	// re-sim of a long game runs for many minutes with no other output, so a
	// daemon wants this on.
	ProgressEvery time.Duration

	// Stats, when non-nil, receives what the run cost and how it went. Run
	// fills it in AS IT GOES, including on its error paths: a re-sim that
	// fails after forty minutes is precisely the one whose timings and
	// infolog are worth keeping, and returning them only on success would
	// throw away the record of every failure.
	Stats *RunStats

	// MinFreeBytes is how little memory the host may have left before the run
	// is stopped rather than waiting for the kernel to kill it (engine.
	// WatchMemory). 0 uses engine.DefaultMinFreeBytes; negative disables the
	// guard, which means accepting a global OOM and whatever systemd tears
	// down around it.
	MinFreeBytes int64

	// Progress, when non-nil, is kept up to date WHILE the run happens: the
	// phase it is in, how far into the simulation it is, and what the engine
	// process is costing (progress.go). Unlike Stats, which is a record read
	// afterwards, this is meant to be read from another goroutine as the run
	// goes — it is how the ingest daemon reports a job that will not return
	// for the better part of an hour.
	Progress *Progress
}

// RunStats is one re-simulation's processing record.
type RunStats struct {
	// EngineSec is the engine's wall time, launch to exit; LoadSec is the part
	// of it before the widget announced itself (VFS scan, map load, icon
	// atlas) and SimSec is the rest. LoadSec is 0 when the widget never
	// announced itself, which also means the run produced nothing.
	EngineSec float64
	LoadSec   float64
	SimSec    float64
	// Frames is the newest sim frame captured and Samples how many frames were
	// written; SpeedUp is sim frames per wall second over the baseline 30, i.e.
	// how much faster than realtime the re-simulation ran.
	Frames  int32
	Samples int
	SpeedUp float64
	// GameSec is the demo's own length, which is what Frames is short against
	// when a run is cut off.
	GameSec       int32
	EngineVersion string
	Infolog       engine.InfologSummary
}

// ErrOutOfMemory is what Run returns when the memory guard stopped the run
// (engine.WatchMemory). Callers match it with errors.Is to tell "this host is
// too small for this game" apart from every other way a re-simulation fails —
// the ingest daemon marks the job with it, so a queue full of failures says
// which of them are the machine's fault rather than the game's.
var ErrOutOfMemory = errors.New("host ran out of memory")

// Run downloads the demo for gameID via the BAR API, re-simulates it with
// the snapshot widget injected, and writes <OutDir>/<gameId>.brp seeded with
// the demo startscript's metadata. Returns the .brp path and the demo's raw
// [modoptions] map (the catalog PUT's settings source, exactly like
// packer.Pack's demo fetch).
func Run(ctx context.Context, client *barapi.Client, gameID string, o Options) (
	brpPath string, modOptions map[string]string, retErr error,
) {
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
	o.Progress.SetPhase(PhaseFetchingDemo)
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
	// A run that ends in an error has no use for the widget's raw stream, and
	// leaving it behind is not free: it lives in the DATA DIR (the Lua sandbox
	// forces that, see the note above), it is hundreds of megabytes, and a
	// daemon that keeps failing — a host too small for the games it is being
	// handed, say — accumulates one per game until the disk is the next thing
	// to go. The success path moves it out; this is every other path.
	defer removeAbandonedStream(streamPath, &retErr)

	// Runs share mutable state inside the data dir, so only one at a time.
	unlock, err := engine.LockDataDir(o.DataDir)
	if err != nil {
		return "", nil, err
	}
	defer func() {
		if uerr := unlock(); uerr != nil {
			fmt.Fprintf(os.Stderr, "resim: warning: releasing data-dir lock: %v\n", uerr)
		}
	}()

	// Before Locate, which now refuses a build that does not match the demo.
	o.Progress.SetPhase(PhaseProvisioning)
	if err := engine.EnsureEngine(ctx, engine.Config{
		DataDir:       o.DataDir,
		EngineBinary:  o.EngineBinary,
		SkipProvision: o.SkipProvision,
	}, h.EngineVersion); err != nil {
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
	o.Progress.SetPhase(PhaseStartingEngine)
	scriptPath, err := eng.BuildStartscript(demoPath)
	if err != nil {
		return "", nil, err
	}

	// The demo's own chat and drawings take precedence over anything the widget
	// records: they are complete and exactly framed (capture.ReplaceComms).
	w, err := snapshot.NewBRPWriter(o.OutDir, h.GameID)
	if err != nil {
		return "", nil, err
	}
	w = capture.ReplaceComms(w, demo.Comms)
	outPath := filepath.Join(o.OutDir, h.GameID+".brp")

	fmt.Fprintf(os.Stderr, "resim: %s: engine %s, %ds of game time — launching headless replay\n",
		h.GameID, h.EngineVersion, h.GameTime)
	runStart := time.Now()
	// The engine runs under a context of its own so the memory guard below can
	// end it: cancelling is what kills the process, and the guard must be able
	// to do that without cancelling the caller's ctx.
	runCtx, killEngine := context.WithCancel(ctx)
	defer killEngine()
	stdout, wait, err := eng.Run(runCtx, scriptPath)
	if err != nil {
		w.Close()
		return "", nil, err
	}
	// Stop before the kernel does. A re-simulation of a big game can want more
	// memory than a small host has, and letting that end in a global OOM costs
	// more than the run: systemd stops whole units whose OOMPolicy is "stop"
	// when a member is OOM-killed, which is the default for the scopes a user
	// manager creates — so an OOM-killed engine takes the tmux pane it was
	// started from with it. Stopping first turns that into an ordinary failed
	// job with a message saying what happened.
	var lowMem memGuard
	go engine.WatchMemory(runCtx, o.minFree(), memCheckEvery, func(avail int64) {
		rss := int64(0)
		if s, ok := engine.SampleProcess(eng.Pid()); ok {
			rss = s.RSSBytes
		}
		lowMem.trip(avail, rss)
		fmt.Fprintf(os.Stderr, "resim: %s: only %s of memory left on this host (engine %s) — "+
			"stopping the engine before the kernel does\n",
			h.GameID, engine.FormatBytes(avail), engine.FormatBytes(rss))
		killEngine()
	})
	// Drain stdout so the engine's pipe never blocks the sim, watching on the
	// way past for the widget's first "[barreplay]" line: the widget
	// initializes exactly when loading ends, so its timestamp is what splits
	// the engine's wall time into a load phase and a sim phase.
	widgetLoaded := make(chan time.Time, 1)
	o.Progress.SetPhase(PhaseLoading)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			if strings.Contains(sc.Text(), "[barreplay]") {
				widgetLoaded <- time.Now()
				// The widget initializes exactly when loading ends, so this
				// line is also the boundary a watcher reports.
				o.Progress.SetPhase(PhaseSimulating)
				break
			}
		}
		io.Copy(io.Discard, stdout) // keep draining (also covers a scanner error)
	}()
	if o.Progress != nil {
		// Cancelled before this function returns, like the printer below: a
		// watcher outliving the run would sample the next game's infolog and a
		// pid that is gone or reused.
		wctx, wcancel := context.WithCancel(ctx)
		defer wcancel()
		go watchProgress(wctx, o.Progress, eng.InfologPath(), eng.Pid(), h.GameTime*gameSpeed, progressSampleEvery)
	}
	if o.ProgressEvery > 0 {
		// Stopped before this function returns, so the watcher cannot outlive
		// the run and print against the next game's infolog.
		pctx, pcancel := context.WithCancel(ctx)
		defer pcancel()
		go engine.WatchProgress(pctx, eng.InfologPath(), int(h.GameTime), o.ProgressEvery, os.Stderr)
	}
	waitErr := wait()
	o.Progress.SetPhase(PhaseCapturing)

	// Record the timings before anything below can return: an error path is
	// exactly where a caller most wants to know how long the run got and what
	// the log said.
	if o.Stats != nil {
		o.Stats.EngineSec = time.Since(runStart).Seconds()
		select {
		case t := <-widgetLoaded:
			o.Stats.LoadSec = t.Sub(runStart).Seconds()
			o.Stats.SimSec = o.Stats.EngineSec - o.Stats.LoadSec
		default: // the widget never announced itself; no split to report
		}
		o.Stats.GameSec = h.GameTime
		o.Stats.EngineVersion = h.EngineVersion
		o.Stats.Infolog = engine.SummarizeInfolog(eng.InfologPath())
	}

	var stats capture.Stats
	var consumeErr error
	if raw, oerr := os.Open(streamPath); oerr != nil {
		consumeErr = fmt.Errorf("open widget output %s: %w (did the widget load and run? see the GL caveat in CLAUDE.md)", streamPath, oerr)
	} else {
		consumeErr = capture.ConsumeStats(raw, base, w, &stats)
		raw.Close()
	}
	closeErr := w.Close()
	if o.Stats != nil {
		o.Stats.Frames, o.Stats.Samples = stats.LastFrame, stats.Frames
		if o.Stats.SimSec > 0 && stats.LastFrame > 0 {
			o.Stats.SpeedUp = float64(stats.LastFrame) / o.Stats.SimSec / gameSpeed
		}
	}
	// FIRST, ahead of every other explanation this function can give. We sent
	// that signal, so the two answers below are both true and both useless: the
	// stream stops mid-write, so it may well fail to parse, and the engine was
	// indeed "killed" — by us. What a person needs to read is that the machine
	// ran out of memory.
	if avail, rss, tripped := lowMem.reading(); tripped {
		return "", nil, fmt.Errorf("resim: stopped the engine with only %s of memory left on this host "+
			"(the engine had %s resident, and %d of ~%d sim frames were captured): "+
			"re-simulating this game needs more memory than this machine has. "+
			"Nothing was published; run it on a bigger host, or pass -min-free 0 to let the kernel's "+
			"OOM killer have it instead: %w",
			engine.FormatBytes(avail), engine.FormatBytes(rss),
			stats.Frames*o.sampleEvery(), int(h.GameTime)*gameSpeed, ErrOutOfMemory)
	}
	for _, e := range []error{consumeErr, closeErr} {
		if e != nil {
			return "", nil, e
		}
	}
	// The engine exits via quitforce, so a non-zero exit code is normal and not
	// on its own a failure. Being SIGNALLED is different: the run was cut short
	// (Ctrl-C, the OOM killer, a crash) and the stream stops mid-game. Callers
	// publish what this returns, so treating that as success silently replaces
	// a complete replay with a truncated stub — a killed 55-minute re-sim once
	// packed 347 of 100170 frames and went straight to uploading it.
	if waitErr != nil {
		if signalled(waitErr) {
			return "", nil, fmt.Errorf("resim: engine was killed after %d of ~%d frames (%v); "+
				"refusing to publish a truncated capture",
				stats.Frames*o.sampleEvery(), int(h.GameTime)*gameSpeed, waitErr)
		}
		fmt.Fprintf(os.Stderr, "resim: engine exited: %v\n", waitErr)
	}
	// A short capture with no signal still means something went wrong mid-run
	// (the engine gave up, the widget stopped) and must not masquerade as the
	// full game.
	if got, want := stats.Frames*o.sampleEvery(), int(h.GameTime)*gameSpeed; want > 0 && got < want*minCoveragePct/100 {
		return "", nil, fmt.Errorf("resim: capture covers only %d of ~%d sim frames (%d%%); "+
			"refusing to publish a truncated capture", got, want, 100*got/want)
	}
	// Keep the raw stream next to the output (best-effort; it lives in the
	// data dir because the widget can only write inside the write-dir).
	// OutDir is routinely a temp dir on another filesystem, where rename fails
	// with EXDEV — so fall back to a copy, otherwise every run leaks a
	// multi-hundred-MB stream into the data dir.
	if merr := moveFile(streamPath, filepath.Join(o.OutDir, h.GameID+".brsnap")); merr != nil {
		fmt.Fprintf(os.Stderr, "resim: warning: could not move raw stream: %v\n", merr)
	}
	fmt.Fprintf(os.Stderr, "resim: %s: %d frames, %d comms in %s -> %s\n",
		h.GameID, stats.Frames, stats.Comms, time.Since(runStart).Round(time.Second), outPath)
	if o.Stats != nil {
		// The desync count is the reason this line exists: a capture of a game
		// that never happened is indistinguishable from a good one on disk.
		fmt.Fprintf(os.Stderr, "resim: %s: infolog %s\n", h.GameID, o.Stats.Infolog)
	}

	// Sanity: the produced capture must be the requested game.
	if !strings.EqualFold(h.GameID, gameID) {
		fmt.Fprintf(os.Stderr, "resim: warning: demo gameId %s != requested %s\n", h.GameID, gameID)
	}
	return outPath, demo.Startscript.ModOptions, nil
}

const (
	// gameSpeed is the engine's fixed sim rate: 30 frames per game-second.
	gameSpeed = 30
	// minCoveragePct is how much of the demo a capture must span to count as
	// complete. Games end early (resign, mass quit) and the header's GameTime
	// is the recorded length rather than an exact frame count, so this is
	// deliberately loose — it exists to catch stubs, not to be precise.
	minCoveragePct = 80
)

// removeAbandonedStream drops the widget's raw stream when a run ended badly.
// Takes the error by pointer because it is deferred at the top of Run, long
// before there is an outcome to look at. A stream that was never written is not
// a problem, and one that will not delete is a warning: the run has already
// failed, and there is nothing better to report than what failed first.
func removeAbandonedStream(streamPath string, retErr *error) {
	if *retErr == nil {
		return // the success path moves it out to the capture directory
	}
	if err := os.Remove(streamPath); err != nil && !os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "resim: warning: could not remove the abandoned stream %s: %v\n",
			streamPath, err)
	}
}

// minFree resolves Options.MinFreeBytes: 0 takes the package default, negative
// disables the guard (engine.WatchMemory treats <= 0 as off).
func (o Options) minFree() int64 {
	if o.MinFreeBytes == 0 {
		return engine.DefaultMinFreeBytes
	}
	return o.MinFreeBytes
}

// sampleEvery is the widget's sampling interval in sim frames, mirroring the
// default engine.Config applies when Every is unset.
func (o Options) sampleEvery() int {
	if o.Every > 0 {
		return o.Every
	}
	return 30
}

// signalled reports whether the process died from a signal rather than exiting
// on its own. exec reports this as an ExitError whose status has Signaled set;
// the engine's normal quitforce path yields a plain non-zero code instead.
func signalled(err error) bool {
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		return false
	}
	ws, ok := ee.Sys().(syscall.WaitStatus)
	return ok && ws.Signaled()
}

// moveFile renames src to dst, falling back to copy+remove when they are on
// different filesystems (os.Rename returns EXDEV, which is the common case
// because OutDir is often a temp dir).
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	} else if !errors.Is(err, syscall.EXDEV) {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(dst)
		return err
	}
	in.Close()
	return os.Remove(src)
}
