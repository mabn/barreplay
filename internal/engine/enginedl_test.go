package engine

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestEngineAssetNamesTheReleaseFile(t *testing.T) {
	got, err := engineAsset("2026.07.04")
	if err != nil {
		t.Skipf("unsupported platform %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	if !strings.HasPrefix(got, "recoil_2026.07.04_") || !strings.HasSuffix(got, ".7z") {
		t.Errorf("engineAsset = %q, want recoil_<ver>_<arch>-<os>.7z", got)
	}
}

// The banner carries build detail after the version, and a locally built engine
// off the same tag is still the right engine — but a different tag is not.
func TestEngineVersionMatches(t *testing.T) {
	cases := []struct {
		banner, want  string
		parsed, match bool
	}{
		{"spring-headless version 2026.07.04 (Headless)", "2026.07.04", true, true},
		{"spring-headless version 2025.06.24-15-g8f4a4bf claude/perf-loop (Headless)", "2025.06.24", true, true},
		{"spring-headless version 2025.06.24 (Headless)", "2026.07.04", true, false},
		// A prefix must not match a longer release: 2025.06.2 != 2025.06.24.
		{"spring-headless version 2025.06.24 (Headless)", "2025.06.2", true, false},
		// Unrecognized banner: "cannot tell", NOT "mismatch" — Locate warns
		// rather than refusing, so a custom build still runs.
		{"no version here", "2026.07.04", false, false},
		{"", "2026.07.04", false, false},
	}
	for _, c := range cases {
		got, parsed := parseEngineVersion(c.banner)
		if parsed != c.parsed {
			t.Errorf("parseEngineVersion(%q) parsed = %v, want %v", c.banner, parsed, c.parsed)
			continue
		}
		if parsed {
			if m := engineVersionMatches(got, c.want); m != c.match {
				t.Errorf("engineVersionMatches(%q, %q) = %v, want %v", got, c.want, m, c.match)
			}
		}
	}
}

// Already-installed is the common case and must not hit the network: the
// release URL points at a server that fails the test if it is called.
func TestEnsureEngineSkipsWhenInstalled(t *testing.T) {
	dir := t.TempDir()
	engDir := filepath.Join(dir, "engine", "2026.07.04")
	if err := os.MkdirAll(engDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(engDir, headlessName()), []byte("#!/bin/true\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("downloaded %s despite the engine being installed", r.URL)
	}))
	defer srv.Close()
	restore := EngineReleaseURL
	EngineReleaseURL = func(v, a string) string { return srv.URL + "/" + a }
	defer func() { EngineReleaseURL = restore }()

	if err := EnsureEngine(context.Background(), Config{DataDir: dir}, "2026.07.04"); err != nil {
		t.Fatalf("EnsureEngine: %v", err)
	}
}

func TestEnsureEngineRespectsOverrides(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected download of %s", r.URL)
	}))
	defer srv.Close()
	restore := EngineReleaseURL
	EngineReleaseURL = func(v, a string) string { return srv.URL + "/" + a }
	defer func() { EngineReleaseURL = restore }()

	for _, cfg := range []Config{
		{DataDir: t.TempDir(), SkipProvision: true},
		{DataDir: t.TempDir(), EngineBinary: "/somewhere/spring-headless"},
	} {
		if err := EnsureEngine(context.Background(), cfg, "2026.07.04"); err != nil {
			t.Errorf("EnsureEngine(%+v): %v", cfg, err)
		}
	}
}

// A download that fails must leave nothing behind that a later run would
// mistake for an installed engine.
func TestEnsureEngineLeavesNoPartialInstall(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "engine"), 0o755); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	defer srv.Close()
	restore := EngineReleaseURL
	EngineReleaseURL = func(v, a string) string { return srv.URL + "/" + a }
	defer func() { EngineReleaseURL = restore }()

	err := EnsureEngine(context.Background(), Config{DataDir: dir}, "2026.07.04")
	if err == nil {
		t.Fatal("want an error for a failed download, got nil")
	}
	if _, serr := os.Stat(filepath.Join(dir, "engine", "2026.07.04")); serr == nil {
		t.Error("a failed download left an engine dir behind")
	}
}

// The guard that matters: an engine of the wrong version must be refused, not
// silently used, because it desyncs and yields a plausible-looking capture of a
// game that never happened.
func TestLocateRejectsMismatchedEngineVersion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script stub is POSIX-only")
	}
	dir := t.TempDir()
	engDir := filepath.Join(dir, "engine", "2025.06.24")
	if err := os.MkdirAll(engDir, 0o755); err != nil {
		t.Fatal(err)
	}
	stub := "#!/bin/sh\necho 'spring-headless version 2025.06.24 (Headless)'\n"
	if err := os.WriteFile(filepath.Join(engDir, headlessName()), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}

	// Asking for the version that IS installed works.
	if _, err := Locate(Config{DataDir: dir, SkipProvision: true}, "2025.06.24"); err != nil {
		t.Fatalf("Locate for the installed version: %v", err)
	}
	// Asking for a different one must fail rather than fall back to it.
	_, err := Locate(Config{DataDir: dir, SkipProvision: true}, "2026.07.04")
	if err == nil {
		t.Fatal("want an error when only a mismatched engine is installed, got nil")
	}
	if !strings.Contains(err.Error(), "2026.07.04") {
		t.Errorf("error should name the required version, got: %v", err)
	}
}
