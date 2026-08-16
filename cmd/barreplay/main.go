// Command barreplay downloads a Beyond All Reason replay, re-runs it headlessly
// in the Recoil engine, and records periodic game-state snapshots.
//
// Usage:
//
//	barreplay [flags] <replay-link | gameId | path.sdfz>
//
// Examples:
//
//	barreplay -data ~/.local/share/Beyond-All-Reason/data -out ./snaps \
//	    https://www.beyondallreason.info/replays?gameId=836d486a5480a9e830be54db7d2c7be9
//	barreplay -data <BARdata> -out ./snaps ./demos/mygame.sdfz   # local file, no download
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/capture"
	"github.com/mabn/barreplay/internal/demofile"
	"github.com/mabn/barreplay/internal/engine"
	"github.com/mabn/barreplay/snapshot"
)

// workerThreadsUnset is the -worker-threads default meaning "don't override the
// engine's WorkerThreadCount" (any value >= -1 is a real engine setting).
const workerThreadsUnset = -2

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "barreplay: "+err.Error())
		os.Exit(1)
	}
}

func run() error {
	var (
		dataDir      = flag.String("data", envOr("BAR_DATA_DIR", ""), "BAR/Spring data directory (engine/, games/, maps/); also used as --write-dir")
		outDir       = flag.String("out", "./snapshots", "output directory for snapshot files")
		every        = flag.Int("every", 30, "snapshot sampling interval in sim frames (30 = 1s)")
		engineBin    = flag.String("engine", "", "path to spring-headless (overrides auto-location)")
		prdBin       = flag.String("pr-downloader", "", "path to pr-downloader (overrides auto-location)")
		skipProv     = flag.Bool("no-provision", false, "do not download engine/game/map; assume already installed")
		forceProv    = flag.Bool("force-provision", false, "re-run pr-downloader even for content already provisioned into -data")
		gameOverride = flag.String("game", "", "pr-downloader game identifier override (rapid tag / springname)")
		mapOverride  = flag.String("map", "", "pr-downloader map identifier override")
		rapidRepo    = flag.String("rapid-repo", "", "pr-downloader rapid master repo URL (default: BAR's repo)")
		noRun        = flag.Bool("no-run", false, "download + parse only; do not launch the engine")
		progress     = flag.Bool("progress", true, "poll infolog.txt every 2s and print replay progress (time, %, ETA, fps); =false for a silent run")
		profile      = flag.Bool("profile", false, "enable the engine's internal time profiler for a fine-grained Sim breakdown and a unit-count growth table (small overhead)")
		disWidgets   = flag.Bool("disable-widgets", true, "disable BAR's default widget suite during the replay (pure unsynced overhead; cannot affect the sim); =false to keep it")
		throttleDraw = flag.Bool("throttle-draw", true, "throttle the headless draw loop to ~1 fps via MinDrawFPS/MinSimDrawBalance; =false for engine defaults")
		workerThr    = flag.Int("worker-threads", workerThreadsUnset, "override the engine's WorkerThreadCount for this run (-1 = auto, 0/1 = no workers; scheduling only, cannot desync); unset = keep user/engine default")
	)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: barreplay [flags] <replay-link | gameId | path.sdfz>\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() != 1 {
		flag.Usage()
		return fmt.Errorf("expected exactly one replay argument")
	}
	target := flag.Arg(0)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// 1. Obtain the .sdfz: local file, or resolve+download from the BAR API.
	var demoPath string
	if isLocalSDFZ(target) {
		demoPath = target
	} else {
		client := barapi.New()
		r, err := client.Resolve(ctx, target)
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "resolved %s: %s (engine %s, %s)\n", r.ID, r.FileName, r.EngineVersion, r.GameVersion)
		if *dataDir == "" {
			return fmt.Errorf("-data is required (need a place to store the demo and run the engine)")
		}
		p, err := client.Download(ctx, r, filepath.Join(*dataDir, "demos"))
		if err != nil {
			return err
		}
		demoPath = p
		fmt.Fprintf(os.Stderr, "downloaded %s\n", p)
	}

	// 2. Parse the demo header + startscript (source of truth for versions/map).
	f, err := os.Open(demoPath)
	if err != nil {
		return err
	}
	demo, err := demofile.Parse(f)
	f.Close()
	if err != nil {
		return err
	}
	h := demo.Header
	fmt.Fprintf(os.Stderr, "demo: gameId=%s engine=%s map=%q game=%q gameTime=%ds\n",
		h.GameID, h.EngineVersion, demo.Startscript.MapName, demo.Startscript.GameType, h.GameTime)

	base := demofile.BaseMeta(demo)
	base.SampleEvery = int32(*every)

	if *noRun {
		fmt.Fprintln(os.Stderr, "-no-run set; skipping engine launch")
		return nil
	}
	if *dataDir == "" {
		return fmt.Errorf("-data is required to run the engine")
	}

	// The widget writes its BRSNAP stream to a file. Spring's LuaIO sandbox rejects
	// absolute paths, so the widget uses a RELATIVE path resolved against the engine's
	// write-dir (= dataDir); we read it back from there, then move it next to the
	// snapshot output. Forward slashes keep the Lua path portable.
	relStream := "barreplay/" + h.GameID + ".brsnap"
	streamPath := filepath.Join(*dataDir, "barreplay", h.GameID+".brsnap")
	if err := os.MkdirAll(filepath.Dir(streamPath), 0o755); err != nil {
		return err
	}

	// 3. Locate the engine and provision missing content.
	engCfg := engine.Config{
		DataDir:            *dataDir,
		EngineBinary:       *engineBin,
		PRDownloaderBinary: *prdBin,
		SampleEvery:        *every,
		SkipProvision:      *skipProv,
		ForceProvision:     *forceProv,
		GameOverride:       *gameOverride,
		MapOverride:        *mapOverride,
		RapidRepoMaster:    *rapidRepo,
		SnapshotStreamPath: relStream,
		Profile:            *profile,
		DisableWidgets:     *disWidgets,
		ThrottleDraw:       *throttleDraw,
	}
	if *workerThr != workerThreadsUnset {
		engCfg.WorkerThreads = workerThr
	}
	// Runs share mutable state inside the data dir, so only one at a time.
	unlock, err := engine.LockDataDir(*dataDir)
	if err != nil {
		return err
	}
	defer func() {
		if uerr := unlock(); uerr != nil {
			fmt.Fprintf(os.Stderr, "barreplay: warning: releasing data-dir lock: %v\n", uerr)
		}
	}()

	// Before Locate, which now refuses a build that does not match the demo.
	if err := engine.EnsureEngine(ctx, engCfg, h.EngineVersion); err != nil {
		return err
	}
	eng, err := engine.Locate(engCfg, h.EngineVersion)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "engine: %s\n", eng.HeadlessPath())
	if err := eng.EnsureContent(ctx, demo.Startscript.GameType, demo.Startscript.MapName); err != nil {
		return err
	}

	// 4. Inject the snapshot widget and build the playback startscript.
	widgetPath, err := eng.WriteWidget()
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "widget: %s (every %d frames)\n", widgetPath, *every)

	// Engine config (user's springsettings.cfg + our overrides, e.g. the draw
	// throttle), passed to the engine via --config so the real config is untouched.
	engineCfg, err := eng.WriteEngineConfig()
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "engine config: %s (draw throttle: %v, default widgets disabled: %v)\n",
		engineCfg, *throttleDraw, *disWidgets)

	// BAR won't auto-run a fresh user widget in a replay; seed its widget-config
	// order list to enable ours, restoring the user's original config afterward.
	restoreCfg, err := eng.EnableWidget()
	if err != nil {
		return err
	}
	defer func() {
		if rerr := restoreCfg(); rerr != nil {
			fmt.Fprintf(os.Stderr, "warning: could not restore widget config: %v\n", rerr)
		}
	}()

	scriptPath, err := eng.BuildStartscript(demoPath)
	if err != nil {
		return err
	}

	// 5. Open the snapshot writer (the snapshot package owns the on-disk format).
	w, err := snapshot.NewBRPWriter(*outDir, h.GameID)
	if err != nil {
		return err
	}
	outPath := filepath.Join(*outDir, h.GameID+".brp")

	// 6. Launch the engine. The widget writes snapshots to rawPath directly; the
	// engine's stdout only needs draining so its pipe never blocks the sim (the
	// heartbeat and engine logs also go to infolog.txt, which -progress reads).
	// While draining, watch for the widget's first "[barreplay]" line: the widget
	// initializes exactly when loading ends, so its timestamp splits the engine
	// wall time into a load phase and a sim phase.
	fmt.Fprintln(os.Stderr, "launching headless replay...")
	runStart := time.Now()
	stdout, wait, err := eng.Run(ctx, scriptPath)
	if err != nil {
		w.Close()
		return err
	}
	widgetLoaded := make(chan time.Time, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			if strings.Contains(sc.Text(), "[barreplay]") {
				widgetLoaded <- time.Now()
				break
			}
		}
		io.Copy(io.Discard, stdout) // keep draining (also covers a scanner error)
	}()
	if *progress {
		pctx, pcancel := context.WithCancel(ctx)
		defer pcancel()
		go engine.WatchProgress(pctx, eng.InfologPath(), int(h.GameTime), 2*time.Second, os.Stderr)
	}
	waitErr := wait()
	engineDuration := time.Since(runStart)
	var loadDuration time.Duration // 0 = widget never announced itself
	select {
	case t := <-widgetLoaded:
		loadDuration = t.Sub(runStart)
	default:
	}

	// 7. Parse the widget's stream file into the snapshot writer.
	var stats capture.Stats
	var consumeErr error
	if raw, oerr := os.Open(streamPath); oerr != nil {
		consumeErr = fmt.Errorf("open widget output %s: %w (did the widget load and run?)", streamPath, oerr)
	} else {
		consumeErr = capture.ConsumeStats(raw, base, w, &stats)
		raw.Close()
	}
	closeErr := w.Close()

	// Move the raw stream next to the snapshot output (best-effort); it lives in the
	// data dir because the widget could only write inside the write-dir.
	rawPath := filepath.Join(*outDir, h.GameID+".brsnap")
	if consumeErr == nil {
		if merr := moveFile(streamPath, rawPath); merr != nil {
			fmt.Fprintf(os.Stderr, "warning: could not move %s -> %s: %v\n", streamPath, rawPath, merr)
			rawPath = streamPath
		}
	}

	for _, e := range []error{consumeErr, closeErr} {
		if e != nil {
			return e
		}
	}
	// The engine exits via quitforce; a non-zero code there is not fatal to us.
	if waitErr != nil {
		fmt.Fprintf(os.Stderr, "engine exited: %v\n", waitErr)
	}

	fmt.Fprintf(os.Stderr, "done: wrote %s\n", outPath)
	printRunTiming(os.Stderr, engineDuration, loadDuration, &stats)
	if mb, ok := fileSizeMB(eng.InfologPath()); ok {
		fmt.Fprintf(os.Stderr, "  infolog.txt: %.2f MB\n", mb)
	}
	if mb, ok := fileSizeMB(rawPath); ok {
		fmt.Fprintf(os.Stderr, "  widget stream: %.2f MB (%s)\n", mb, rawPath)
	}
	if mb, ok := fileSizeMB(outPath); ok {
		fmt.Fprintf(os.Stderr, "  snapshot: %.2f MB\n", mb)
	}
	return nil
}

// moveFile renames src to dst, falling back to copy+remove across filesystems.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
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
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Remove(src)
}

// printRunTiming breaks the engine wall time into a load phase (launch until the
// widget's first "[barreplay]" stdout line: VFS scan, map load, icon atlas, ...)
// and a sim phase (everything after), and prints the engine's own time-profiler
// totals when the widget dumped them at game over. Profiler scopes nest (e.g.
// "Sim::Path" time is also inside "Sim"), so percentages overlap and don't sum
// to 100.
func printRunTiming(out io.Writer, engineDuration, loadDuration time.Duration, stats *capture.Stats) {
	if loadDuration <= 0 {
		fmt.Fprintf(out, "  engine run took %s (widget never announced itself; no load/sim split)\n",
			engineDuration.Round(time.Millisecond))
	} else {
		sim := engineDuration - loadDuration
		fmt.Fprintf(out, "  engine total %s = load %s + sim %s",
			engineDuration.Round(time.Second), loadDuration.Round(time.Second), sim.Round(time.Second))
		if stats.LastFrame > 0 && sim > 0 {
			fps := float64(stats.LastFrame) / sim.Seconds()
			fmt.Fprintf(out, " (%d frames, %.0f fps, %.1fx realtime)", stats.LastFrame, fps, fps/30)
		}
		fmt.Fprintln(out)
	}
	if len(stats.Profile) > 0 {
		fmt.Fprintf(out, "  engine profiler totals (scopes nest, so entries overlap):\n")
		for _, p := range stats.Profile {
			fmt.Fprintf(out, "    %9.0f ms  %3.0f%%  %s\n",
				p.Ms, 100*p.Ms/(float64(engineDuration)/float64(time.Millisecond)), p.Name)
		}
	}
	printProfileGrowth(out, stats.ProfileSamples)
}

// printProfileGrowth reports, per profiler scope, the sim cost in ms per frame
// over the first vs the last third of the game (from the widget's per-heartbeat
// PROFD samples, -profile mode only). Scopes whose per-frame cost grows are the
// ones that get expensive as the unit count rises.
func printProfileGrowth(out io.Writer, samples []capture.ProfileSample) {
	if len(samples) == 0 {
		return
	}
	minF, maxF := samples[0].Frame, samples[0].Frame
	for _, s := range samples {
		minF = min(minF, s.Frame)
		maxF = max(maxF, s.Frame)
	}
	span := maxF - minF
	if span < 3 {
		return // too short to split into meaningful windows
	}
	earlyEnd := minF + span/3
	lateStart := maxF - span/3

	// The samples are cumulative totals, so a window's ms/frame rate is
	// (last - first cumulative ms) / (last - first frame) within that window.
	type window struct {
		firstMs, lastMs float64
		firstF, lastF   int32
		n               int
	}
	type scopeAgg struct {
		name        string
		early, late window
	}
	aggs := map[string]*scopeAgg{}
	for _, s := range samples {
		a := aggs[s.Name]
		if a == nil {
			a = &scopeAgg{name: s.Name}
			aggs[s.Name] = a
		}
		var w *window
		switch {
		case s.Frame <= earlyEnd:
			w = &a.early
		case s.Frame >= lateStart:
			w = &a.late
		default:
			continue
		}
		if w.n == 0 {
			w.firstMs, w.firstF = s.Ms, s.Frame
		}
		w.lastMs, w.lastF = s.Ms, s.Frame
		w.n++
	}
	rate := func(w window) (float64, bool) {
		if w.n < 2 || w.lastF <= w.firstF {
			return 0, false
		}
		return (w.lastMs - w.firstMs) / float64(w.lastF-w.firstF), true
	}

	type row struct {
		name        string
		early, late float64
		hasEarly    bool
	}
	var rows []row
	for _, a := range aggs {
		lateRate, ok := rate(a.late)
		if !ok || lateRate < 0.01 { // < 0.01 ms/frame is noise
			continue
		}
		earlyRate, hasEarly := rate(a.early)
		rows = append(rows, row{name: a.name, early: earlyRate, late: lateRate, hasEarly: hasEarly})
	}
	if len(rows) == 0 {
		return
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].late > rows[j].late })
	if len(rows) > 12 {
		rows = rows[:12]
	}

	fmt.Fprintf(out, "  profiler growth, first vs last third of the sim (units %d -> %d):\n",
		samples[0].Units, samples[len(samples)-1].Units)
	fmt.Fprintf(out, "    %8s %8s %7s  %s\n", "early", "late", "growth", "scope (ms per sim frame)")
	for _, r := range rows {
		growth := "     -"
		if r.hasEarly && r.early > 0 {
			growth = fmt.Sprintf("%5.1fx", r.late/r.early)
		}
		early := "       -"
		if r.hasEarly {
			early = fmt.Sprintf("%8.3f", r.early)
		}
		fmt.Fprintf(out, "    %s %8.3f %s  %s\n", early, r.late, growth, r.name)
	}
}

// fileSizeMB returns the size of path in megabytes; ok is false if it can't stat.
func fileSizeMB(path string) (mb float64, ok bool) {
	fi, err := os.Stat(path)
	if err != nil {
		return 0, false
	}
	return float64(fi.Size()) / (1024 * 1024), true
}

func isLocalSDFZ(s string) bool {
	if !strings.HasSuffix(strings.ToLower(s), ".sdfz") {
		return false
	}
	fi, err := os.Stat(s)
	return err == nil && !fi.IsDir()
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
