package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Config is FogOfWar's configuration file, config.json in the app's folder
// (%LOCALAPPDATA%\FogOfWar on Windows). Everything the app downloads lives
// under DataDir and every replay it makes under OutputDir; both default to
// folders beside the config, so the app needs no admin rights and leaves
// nothing anywhere else.
type Config struct {
	// DataDir holds the engine, the BAR game content, maps and demos. It is
	// also the engine's write dir.
	DataDir string `json:"dataDir"`
	// OutputDir is where finished .brp files go.
	OutputDir string `json:"outputDir"`
	// PatchedEngine prefers the faster patched engine when one is published
	// for the replay's engine version. Its output is byte-identical.
	PatchedEngine bool `json:"patchedEngine"`
	// MinFreeMB stops a run before Windows runs out of memory.
	MinFreeMB int `json:"minFreeMB"`
	// Setup records the first-run download, so it runs once.
	Setup SetupRecord `json:"setup"`
	// History is the replays made so far, newest first.
	History []HistoryItem `json:"history"`
}

// SetupRecord is what the first-run download installed.
type SetupRecord struct {
	EngineVersion string    `json:"engineVersion,omitempty"`
	GameVersion   string    `json:"gameVersion,omitempty"`
	DoneAt        time.Time `json:"doneAt,omitempty"`
}

// HistoryItem is one finished (or failed) re-simulation.
type HistoryItem struct {
	GameID     string    `json:"gameId"`
	Map        string    `json:"map,omitempty"`
	MapFile    string    `json:"mapFile,omitempty"`
	Size       string    `json:"size,omitempty"`
	Path       string    `json:"path,omitempty"`
	Bytes      int64     `json:"bytes,omitempty"`
	TookSec    float64   `json:"tookSec,omitempty"`
	GameSec    float64   `json:"gameSec,omitempty"`
	SpeedUp    float64   `json:"speedUp,omitempty"`
	Patched    bool      `json:"patched,omitempty"`
	Error      string    `json:"error,omitempty"`
	FinishedAt time.Time `json:"finishedAt"`
}

const maxHistory = 50

// appRoot is the app's own folder. os.UserCacheDir is %LOCALAPPDATA% on
// Windows: per user, never roamed, writable without admin rights.
func appRoot() (string, error) {
	if d := os.Getenv("FOGOFWAR_HOME"); d != "" {
		return d, nil
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "FogOfWar"), nil
}

func defaultConfig(root string) Config {
	return Config{
		DataDir:       filepath.Join(root, "data"),
		OutputDir:     filepath.Join(root, "replays"),
		PatchedEngine: true,
		MinFreeMB:     512,
	}
}

// loadConfig reads root/config.json, filling in defaults for anything it
// leaves out. A missing file is a first launch, not an error.
func loadConfig(root string) (Config, error) {
	c := defaultConfig(root)
	b, err := os.ReadFile(filepath.Join(root, "config.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return defaultConfig(root), err
	}
	d := defaultConfig(root)
	if c.DataDir == "" {
		c.DataDir = d.DataDir
	}
	if c.OutputDir == "" {
		c.OutputDir = d.OutputDir
	}
	if c.MinFreeMB <= 0 {
		c.MinFreeMB = d.MinFreeMB
	}
	return c, nil
}

// saveConfig writes the file through a temp file and a rename, so a crash
// mid-write never leaves a truncated config behind.
func saveConfig(root string, c Config) error {
	if len(c.History) > maxHistory {
		c.History = c.History[:maxHistory]
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(root, ".config-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(root, "config.json"))
}
