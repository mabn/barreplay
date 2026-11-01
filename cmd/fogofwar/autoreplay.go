package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Auto-replay: while it is on and the app is idle, take the site's newest
// games (its Games list, latest-ended first), and re-simulate the first one
// that has no replay yet and that nobody is working on — neither the site's
// own pipeline (a job pending or processing) nor this app before (any game in
// the history, failed ones included, so a game that cannot be re-simulated is
// not tried again forever). Modded games are skipped (Marcin's call), and so
// is a game whose settings the site does not know, since it may be one. When
// none of them qualifies it looks again a minute later.

const (
	autoListSize   = 10
	autoRecheck    = time.Minute
	autoFailPause  = 10 * time.Minute
	autoMaxFailRun = 3 // failures in a row before pausing
)

// siteGame is the part of an /api/games row the pick needs.
type siteGame struct {
	ID        string  `json:"id"`
	Published bool    `json:"published"`
	JobState  *string `json:"jobState"`
	// Settings are the site's settings flags (viz.SettingsFlags); nil when
	// the BAR API gave none.
	Settings map[string]any `json:"settings"`
}

// modded is true when a game ran tweaked unit tables (the "mods" flag) or
// its settings are unknown.
func (g siteGame) modded() bool {
	if g.Settings == nil {
		return true
	}
	v, ok := g.Settings["mods"]
	return ok && v != false
}

// fetchSiteGames reads the first page of the site's games list.
func fetchSiteGames(ctx context.Context, n int) ([]siteGame, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/api/games?limit=%d", siteURL(), n), nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, siteRefusal(resp, "games list")
	}
	var out struct {
		Games []siteGame `json:"games"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&out); err != nil {
		return nil, err
	}
	return out.Games, nil
}

// pickAutoGame is the first game that wants a replay: not modded, not
// published, no job in flight on the site, never tried here.
func pickAutoGame(games []siteGame, tried map[string]bool) string {
	for _, g := range games {
		if g.ID == "" || g.Published || tried[g.ID] || g.modded() {
			continue
		}
		if g.JobState != nil && (*g.JobState == "pending" || *g.JobState == "processing") {
			continue
		}
		return g.ID
	}
	return ""
}

// SetAutoReplay turns auto-replay on or off. Turning it on looks for a game
// at once.
func (a *App) SetAutoReplay(on bool) State {
	a.updateConfig(func(c *Config) { c.AutoReplay = on })
	a.mu.Lock()
	a.autoNext, a.autoFails = time.Time{}, 0
	if on {
		a.autoNote = "Looking for a game…"
	} else {
		a.autoNote = ""
	}
	a.dirty = true
	a.mu.Unlock()
	if on {
		a.logf("Auto-replay on")
		a.pokeAuto()
	} else {
		a.logf("Auto-replay off")
	}
	return a.snapshot()
}

// pokeAuto makes the loop look now rather than at its next tick.
func (a *App) pokeAuto() {
	select {
	case a.autoPoke <- struct{}{}:
	default:
	}
}

func (a *App) autoLoop() {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-t.C:
		case <-a.autoPoke:
		}
		a.autoStep()
	}
}

func (a *App) autoStep() {
	a.mu.Lock()
	idle := a.cfg.AutoReplay && a.mode == modeReady && !a.quitting && !time.Now().Before(a.autoNext)
	tried := make(map[string]bool, len(a.cfg.History))
	for _, h := range a.cfg.History {
		tried[h.GameID] = true
	}
	a.mu.Unlock()
	if !idle {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	games, err := fetchSiteGames(ctx, autoListSize)
	cancel()
	id := ""
	if err == nil {
		id = pickAutoGame(games, tried)
	}
	var se *siteError
	a.mu.Lock()
	newMsg := false
	if errors.As(err, &se) {
		newMsg = a.siteMsg == nil || *a.siteMsg != *se
		a.siteMsg = se
	} else if err == nil {
		a.siteMsg = nil
	}
	a.mu.Unlock()
	if newMsg {
		a.logf("auto-replay: the site says (%d): %s", se.Status, se.Message)
	}
	if id == "" {
		a.mu.Lock()
		a.autoNext = time.Now().Add(autoRecheck)
		if se != nil {
			a.autoNote = "Paused by replay.fogofwar.dev (see the message above); asking again at " + a.autoNext.Format("15:04")
		} else if err != nil {
			a.autoNote = "Couldn't reach the games list; trying again at " + a.autoNext.Format("15:04")
		} else {
			a.autoNote = fmt.Sprintf("All of the %d newest games are modded, have a replay or are being worked on; looking again at %s", autoListSize, a.autoNext.Format("15:04"))
		}
		a.dirty = true
		a.mu.Unlock()
		if err != nil && se == nil {
			a.logf("auto-replay: %v", err)
		}
		return
	}
	a.logf("Auto-replay picked %s", id)
	if err := a.startResim(id, true); err != nil {
		a.mu.Lock()
		a.autoNext = time.Now().Add(autoRecheck)
		a.mu.Unlock()
		return
	}
	a.mu.Lock()
	a.autoNote = "Replaying the newest unmodded game without a replay"
	a.dirty = true
	a.mu.Unlock()
}

// autoFinished is told how an auto-picked run ended; a run of failures (a
// broken install, a full disk) pauses the loop instead of marking every game
// on the list as failed.
func (a *App) autoFinished(ok, stopped bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch {
	case stopped:
		// Cancel turned auto-replay off already; quitting leaves it as is.
	case ok:
		a.autoFails = 0
		a.autoNext = time.Time{}
	default:
		a.autoFails++
		if a.autoFails >= autoMaxFailRun {
			a.autoNext = time.Now().Add(autoFailPause)
			a.autoNote = fmt.Sprintf("%d games failed in a row; pausing until %s", a.autoFails, a.autoNext.Format("15:04"))
			a.autoFails = 0
		}
	}
	a.dirty = true
}
