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
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
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
		gameOverride = flag.String("game", "", "pr-downloader game identifier override (rapid tag / springname)")
		mapOverride  = flag.String("map", "", "pr-downloader map identifier override")
		rapidRepo    = flag.String("rapid-repo", "", "pr-downloader rapid master repo URL (default: BAR's repo)")
		noRun        = flag.Bool("no-run", false, "download + parse only; do not launch the engine")
		progress     = flag.Bool("progress", false, "poll infolog.txt every 2s and print replay progress (time, %, ETA, fps)")
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

	base := snapshot.Meta{
		GameID:        h.GameID,
		EngineVersion: h.EngineVersion,
		GameVersion:   demo.Startscript.GameType,
		MapName:       demo.Startscript.MapName,
		StartUnix:     int64(h.UnixTime),
		SampleEvery:   int32(*every),
		UnitDefs:      map[int32]string{},
	}

	if *noRun {
		fmt.Fprintln(os.Stderr, "-no-run set; skipping engine launch")
		return nil
	}
	if *dataDir == "" {
		return fmt.Errorf("-data is required to run the engine")
	}

	// 3. Locate the engine and provision missing content.
	eng, err := engine.Locate(engine.Config{
		DataDir:            *dataDir,
		EngineBinary:       *engineBin,
		PRDownloaderBinary: *prdBin,
		SampleEvery:        *every,
		SkipProvision:      *skipProv,
		GameOverride:       *gameOverride,
		MapOverride:        *mapOverride,
		RapidRepoMaster:    *rapidRepo,
	}, h.EngineVersion)
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

	// 5. Open the snapshot writer (this package owns the on-disk format).
	w, err := snapshot.NewJSONLWriter(*outDir, h.GameID)
	if err != nil {
		return err
	}

	// 6. Launch the engine and stream state into the writer.
	fmt.Fprintln(os.Stderr, "launching headless replay...")
	stdout, wait, err := eng.Run(ctx, scriptPath)
	if err != nil {
		w.Close()
		return err
	}
	if *progress {
		pctx, pcancel := context.WithCancel(ctx)
		defer pcancel()
		go engine.WatchProgress(pctx, eng.InfologPath(), int(h.GameTime), 2*time.Second, os.Stderr)
	}
	consumeErr := capture.Consume(stdout, base, w)
	waitErr := wait()
	closeErr := w.Close()

	for _, e := range []error{consumeErr, closeErr} {
		if e != nil {
			return e
		}
	}
	// The engine exits via quitforce; a non-zero code there is not fatal to us.
	if waitErr != nil {
		fmt.Fprintf(os.Stderr, "engine exited: %v\n", waitErr)
	}
	fmt.Fprintf(os.Stderr, "done: wrote %s\n", filepath.Join(*outDir, h.GameID+".jsonl"))
	return nil
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
