package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Config is FogOfWar's configuration, kept in two files so that the app's
// own folder (%LOCALAPPDATA%\FogOfWar on Windows) holds nothing but where the
// rest lives:
//
//   - <app folder>\config.json: Locations, the two folders and nothing else.
//   - <DataDir>\fogofwar\settings.json: Stored, every other setting, the
//     install's id and the history. The same folder (appDir) holds the log,
//     session.json, the work folder and the window's WebView2 data.
//
// Both folders default to folders beside config.json, so the app needs no
// admin rights and leaves nothing anywhere else.
type Config struct {
	Locations
	Stored
}

// Locations is config.json.
type Locations struct {
	// DataDir holds the engine, the BAR game content, maps and demos (it is
	// also the engine's write dir) and, in appDir, the app's own files.
	DataDir string `json:"dataDir"`
	// OutputDir is where finished .brp files go.
	OutputDir string `json:"outputDir"`
}

// Stored is settings.json in appDir(DataDir).
type Stored struct {
	// PatchedEngine prefers the faster patched engine when one is published
	// for the replay's engine version. Its output is byte-identical.
	PatchedEngine bool `json:"patchedEngine"`
	// MinFreeMB stops a run before Windows runs out of memory.
	MinFreeMB int `json:"minFreeMB"`
	// DiskLimitGB bounds DataDir: before each run the least recently used
	// game builds, maps, demos and engines go until it fits.
	DiskLimitGB int `json:"diskLimitGB"`
	// AutoReplay re-simulates the site's newest unreplayed games one after
	// another while the app is idle.
	AutoReplay bool `json:"autoReplay"`
	// InstallID names this install of the app (a UUIDv7 made on first
	// launch). Every job the app reports and every replay it uploads carries
	// it, so the site can find all of one PC's work.
	InstallID string `json:"installId,omitempty"`
	// Runs counts the re-simulations this install has started.
	Runs int `json:"runs,omitempty"`
	// Setup records the first-run download, so it runs once.
	Setup SetupRecord `json:"setup"`
	// History is the replays made so far, newest first.
	History []HistoryItem `json:"history"`
}

// appDir is where the app keeps its own files inside the data folder. The
// disk-limit pruning only ever looks in the engine's own subfolders, so it
// never touches this one.
func appDir(dataDir string) string { return filepath.Join(dataDir, "fogofwar") }

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
	LobbyName  string    `json:"lobbyName,omitempty"`
	Tags       []Tag     `json:"tags,omitempty"`
	Path       string    `json:"path,omitempty"`
	Bytes      int64     `json:"bytes,omitempty"`
	TookSec    float64   `json:"tookSec,omitempty"`
	GameSec    float64   `json:"gameSec,omitempty"`
	SpeedUp    float64   `json:"speedUp,omitempty"`
	Patched    bool      `json:"patched,omitempty"`
	Error      string    `json:"error,omitempty"`
	FinishedAt time.Time `json:"finishedAt"`
	// Upload is how far sending it to the replay site got: queued,
	// published or failed; empty when it was never sent (a failed run).
	Upload      string `json:"upload,omitempty"`
	UploadJob   string `json:"uploadJob,omitempty"`
	UploadError string `json:"uploadError,omitempty"`
	// Auto marks a game the auto-replay picked rather than one pasted.
	Auto bool `json:"auto,omitempty"`
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
		Locations: Locations{
			DataDir:   filepath.Join(root, "data"),
			OutputDir: filepath.Join(root, "replays"),
		},
		Stored: Stored{PatchedEngine: true, MinFreeMB: 512, DiskLimitGB: 10},
	}
}

// loadConfig reads root/config.json and then settings.json from the data
// folder it names, filling in defaults for anything they leave out. A missing
// file is a first launch, not an error.
//
// Before 0.2.19 config.json held everything. Such a file still loads whole;
// legacy says so, and the caller's next saveConfig splits it in two.
func loadConfig(root string) (c Config, legacy bool, err error) {
	c = defaultConfig(root)
	b, err := os.ReadFile(filepath.Join(root, "config.json"))
	switch {
	case errors.Is(err, fs.ErrNotExist):
		err = nil
	case err != nil:
		return c, false, err
	default:
		var keys map[string]json.RawMessage
		if err := json.Unmarshal(b, &keys); err != nil {
			return defaultConfig(root), false, err
		}
		if err := json.Unmarshal(b, &c); err != nil {
			return defaultConfig(root), false, err
		}
		delete(keys, "dataDir")
		delete(keys, "outputDir")
		legacy = len(keys) > 0
	}
	d := defaultConfig(root)
	if c.DataDir == "" {
		c.DataDir = d.DataDir
	}
	if c.OutputDir == "" {
		c.OutputDir = d.OutputDir
	}
	b, serr := os.ReadFile(filepath.Join(appDir(c.DataDir), "settings.json"))
	switch {
	case serr == nil:
		// The data folder's own settings win over a legacy config.json's: they
		// are the newer ones.
		st := d.Stored
		if jerr := json.Unmarshal(b, &st); jerr != nil {
			err = jerr
		} else {
			c.Stored = st
		}
	case !errors.Is(serr, fs.ErrNotExist):
		err = serr
	}
	if c.MinFreeMB <= 0 {
		c.MinFreeMB = d.MinFreeMB
	}
	if c.DiskLimitGB <= 0 {
		c.DiskLimitGB = d.DiskLimitGB
	}
	return c, legacy, err
}

// saveConfig writes config.json and settings.json, each through a temp file
// and a rename, so a crash mid-write never leaves a truncated file behind.
func saveConfig(root string, c Config) error {
	if len(c.History) > maxHistory {
		c.History = c.History[:maxHistory]
	}
	if err := writeJSON(root, "config.json", c.Locations); err != nil {
		return err
	}
	return writeJSON(appDir(c.DataDir), "settings.json", c.Stored)
}

func writeJSON(dir, name string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+name+"-*")
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
	return os.Rename(tmp.Name(), filepath.Join(dir, name))
}

// moveAppFiles carries what earlier versions kept beside config.json into
// the data folder's appDir: the log, session.json and the window's WebView2
// data. A file already there is left alone (the older one stays where it
// was), the work folder is only ever an intermediate and is deleted. The
// returned lines say what happened, for the log, which cannot be written yet.
func moveAppFiles(root, home string) []string {
	var notes []string
	for _, name := range []string{"fogofwar.log", "session.json", "webview"} {
		src, dst := filepath.Join(root, name), filepath.Join(home, name)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		if _, err := os.Stat(dst); err == nil {
			continue
		}
		if err := os.Rename(src, dst); err != nil {
			notes = append(notes, fmt.Sprintf("could not move %s to %s: %v", src, home, err))
		} else {
			notes = append(notes, fmt.Sprintf("moved %s to %s", name, home))
		}
	}
	os.RemoveAll(filepath.Join(root, "work"))
	return notes
}
