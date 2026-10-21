package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/mabn/barreplay/internal/engine"
)

func TestInstalledPatchedBuilds(t *testing.T) {
	data := t.TempDir()
	put := func(ver, exe string) {
		dir := filepath.Join(data, "engine", ver)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if exe != "" {
			if err := os.WriteFile(filepath.Join(dir, exe), []byte("x"), 0o755); err != nil {
				t.Fatal(err)
			}
		}
	}
	put("2026.07.04", patchedExe())
	put("2025.06.24", stockExe())   // stock only: no faster build
	put("2099.01.01", patchedExe()) // a build nothing pins: made locally

	got := installedPatchedBuilds(data)
	want := []PatchedInfo{
		// "x" is not the pinned binary: an older build, replaced next run.
		{Engine: "2026.07.04", Build: engine.PinnedPatchedVersion("2026.07.04"), Stale: true},
		{Engine: "2099.01.01", Build: ""},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	// Once the binary on disk hashes to the pin, it is the current build.
	exe := filepath.Join(data, "engine", "2026.07.04", patchedExe())
	sum, err := cachedSHA256(exe)
	if err != nil {
		t.Fatal(err)
	}
	defer func(f func(string) string) { pinnedSHA256 = f }(pinnedSHA256)
	pinnedSHA256 = func(string) string { return sum }
	if got := installedPatchedBuilds(data); got[0].Stale {
		t.Fatalf("pinned binary reported stale: %+v", got[0])
	}
	if got := installedPatchedBuilds(filepath.Join(data, "missing")); len(got) != 0 {
		t.Fatalf("missing data dir: got %+v", got)
	}
}

// A file changed in place is hashed again, not served from the cache.
func TestCachedSHA256Rehashes(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(p, []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	a, _ := cachedSHA256(p)
	if err := os.WriteFile(p, []byte("two!"), 0o644); err != nil {
		t.Fatal(err)
	}
	if b, _ := cachedSHA256(p); a == b {
		t.Fatal("stale hash after the file changed")
	}
}
