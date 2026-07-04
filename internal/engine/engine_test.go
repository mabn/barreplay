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
	streamPath := "barreplay/game.brsnap" // relative: Spring's LuaIO forbids absolute paths
	e := &Engine{cfg: Config{DataDir: dir, SampleEvery: 15, SnapshotStreamPath: streamPath}}
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
	if strings.Contains(s, "__OUTPUT_PATH__") {
		t.Error("output path token not substituted")
	}
	if !strings.Contains(s, `local outputPath = "`+streamPath+`"`) {
		t.Errorf("output path not substituted; got fragment: %q", firstLineWith(s, "outputPath ="))
	}
	if strings.Contains(s, "__PROFILE__") {
		t.Error("profile token not substituted")
	}
	if !strings.Contains(s, `local profileMode = ("0" == "1")`) {
		t.Errorf("profile off not substituted; got fragment: %q", firstLineWith(s, "profileMode ="))
	}
	if strings.Contains(s, "__DISABLE_WIDGETS__") {
		t.Error("disable-widgets token not substituted")
	}
	if !strings.Contains(s, `local disableWidgets = ("0" == "1")`) {
		t.Errorf("disable-widgets off not substituted; got fragment: %q", firstLineWith(s, "disableWidgets ="))
	}
}

func TestWriteWidgetSubstitutesProfileOn(t *testing.T) {
	dir := t.TempDir()
	e := &Engine{cfg: Config{DataDir: dir, SampleEvery: 30, SnapshotStreamPath: "barreplay/g.brsnap", Profile: true, DisableWidgets: true}}
	p, err := e.WriteWidget()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), `local profileMode = ("1" == "1")`) {
		t.Errorf("profile on not substituted; got fragment: %q", firstLineWith(string(b), "profileMode ="))
	}
	if !strings.Contains(string(b), `local disableWidgets = ("1" == "1")`) {
		t.Errorf("disable-widgets on not substituted; got fragment: %q", firstLineWith(string(b), "disableWidgets ="))
	}
}

func TestMergeSpringSettings(t *testing.T) {
	over := map[string]string{"MinDrawFPS": "1", "MinSimDrawBalance": "0.001"}

	// No existing config: overrides only, sorted.
	got := string(mergeSpringSettings(nil, over))
	if want := "MinDrawFPS = 1\nMinSimDrawBalance = 0.001\n"; got != want {
		t.Errorf("empty existing: got %q, want %q", got, want)
	}

	// Existing keys are replaced in place (case-insensitive), others preserved.
	existing := []byte("WorkerThreadCount = 8\nmindrawfps = 30\nVSync = 0\n")
	got = string(mergeSpringSettings(existing, over))
	if want := "WorkerThreadCount = 8\nMinDrawFPS = 1\nVSync = 0\nMinSimDrawBalance = 0.001\n"; got != want {
		t.Errorf("merge: got %q, want %q", got, want)
	}

	// No overrides: pass-through.
	got = string(mergeSpringSettings(existing, nil))
	if got != string(existing) {
		t.Errorf("passthrough: got %q, want %q", got, existing)
	}
}

func TestWriteEngineConfig(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "springsettings.cfg"), []byte("VSync = 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	e := &Engine{cfg: Config{DataDir: dir, ThrottleDraw: true}}
	p, err := e.WriteEngineConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(p) {
		t.Errorf("config path should be absolute (engine cwd differs): %q", p)
	}
	b, _ := os.ReadFile(p)
	s := string(b)
	for _, want := range []string{"VSync = 0", "MinDrawFPS = 1", "MinSimDrawBalance = 0.001"} {
		if !strings.Contains(s, want) {
			t.Errorf("config missing %q:\n%s", want, s)
		}
	}
	if e.engineCfgPath != p {
		t.Error("engineCfgPath not recorded for Run's --config")
	}

	// Throttle off: user's settings pass through, no overrides injected. The
	// zero-value Config must also not inject WorkerThreadCount (nil pointer).
	e2 := &Engine{cfg: Config{DataDir: dir}}
	p2, err := e2.WriteEngineConfig()
	if err != nil {
		t.Fatal(err)
	}
	b2, _ := os.ReadFile(p2)
	if strings.Contains(string(b2), "MinDrawFPS") {
		t.Errorf("throttle off should not inject MinDrawFPS:\n%s", b2)
	}
	if strings.Contains(string(b2), "WorkerThreadCount") {
		t.Errorf("unset WorkerThreads should not inject WorkerThreadCount:\n%s", b2)
	}

	// -worker-threads set: WorkerThreadCount is injected (0 is a real value).
	wt := 0
	e3 := &Engine{cfg: Config{DataDir: dir, WorkerThreads: &wt}}
	p3, err := e3.WriteEngineConfig()
	if err != nil {
		t.Fatal(err)
	}
	b3, _ := os.ReadFile(p3)
	if !strings.Contains(string(b3), "WorkerThreadCount = 0") {
		t.Errorf("WorkerThreads=0 not injected:\n%s", b3)
	}
}

func TestLuaEscapeString(t *testing.T) {
	got := luaEscapeString(`C:\bar\a"b`)
	if want := `C:\\bar\\a\"b`; got != want {
		t.Errorf("luaEscapeString = %q, want %q", got, want)
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
		"sample_time=",
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

func envValue(env []string, key string) (string, bool) {
	p := key + "="
	// last occurrence wins, matching exec's behavior
	val, ok := "", false
	for _, kv := range env {
		if strings.HasPrefix(kv, p) {
			val, ok = kv[len(p):], true
		}
	}
	return val, ok
}

func TestPRDEnvInjectsBARRepo(t *testing.T) {
	// Default: no user setting -> BAR's repo is injected.
	t.Setenv("PRD_RAPID_REPO_MASTER", "")
	os.Unsetenv("PRD_RAPID_REPO_MASTER")
	os.Unsetenv("PRD_HTTP_SEARCH_URL")
	os.Unsetenv("PRD_RAPID_USE_STREAMER")
	e := &Engine{cfg: Config{DataDir: "/x"}}
	if v, ok := envValue(e.prdEnv(), "PRD_RAPID_REPO_MASTER"); !ok || v != barRapidRepoMaster {
		t.Errorf("default PRD_RAPID_REPO_MASTER = %q (ok=%v), want %q", v, ok, barRapidRepoMaster)
	}
	if v, ok := envValue(e.prdEnv(), "PRD_HTTP_SEARCH_URL"); !ok || v != barMapSearchURL {
		t.Errorf("default PRD_HTTP_SEARCH_URL = %q (ok=%v), want %q", v, ok, barMapSearchURL)
	}
	if v, ok := envValue(e.prdEnv(), "PRD_RAPID_USE_STREAMER"); !ok || v != "false" {
		t.Errorf("default PRD_RAPID_USE_STREAMER = %q (ok=%v), want %q", v, ok, "false")
	}

	// A user-set streamer preference wins over the default.
	t.Setenv("PRD_RAPID_USE_STREAMER", "true")
	if v, _ := envValue(e.prdEnv(), "PRD_RAPID_USE_STREAMER"); v != "true" {
		t.Errorf("user PRD_RAPID_USE_STREAMER should win, got %q", v)
	}

	// Config override wins over the default.
	e2 := &Engine{cfg: Config{DataDir: "/x", RapidRepoMaster: "https://example.test/repos.gz"}}
	if v, _ := envValue(e2.prdEnv(), "PRD_RAPID_REPO_MASTER"); v != "https://example.test/repos.gz" {
		t.Errorf("config override PRD_RAPID_REPO_MASTER = %q", v)
	}

	// A user-set environment variable wins over everything.
	t.Setenv("PRD_RAPID_REPO_MASTER", "https://user.test/repos.gz")
	if v, _ := envValue(e2.prdEnv(), "PRD_RAPID_REPO_MASTER"); v != "https://user.test/repos.gz" {
		t.Errorf("user env should win, got %q", v)
	}
}

func TestMatchRapidLine(t *testing.T) {
	// Real line from repos.beyondallreason.dev/byar/versions.gz.
	const line = "byar:git:1efcf40595187087532936c707f2b38227848a55,47a24f460845204ee5f426f4d21ae16f,,Beyond All Reason test-30541-1efcf40"
	tag, ok := matchRapidLine(line, "Beyond All Reason test-30541-1efcf40")
	if !ok || tag != "byar:git:1efcf40595187087532936c707f2b38227848a55" {
		t.Fatalf("matchRapidLine = %q, ok=%v; want the byar:git tag", tag, ok)
	}
	// A non-empty depends field (commas in the middle) must not confuse the parse.
	if tag, ok := matchRapidLine("byar:stable,deadbeef,byar:some|byar:other,My Game", "My Game"); !ok || tag != "byar:stable" {
		t.Errorf("depends with commas: tag=%q ok=%v", tag, ok)
	}
	if _, ok := matchRapidLine(line, "Some Other Game"); ok {
		t.Error("must not match a different springname")
	}
	if _, ok := matchRapidLine("garbage-without-commas", "x"); ok {
		t.Error("must not match a line without commas")
	}
	if _, ok := matchRapidLine("only,onecomma", "onecomma"); ok {
		t.Error("must require at least tag,...,name")
	}
}

func TestVersionsURL(t *testing.T) {
	if got := (&Engine{}).versionsURL(); got != "https://repos.beyondallreason.dev/byar/versions.gz" {
		t.Errorf("default versionsURL = %q", got)
	}
	e := &Engine{cfg: Config{RapidRepoMaster: "https://mirror.test/foo/repos.gz"}}
	if got := e.versionsURL(); got != "https://mirror.test/foo/byar/versions.gz" {
		t.Errorf("override versionsURL = %q", got)
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
