package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestConfigRoundTrip(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	var c Config
	c.Stored = defaultStored()
	c.setHome(home)
	c.InstallID, c.Runs = "id-1", 3
	c.History = []HistoryItem{{GameID: "abc"}}
	if err := saveConfig(root, c); err != nil {
		t.Fatal(err)
	}
	var keys map[string]any
	b, _ := os.ReadFile(filepath.Join(root, "config.json"))
	if err := json.Unmarshal(b, &keys); err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || keys["home"] != home {
		t.Errorf("config.json holds more than the folder: %s", b)
	}
	if !fileExists(filepath.Join(home, "settings.json")) {
		t.Fatal("no settings.json in the FogOfWar folder")
	}
	got, old, _, err := loadConfig(root, t.TempDir())
	if err != nil || old != nil {
		t.Fatalf("load: %v old=%v", err, old)
	}
	if got.InstallID != "id-1" || got.Runs != 3 || len(got.History) != 1 || got.Home != home ||
		got.DataDir != filepath.Join(home, "data") || got.OutputDir != filepath.Join(home, "replays") {
		t.Errorf("round trip lost something: %+v", got)
	}
}

func TestFirstLaunchDefaults(t *testing.T) {
	root, def := t.TempDir(), t.TempDir()
	c, old, _, err := loadConfig(root, def)
	if err != nil || old != nil || !c.PatchedEngine || c.MinFreeMB != 512 || c.Home != def || c.DataDir != filepath.Join(def, "data") {
		t.Errorf("defaults: %+v old=%v err=%v", c, old, err)
	}
}

// A 0.2.19 install: config.json names the two folders, the settings and the
// app's files are in <data>\fogofwar. Everything ends up in the new folder.
func TestOldLayoutMovesIntoOneFolder(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	data, out := filepath.Join(root, "data"), filepath.Join(root, "replays")
	app := filepath.Join(data, "fogofwar")
	os.MkdirAll(filepath.Join(data, "engine", "v"), 0o755)
	os.MkdirAll(filepath.Join(app, "webview", "x"), 0o755)
	os.MkdirAll(filepath.Join(app, "work"), 0o755)
	os.MkdirAll(out, 0o755)
	os.WriteFile(filepath.Join(out, "g1.brp"), []byte("brp"), 0o644)
	os.WriteFile(filepath.Join(app, "fogofwar.log"), []byte("log"), 0o644)
	os.WriteFile(filepath.Join(app, "session.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(app, "settings.json"), []byte(`{"minFreeMB":1024,"installId":"id-3","history":[{"gameId":"g1","path":`+jsonStr(filepath.Join(out, "g1.brp"))+`}]}`), 0o644)
	os.WriteFile(filepath.Join(root, "config.json"), []byte(`{"dataDir":`+jsonStr(data)+`,"outputDir":`+jsonStr(out)+`}`), 0o644)

	c, old, _, err := loadConfig(root, home)
	if err != nil || old == nil {
		t.Fatalf("load: %v old=%v", err, old)
	}
	if c.InstallID != "id-3" || c.MinFreeMB != 1024 || c.Home != home {
		t.Fatalf("settings: %+v", c)
	}
	notes, dataMoved := relocate(home, *old, c.History)
	if !dataMoved {
		t.Fatalf("data not moved: %v", notes)
	}
	if err := saveConfig(root, c); err != nil {
		t.Fatal(err)
	}
	tidyOldAppDir(filepath.Join(home, "data", "fogofwar"), true)

	for _, p := range []string{"settings.json", "session.json", "fogofwar.log", "webview/x", "data/engine/v", "replays/g1.brp"} {
		if !exists(filepath.Join(home, p)) {
			t.Errorf("%s missing from the FogOfWar folder", p)
		}
	}
	if exists(filepath.Join(home, "data", "fogofwar")) || exists(data) || exists(out) {
		t.Error("something left behind")
	}
	if c.History[0].Path != filepath.Join(home, "replays", "g1.brp") {
		t.Errorf("history path: %s", c.History[0].Path)
	}
	ents, _ := os.ReadDir(root)
	if len(ents) != 1 || ents[0].Name() != "config.json" {
		t.Errorf("root holds more than config.json: %v", ents)
	}
	c2, old2, _, _ := loadConfig(root, t.TempDir())
	if old2 != nil || c2.Home != home || c2.InstallID != "id-3" {
		t.Errorf("after the move: %+v", c2)
	}
}

// Before 0.2.19 config.json held the settings too, and the app's files were
// beside it.
func TestPre019ConfigLoadsWhole(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(root, "config.json"), []byte(`{"dataDir":"","outputDir":"","patchedEngine":false,"minFreeMB":1024,"installId":"id-2"}`), 0o644)
	os.WriteFile(filepath.Join(root, "fogofwar.log"), []byte("log"), 0o644)
	c, old, _, err := loadConfig(root, home)
	if err != nil || old == nil || c.InstallID != "id-2" || c.PatchedEngine || c.DiskLimitGB != 10 {
		t.Fatalf("load: %+v old=%v err=%v", c, old, err)
	}
	relocate(home, *old, nil)
	if !exists(filepath.Join(home, "fogofwar.log")) {
		t.Error("log not moved")
	}
}

// Replays already in the new folder are kept; the rest join them.
func TestReplaysMergeIntoExistingFolder(t *testing.T) {
	src, home := t.TempDir(), t.TempDir()
	os.MkdirAll(filepath.Join(home, "replays"), 0o755)
	os.WriteFile(filepath.Join(home, "replays", "a.brp"), []byte("new"), 0o644)
	os.WriteFile(filepath.Join(src, "a.brp"), []byte("old"), 0o644)
	os.WriteFile(filepath.Join(src, "b.brp"), []byte("b"), 0o644)
	relocate(home, layout{data: filepath.Join(src, "nodata"), replays: src}, nil)
	if b, _ := os.ReadFile(filepath.Join(home, "replays", "a.brp")); string(b) != "new" {
		t.Error("an existing replay was overwritten")
	}
	if !exists(filepath.Join(home, "replays", "b.brp")) {
		t.Error("b.brp not moved")
	}
}

func TestWithin(t *testing.T) {
	for _, c := range []struct {
		p, d string
		want bool
	}{{"/a/b", "/a", true}, {"/a", "/a", true}, {"/ab", "/a", false}, {"/a", "/a/b", false}} {
		if got := within(c.p, c.d); got != c.want {
			t.Errorf("within(%s, %s) = %v", c.p, c.d, got)
		}
	}
}

func jsonStr(s string) string { b, _ := json.Marshal(s); return string(b) }
