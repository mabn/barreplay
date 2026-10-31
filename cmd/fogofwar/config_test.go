package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestConfigSplitsInTwo(t *testing.T) {
	root, data := t.TempDir(), t.TempDir()
	c := defaultConfig(root)
	c.DataDir = data
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
	if len(keys) != 2 || keys["dataDir"] != data {
		t.Errorf("config.json holds more than the folders: %s", b)
	}
	if !fileExists(filepath.Join(data, "fogofwar", "settings.json")) {
		t.Fatal("no settings.json in the data folder")
	}
	got, legacy, err := loadConfig(root)
	if err != nil || legacy {
		t.Fatalf("load: %v legacy=%v", err, legacy)
	}
	if got.InstallID != "id-1" || got.Runs != 3 || len(got.History) != 1 || got.DataDir != data {
		t.Errorf("round trip lost something: %+v", got)
	}
}

func TestLegacyConfigLoadsWhole(t *testing.T) {
	root, data := t.TempDir(), t.TempDir()
	old := `{"dataDir":` + jsonStr(data) + `,"outputDir":"o","patchedEngine":false,"minFreeMB":1024,"installId":"id-2","history":[{"gameId":"x"}]}`
	os.WriteFile(filepath.Join(root, "config.json"), []byte(old), 0o644)
	c, legacy, err := loadConfig(root)
	if err != nil || !legacy {
		t.Fatalf("load: %v legacy=%v", err, legacy)
	}
	if c.InstallID != "id-2" || c.MinFreeMB != 1024 || c.PatchedEngine || len(c.History) != 1 || c.DiskLimitGB != 10 {
		t.Errorf("legacy fields: %+v", c)
	}
	if err := saveConfig(root, c); err != nil {
		t.Fatal(err)
	}
	c2, legacy, _ := loadConfig(root)
	if legacy || c2.InstallID != "id-2" || c2.MinFreeMB != 1024 {
		t.Errorf("after the split: legacy=%v %+v", legacy, c2)
	}
}

func TestFirstLaunchDefaults(t *testing.T) {
	root := t.TempDir()
	c, legacy, err := loadConfig(root)
	if err != nil || legacy || !c.PatchedEngine || c.MinFreeMB != 512 || c.DataDir != filepath.Join(root, "data") {
		t.Errorf("defaults: %+v legacy=%v err=%v", c, legacy, err)
	}
}

func TestMoveAppFiles(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "data", "fogofwar")
	os.MkdirAll(home, 0o755)
	os.WriteFile(filepath.Join(root, "fogofwar.log"), []byte("old log"), 0o644)
	os.MkdirAll(filepath.Join(root, "webview", "x"), 0o755)
	os.MkdirAll(filepath.Join(root, "work"), 0o755)
	os.WriteFile(filepath.Join(root, "session.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(home, "session.json"), []byte("newer"), 0o644)

	moveAppFiles(root, home)
	if b, _ := os.ReadFile(filepath.Join(home, "fogofwar.log")); string(b) != "old log" {
		t.Errorf("log not moved: %q", b)
	}
	if !exists(filepath.Join(home, "webview", "x")) || exists(filepath.Join(root, "webview")) {
		t.Error("webview not moved")
	}
	if exists(filepath.Join(root, "work")) {
		t.Error("work folder kept")
	}
	if b, _ := os.ReadFile(filepath.Join(home, "session.json")); string(b) != "newer" {
		t.Error("an existing file was overwritten")
	}
}

func jsonStr(s string) string { b, _ := json.Marshal(s); return string(b) }

func exists(p string) bool { _, err := os.Stat(p); return err == nil }
