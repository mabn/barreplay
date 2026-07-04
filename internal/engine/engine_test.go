package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mabn/barreplay/assets"
)

func TestBuildStartscript(t *testing.T) {
	dir := t.TempDir()
	e := &Engine{cfg: Config{DataDir: dir, SampleEvery: 30}}
	demo := filepath.Join(dir, "demos", "x.sdfz")
	sp, err := e.BuildStartscript(demo)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(sp)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if !strings.Contains(s, "demofile = "+demo+";") {
		t.Errorf("startscript missing demofile:\n%s", s)
	}
	if !strings.Contains(s, "MaxSpeed = 9999;") {
		t.Errorf("startscript missing speed modoption:\n%s", s)
	}
}

func TestWriteWidgetSubstitutesInterval(t *testing.T) {
	dir := t.TempDir()
	e := &Engine{cfg: Config{DataDir: dir, SampleEvery: 15}}
	p, err := e.WriteWidget()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(dir, "LuaUI", "Widgets", "snapshot_widget.lua"); p != want {
		t.Errorf("widget path = %q, want %q", p, want)
	}
	b, _ := os.ReadFile(p)
	s := string(b)
	if strings.Contains(s, "__SAMPLE_EVERY__") {
		t.Error("SampleEvery token not substituted")
	}
	if !strings.Contains(s, `tonumber("15")`) {
		t.Errorf("interval 15 not substituted; got fragment: %q", firstLineWith(s, "sampleEvery ="))
	}
}

func TestLocateFindsHeadlessInEngineDir(t *testing.T) {
	dir := t.TempDir()
	engDir := filepath.Join(dir, "engine", "2025.06.24")
	if err := os.MkdirAll(engDir, 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(engDir, headlessName())
	if err := os.WriteFile(bin, []byte("#!/bin/true\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	e, err := Locate(Config{DataDir: dir, SkipProvision: true}, "2025.06.24")
	if err != nil {
		t.Fatalf("Locate: %v", err)
	}
	if e.HeadlessPath() != bin {
		t.Errorf("HeadlessPath = %q, want %q", e.HeadlessPath(), bin)
	}
}

// TestWidgetHasRequiredCallins lints the embedded Lua statically (no luac in CI):
// it must define the callins the capture protocol depends on and stay read-only.
func TestWidgetHasRequiredCallins(t *testing.T) {
	src := assets.SnapshotWidgetLua
	for _, need := range []string{
		"function widget:GetInfo()",
		"function widget:Initialize()",
		"function widget:GameFrame(",
		"function widget:UnitCreated(",
		"function widget:UnitDestroyed(",
		"function widget:GameOver()",
		"BRSNAP F ",
		"BRSNAP U ",
		"BRSNAP EV ",
		"spectatorfullview 1",
		"quitforce",
	} {
		if !strings.Contains(src, need) {
			t.Errorf("widget missing required fragment %q", need)
		}
	}
	// Read-only guard: the widget must not issue unit orders (would desync).
	for _, forbidden := range []string{"GiveOrderToUnit", "Spring.SetUnit", "Spring.DestroyUnit", "Spring.CreateUnit"} {
		if strings.Contains(src, forbidden) {
			t.Errorf("widget must be read-only but calls %q", forbidden)
		}
	}
}

func firstLineWith(s, sub string) string {
	for _, ln := range strings.Split(s, "\n") {
		if strings.Contains(ln, sub) {
			return ln
		}
	}
	return ""
}
