package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/mabn/barreplay/internal/engine"
)

// GamePreview is what the window shows about a pasted game before and while
// it is re-simulated: the BAR API's own description of it.
type GamePreview struct {
	ID            string  `json:"id"`
	Map           string  `json:"map"`
	MapFile       string  `json:"mapFile"`
	Thumb         string  `json:"thumb"`
	StartTime     string  `json:"startTime"`
	DurationSec   float64 `json:"durationSec"`
	EngineVersion string  `json:"engineVersion"`
	GameVersion   string  `json:"gameVersion"`
	Preset        string  `json:"preset"`
	Size          string  `json:"size"`
	Players       int     `json:"players"`
	Spectators    int     `json:"spectators"`
	Sides         []Side  `json:"sides"`

	// Filled in by annotate, from this machine's point of view.
	EstimateSec  float64 `json:"estimateSec"`
	EstRAM       int64   `json:"estRam"`
	RAMWarning   string  `json:"ramWarning,omitempty"`
	NeedsEngine  bool    `json:"needsEngine"`
	PatchedReady bool    `json:"patchedReady"`
	Done         string  `json:"done,omitempty"` // path of a replay already made
}

// Side is one ally team.
type Side struct {
	Won     bool         `json:"won"`
	Players []SidePlayer `json:"players"`
}

// SidePlayer is one player (or AI) on a side.
type SidePlayer struct {
	Name    string `json:"name"`
	Color   string `json:"color"`
	Country string `json:"country,omitempty"`
	Faction string `json:"faction,omitempty"`
	Skill   string `json:"skill,omitempty"`
	Rank    int    `json:"rank"`
	AI      bool   `json:"ai,omitempty"`
}

type apiDetail struct {
	ID            string  `json:"id"`
	StartTime     string  `json:"startTime"`
	DurationMs    float64 `json:"durationMs"`
	EngineVersion string  `json:"engineVersion"`
	GameVersion   string  `json:"gameVersion"`
	Preset        string  `json:"preset"`
	Map           struct {
		ScriptName string `json:"scriptName"`
		FileName   string `json:"fileName"`
	} `json:"Map"`
	AllyTeams []struct {
		AllyTeamID  int  `json:"allyTeamId"`
		WinningTeam bool `json:"winningTeam"`
		Players     []struct {
			Name        string `json:"name"`
			TeamID      int    `json:"teamId"`
			Faction     string `json:"faction"`
			CountryCode string `json:"countryCode"`
			Skill       string `json:"skill"`
			Rank        int    `json:"rank"`
			RGB         struct {
				R, G, B int
			} `json:"rgbColor"`
		} `json:"Players"`
		AIs []struct {
			Name      string `json:"name"`
			ShortName string `json:"shortName"`
			Faction   string `json:"faction"`
			RGB       struct {
				R, G, B int
			} `json:"rgbColor"`
		} `json:"AIs"`
	} `json:"AllyTeams"`
	Spectators []json.RawMessage `json:"Spectators"`
}

func fetchPreview(ctx context.Context, id string) (*GamePreview, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.bar-rts.com/replays/"+url.PathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, errors.New("Could not reach api.bar-rts.com. Check your internet connection.")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, errors.New("BAR has no replay with that ID.")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("api.bar-rts.com answered %s", resp.Status)
	}
	var d apiDetail
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		return nil, err
	}
	p := &GamePreview{
		ID:            d.ID,
		Map:           d.Map.ScriptName,
		MapFile:       d.Map.FileName,
		StartTime:     d.StartTime,
		DurationSec:   d.DurationMs / 1000,
		EngineVersion: d.EngineVersion,
		GameVersion:   shortGameVersion(d.GameVersion),
		Preset:        d.Preset,
		Spectators:    len(d.Spectators),
	}
	if p.ID == "" {
		p.ID = id
	}
	if d.Map.FileName != "" {
		p.Thumb = "https://api.bar-rts.com/maps/" + url.PathEscape(d.Map.FileName) + "/texture-thumb.jpg"
	}
	var sizes []string
	for _, at := range d.AllyTeams {
		s := Side{Won: at.WinningTeam}
		for _, pl := range at.Players {
			s.Players = append(s.Players, SidePlayer{
				Name:    pl.Name,
				Color:   hexColor(pl.RGB.R, pl.RGB.G, pl.RGB.B),
				Country: pl.CountryCode,
				Faction: pl.Faction,
				Skill:   strings.Trim(pl.Skill, "[]"),
				Rank:    pl.Rank,
			})
		}
		for _, ai := range at.AIs {
			name := ai.Name
			if name == "" {
				name = ai.ShortName
			}
			s.Players = append(s.Players, SidePlayer{
				Name: name, AI: true, Faction: ai.Faction,
				Color: hexColor(ai.RGB.R, ai.RGB.G, ai.RGB.B),
			})
		}
		if len(s.Players) == 0 {
			continue
		}
		p.Players += len(s.Players)
		sizes = append(sizes, strconv.Itoa(len(s.Players)))
		p.Sides = append(p.Sides, s)
	}
	p.Size = strings.Join(sizes, "v")
	if len(sizes) >= 4 {
		p.Size = fmt.Sprintf("FFA (%d)", p.Players)
	}
	return p, nil
}

// annotate adds what depends on this machine: how long the run should take,
// how much memory it needs against how much there is, and whether an engine
// download comes first.
func (a *App) annotate(p *GamePreview) {
	c := a.config()
	p.EstimateSec = a.fc.Estimate(p.DurationSec).Seconds()
	engDir := filepath.Join(c.DataDir, "engine", p.EngineVersion)
	p.NeedsEngine = p.EngineVersion != "" && !fileExists(filepath.Join(engDir, stockExe()))
	p.PatchedReady = c.PatchedEngine && fileExists(filepath.Join(engDir, patchedExe()))
	p.EstRAM = estimateRAM(p.Players, p.DurationSec, c.PatchedEngine)
	if host, ok := engine.MemTotal(); ok && p.EstRAM > host-(1<<30) {
		p.RAMWarning = fmt.Sprintf("This game may need about %.1f GB of memory and this computer has %.1f GB. It might not finish.",
			float64(p.EstRAM)/(1<<30), float64(host)/(1<<30))
	}
	for _, h := range c.History {
		if h.GameID == p.ID && h.Error == "" && fileExists(h.Path) {
			p.Done = h.Path
			break
		}
	}
}

// estimateRAM is a rough peak for the engine, from the measured re-sims: a
// patched 8v8 peaks around 4.4 GB, a mid-size game 3.8, the stock engine
// ~1.5 GB more (patches/engine-2026.07.04/MEMORY.md). Long games hold more
// units at once, so length adds a little.
func estimateRAM(players int, gameSec float64, patched bool) int64 {
	gb := 2.6 + 0.11*float64(players) + 0.15*min(gameSec/1800, 2)
	if !patched {
		gb += 1.5
	}
	return int64(gb * (1 << 30))
}

func hexColor(r, g, b int) string {
	if r == 0 && g == 0 && b == 0 {
		return "#9aa4ad"
	}
	return fmt.Sprintf("#%02x%02x%02x", clamp8(r), clamp8(g), clamp8(b))
}

func clamp8(v int) int { return max(0, min(255, v)) }
