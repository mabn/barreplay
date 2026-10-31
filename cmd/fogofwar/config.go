package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Config is FogOfWar's configuration. Everything the app keeps lives in ONE
// folder, the FogOfWar folder (Home), by default the one FogOfWar.exe is in:
//
//	<Home>\settings.json   Stored: the settings, the install's id, the history
//	<Home>\session.json    how the last run of the app ended (session.go)
//	<Home>\fogofwar.log
//	<Home>\webview\        the window's WebView2 data
//	<Home>\work\           a run's scratch files
//	<Home>\data\           engine, game, maps, demos (the engine's write dir)
//	<Home>\replays\        the finished .brp files
//
// The only thing kept anywhere else is the pointer to it, config.json in
// %LOCALAPPDATA%\FogOfWar ({"home": ...}): the folder is a setting, so where
// it is has to be written down outside it. No admin rights needed either way.
type Config struct {
	// Home is the FogOfWar folder; DataDir and OutputDir are its data and
	// replays subfolders, set together with it by setHome.
	Home      string
	DataDir   string
	OutputDir string
	Stored
}

func (c *Config) setHome(home string) {
	c.Home = filepath.Clean(home)
	c.DataDir = filepath.Join(c.Home, "data")
	c.OutputDir = filepath.Join(c.Home, "replays")
}

// pointer is config.json.
type pointer struct {
	Home string `json:"home"`
	// Previous is the folder the app moved out of while it ran. What could not
	// move then (the window's WebView2 data, held open) is deleted at the next
	// start.
	Previous string `json:"previous,omitempty"`
}

// Stored is settings.json in the FogOfWar folder.
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

// appRoot is where config.json, the pointer to the FogOfWar folder, lives.
// os.UserCacheDir is %LOCALAPPDATA% on Windows: per user, never roamed,
// writable without admin rights. FOGOFWAR_HOME overrides it.
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

// defaultHome is the FogOfWar folder of a first launch: the folder
// FogOfWar.exe is in, when the app may write there, else root. Not a temp
// folder: an exe started from inside a zip in Explorer runs out of one that
// Windows empties.
func defaultHome(root string) string {
	exe, err := os.Executable()
	if err != nil {
		return root
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	dir := filepath.Dir(exe)
	if tmp := os.TempDir(); tmp != "" && within(dir, tmp) {
		return root
	}
	if !writable(dir) {
		return root
	}
	return dir
}

// within reports whether path is dir or inside it.
func within(path, dir string) bool {
	rel, err := filepath.Rel(filepath.Clean(dir), filepath.Clean(path))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".fogofwar-*")
	if err != nil {
		return false
	}
	f.Close()
	os.Remove(f.Name())
	return true
}

func defaultStored() Stored {
	return Stored{PatchedEngine: true, MinFreeMB: 512, DiskLimitGB: 10}
}

// layout is where an earlier version kept things, for relocate.
type layout struct {
	data, replays string
	// appDirs hold the log, session.json and webview.
	appDirs []string
}

// loadConfig reads root/config.json and the settings.json of the folder it
// names, filling in defaults for anything they leave out. A missing
// config.json is a first launch (home is defHome), not an error.
//
// Up to 0.2.19 config.json named a data and a replays folder instead (and
// before 0.2.19 held every setting too, which 0.2.19 moved to
// <data>\fogofwar\settings.json). Such a config still loads, its settings
// from wherever they were, with home = defHome; old says where everything
// was, for relocate, and is nil otherwise.
func loadConfig(root, defHome string) (c Config, old *layout, prev string, err error) {
	c.Stored = defaultStored()
	c.setHome(defHome)
	b, err := os.ReadFile(filepath.Join(root, "config.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil, "", nil
	}
	if err != nil {
		return c, nil, "", err
	}
	var p struct {
		pointer
		DataDir   string `json:"dataDir"`
		OutputDir string `json:"outputDir"`
	}
	if err := json.Unmarshal(b, &p); err != nil {
		return c, nil, "", err
	}
	if p.Home != "" {
		c.setHome(p.Home)
		err = readStored(filepath.Join(c.Home, "settings.json"), &c.Stored)
		return c, nil, p.Previous, err
	}
	// The old layout.
	if p.DataDir == "" {
		p.DataDir = filepath.Join(root, "data")
	}
	if p.OutputDir == "" {
		p.OutputDir = filepath.Join(root, "replays")
	}
	old = &layout{data: p.DataDir, replays: p.OutputDir, appDirs: []string{filepath.Join(p.DataDir, "fogofwar"), root}}
	// Before 0.2.19 the settings were in config.json itself; 0.2.19's own
	// settings.json, when there is one, is newer.
	if jerr := json.Unmarshal(b, &c.Stored); jerr != nil {
		err = jerr
	}
	if serr := readStored(filepath.Join(p.DataDir, "fogofwar", "settings.json"), &c.Stored); serr != nil {
		err = serr
	}
	fixStored(&c.Stored)
	return c, old, "", err
}

func readStored(path string, st *Stored) error {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	s := defaultStored()
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	fixStored(&s)
	*st = s
	return nil
}

func fixStored(s *Stored) {
	d := defaultStored()
	if s.MinFreeMB <= 0 {
		s.MinFreeMB = d.MinFreeMB
	}
	if s.DiskLimitGB <= 0 {
		s.DiskLimitGB = d.DiskLimitGB
	}
}

// saveConfig writes config.json and settings.json, each through a temp file
// and a rename, so a crash mid-write never leaves a truncated file behind.
func saveConfig(root string, c Config) error {
	return savePointer(root, c, "")
}

func savePointer(root string, c Config, previous string) error {
	if len(c.History) > maxHistory {
		c.History = c.History[:maxHistory]
	}
	if err := writeJSON(c.Home, "settings.json", c.Stored); err != nil {
		return err
	}
	return writeJSON(root, "config.json", pointer{Home: c.Home, Previous: previous})
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

// relocate moves what lived in old into the FogOfWar folder home: the log,
// session.json and webview from old.appDirs, the data folder to home\data and
// the replays to home\replays, rewriting the history's paths to match. Every
// move is a rename, so the gigabytes in the data folder move for free on one
// drive; across drives the data stays where it was (dataMoved false: the
// engine and game download again) while the replays, at most a few dozen
// files, are copied. Nothing already in home is overwritten. The returned
// lines say what happened, for the log.
func relocate(home string, old layout, history []HistoryItem) (notes []string, dataMoved bool) {
	note := func(f string, a ...any) { notes = append(notes, fmt.Sprintf(f, a...)) }
	if err := os.MkdirAll(home, 0o755); err != nil {
		note("could not create %s: %v", home, err)
		return notes, false
	}
	for _, name := range []string{"fogofwar.log", "session.json", "webview"} {
		dst := filepath.Join(home, name)
		for _, dir := range old.appDirs {
			src := filepath.Join(dir, name)
			if samePath(src, dst) || !exists(src) || exists(dst) {
				continue
			}
			if err := os.Rename(src, dst); err != nil {
				note("could not move %s to %s: %v", src, home, err)
			}
		}
	}
	data := filepath.Join(home, "data")
	switch {
	case samePath(old.data, data):
		dataMoved = true
	case !exists(old.data):
	case exists(data):
		note("%s already exists; %s was left where it is", data, old.data)
	default:
		if err := os.Rename(old.data, data); err != nil {
			note("the data folder %s was not moved (%v); the engine and game download again into %s", old.data, err, data)
		} else {
			note("moved %s to %s", old.data, data)
			dataMoved = true
		}
	}
	replays := filepath.Join(home, "replays")
	if !samePath(old.replays, replays) && exists(old.replays) {
		if !exists(replays) && os.Rename(old.replays, replays) == nil {
			note("moved %s to %s", old.replays, replays)
		} else {
			n := moveReplayFiles(old.replays, replays)
			note("moved %d replays from %s to %s", n, old.replays, replays)
			os.Remove(old.replays) // only when empty
		}
		for i, h := range history {
			if h.Path != "" && samePath(filepath.Dir(h.Path), old.replays) {
				if p := filepath.Join(replays, filepath.Base(h.Path)); exists(p) {
					history[i].Path = p
				}
			}
		}
	}
	return notes, dataMoved
}

// moveReplayFiles moves dir's .brp files into dst, renaming where it can and
// copying where it cannot (another drive). A name already in dst is skipped.
func moveReplayFiles(dir, dst string) int {
	ents, err := os.ReadDir(dir)
	if err != nil || os.MkdirAll(dst, 0o755) != nil {
		return 0
	}
	n := 0
	for _, e := range ents {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".brp") {
			continue
		}
		src, to := filepath.Join(dir, e.Name()), filepath.Join(dst, e.Name())
		if exists(to) {
			continue
		}
		if os.Rename(src, to) == nil || (copyFile(src, to) == nil && os.Remove(src) == nil) {
			n++
		}
	}
	return n
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".part"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

// tidyOldAppDir deletes what an earlier layout's app folder still holds once
// its contents have moved: the stale settings.json, a session record, the
// work folder and (at a start, when nothing holds it) the WebView2 data;
// then the folder itself if that left it empty. A log that could not move
// stays.
func tidyOldAppDir(dir string, webview bool) {
	for _, name := range []string{"settings.json", "session.json", "work"} {
		os.RemoveAll(filepath.Join(dir, name))
	}
	if webview {
		os.RemoveAll(filepath.Join(dir, "webview"))
	}
	os.Remove(dir)
}

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
