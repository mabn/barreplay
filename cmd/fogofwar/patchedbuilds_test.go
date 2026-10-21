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
		{Engine: "2026.07.04", Build: engine.PinnedPatchedVersion("2026.07.04")},
		{Engine: "2099.01.01", Build: ""},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if got := installedPatchedBuilds(filepath.Join(data, "missing")); len(got) != 0 {
		t.Fatalf("missing data dir: got %+v", got)
	}
}
