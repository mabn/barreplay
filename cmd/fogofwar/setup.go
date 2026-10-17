package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/engine"
)

// The first-run download: everything a re-simulation of a game played today
// needs, fetched once so the first game a person pastes starts at once. A game
// on an older engine or game build still works later — resim.Run downloads
// whatever a replay pins — this only makes the common case instant.
//
// Steps are a fixed list so the window can draw them all before any of them
// starts; each moves pending -> active -> done | skipped | failed.

const (
	stepVersion = iota
	stepEngine
	stepPatched
	stepGame
)

func newSetupSteps() []Step {
	return []Step{
		{Key: "version", Label: "Find the current BAR version"},
		{Key: "engine", Label: "Download the Recoil engine"},
		{Key: "patched", Label: "Download the faster engine build"},
		{Key: "game", Label: "Download Beyond All Reason"},
	}
}

// latestGame asks the BAR API for the newest finished game. Its engine and
// game builds are the ones the next pasted game most likely needs.
func latestGame(ctx context.Context, client *barapi.Client) (*barapi.Replay, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://api.bar-rts.com/replays?page=1&limit=1&hasBots=false&endedNormally=true", nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("api.bar-rts.com: %s", resp.Status)
	}
	var page struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
		return nil, err
	}
	if len(page.Data) == 0 {
		return nil, errors.New("api.bar-rts.com lists no games")
	}
	return client.Resolve(ctx, page.Data[0].ID)
}

// runSetup does the first-run download. It holds the data dir's lock, so a
// re-simulation cannot start underneath it.
func (a *App) runSetup(ctx context.Context) (err error) {
	cfg := a.config()
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return err
	}
	release, err := engine.LockDataDir(cfg.DataDir)
	if err != nil {
		return err
	}
	defer release()

	ecfg := engine.Config{DataDir: cfg.DataDir, PatchedEngine: cfg.PatchedEngine}

	a.stepStart(stepVersion, "")
	r, err := latestGame(ctx, a.client)
	if err != nil {
		a.stepFail(stepVersion, err)
		return err
	}
	a.stepDone(stepVersion, fmt.Sprintf("Engine %s · %s", r.EngineVersion, shortGameVersion(r.GameVersion)))

	a.stepStart(stepEngine, "engine "+r.EngineVersion)
	a.watchDownloads(stepEngine)
	if err := engine.EnsureEngine(ctx, ecfg, r.EngineVersion); err != nil {
		a.stepFail(stepEngine, err)
		return err
	}
	a.stepDone(stepEngine, "Recoil "+r.EngineVersion)

	a.stepStart(stepPatched, "")
	a.watchDownloads(stepPatched)
	if !cfg.PatchedEngine {
		a.stepSkip(stepPatched, "Turned off in settings")
	} else if err := engine.EnsurePatchedEngine(ctx, ecfg, r.EngineVersion); err != nil {
		// Never fatal: the stock engine makes the same replay, slower.
		a.logf("setup: patched engine: %v", err)
		a.stepSkip(stepPatched, "Not available; the standard engine will be used")
	} else if fileExists(filepath.Join(cfg.DataDir, "engine", r.EngineVersion, patchedExe())) {
		a.stepDone(stepPatched, "About 25% faster, 1.5 GB less memory")
	} else {
		a.stepSkip(stepPatched, "Not published for this engine yet; the standard engine will be used")
	}

	a.stepStart(stepGame, shortGameVersion(r.GameVersion))
	a.watchDownloads(stepGame)
	eng, err := engine.Locate(ecfg, r.EngineVersion)
	if err != nil {
		a.stepFail(stepGame, err)
		return err
	}
	if err := eng.EnsureContent(ctx, r.GameVersion, ""); err != nil {
		a.stepFail(stepGame, err)
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	a.stepDone(stepGame, shortGameVersion(r.GameVersion))

	a.updateConfig(func(c *Config) {
		c.Setup = SetupRecord{EngineVersion: r.EngineVersion, GameVersion: r.GameVersion, DoneAt: time.Now()}
	})
	return nil
}

// setupNeeded reports whether the first-run download has to (re)run: it
// never finished, or what it installed has since been deleted.
func setupNeeded(c Config) bool {
	if c.Setup.DoneAt.IsZero() || c.Setup.EngineVersion == "" {
		return true
	}
	return !fileExists(filepath.Join(c.DataDir, "engine", c.Setup.EngineVersion, stockExe()))
}

// shortGameVersion drops the "Beyond All Reason " prefix every build carries.
func shortGameVersion(v string) string {
	const p = "Beyond All Reason "
	if len(v) > len(p) && v[:len(p)] == p {
		return v[len(p):]
	}
	return v
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
