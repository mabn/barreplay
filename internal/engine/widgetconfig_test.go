package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mabn/barreplay/assets"
)

func configPath(dir string) string {
	return filepath.Join(dir, "LuaUI", "Config", barGameShortName+".lua")
}

// The seeded config must name the exact GetInfo().name from the Lua asset, or
// BAR's order-list lookup misses and the widget stays disabled.
func TestWidgetNameMatchesAsset(t *testing.T) {
	want := `name    = "` + widgetName + `"`
	if !strings.Contains(assets.SnapshotWidgetLua, want) {
		t.Errorf("widget asset does not declare %q as its GetInfo name", widgetName)
	}
	if !strings.Contains(widgetConfigLua(widgetName), `["`+widgetName+`"] = 1`) {
		t.Errorf("config does not enable %q", widgetName)
	}
}

func TestEnableWidgetPreservesExistingConfig(t *testing.T) {
	dir := t.TempDir()
	cfg := configPath(dir)
	if err := os.MkdirAll(filepath.Dir(cfg), 0o755); err != nil {
		t.Fatal(err)
	}
	const original = "-- the user's real widget layout\nreturn { order = { [\"Some Other Widget\"] = 7 } }\n"
	if err := os.WriteFile(cfg, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	e := &Engine{cfg: Config{DataDir: dir}}
	restore, err := e.EnableWidget()
	if err != nil {
		t.Fatalf("EnableWidget: %v", err)
	}

	// While active, the config enables our widget.
	got, _ := os.ReadFile(cfg)
	if !strings.Contains(string(got), `["`+widgetName+`"] = 1`) {
		t.Errorf("active config does not enable the widget:\n%s", got)
	}

	if err := restore(); err != nil {
		t.Fatalf("restore: %v", err)
	}
	// The user's original config is restored byte-for-byte and the backup removed.
	got, _ = os.ReadFile(cfg)
	if string(got) != original {
		t.Errorf("config not restored; got:\n%s", got)
	}
	if _, err := os.Stat(cfg + ".barreplay-bak"); !os.IsNotExist(err) {
		t.Errorf("backup file not cleaned up")
	}
}

func TestEnableWidgetRemovesConfigWhenNoneExisted(t *testing.T) {
	dir := t.TempDir()
	cfg := configPath(dir)

	e := &Engine{cfg: Config{DataDir: dir}}
	restore, err := e.EnableWidget()
	if err != nil {
		t.Fatalf("EnableWidget: %v", err)
	}
	if _, err := os.Stat(cfg); err != nil {
		t.Fatalf("config not written: %v", err)
	}
	if err := restore(); err != nil {
		t.Fatalf("restore: %v", err)
	}
	// No prior config existed, so restore removes ours entirely.
	if _, err := os.Stat(cfg); !os.IsNotExist(err) {
		t.Errorf("config should be removed when none existed originally")
	}
}

// A leftover backup from an interrupted run is treated as the real config and
// restored on the next EnableWidget call.
func TestEnableWidgetSelfHealsStaleBackup(t *testing.T) {
	dir := t.TempDir()
	cfg := configPath(dir)
	if err := os.MkdirAll(filepath.Dir(cfg), 0o755); err != nil {
		t.Fatal(err)
	}
	const real = "-- real user config recovered from a crashed run\n"
	if err := os.WriteFile(cfg+".barreplay-bak", []byte(real), 0o644); err != nil {
		t.Fatal(err)
	}
	// A clobbered config left behind by the crash.
	if err := os.WriteFile(cfg, []byte("-- stale barreplay config\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	e := &Engine{cfg: Config{DataDir: dir}}
	restore, err := e.EnableWidget()
	if err != nil {
		t.Fatalf("EnableWidget: %v", err)
	}
	if err := restore(); err != nil {
		t.Fatalf("restore: %v", err)
	}
	got, _ := os.ReadFile(cfg)
	if string(got) != real {
		t.Errorf("stale backup not restored as the real config; got:\n%s", got)
	}
}
