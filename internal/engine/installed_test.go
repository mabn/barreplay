package engine

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGameInstalled(t *testing.T) {
	dir := t.TempDir()
	e := &Engine{cfg: Config{DataDir: dir}}
	md5 := "47a24f460845204ee5f426f4d21ae16f"

	if e.gameInstalled(md5) {
		t.Error("game should not be reported installed before the sdp exists")
	}
	if e.gameInstalled("") {
		t.Error("empty md5 must report not-installed")
	}

	pkgs := filepath.Join(dir, "packages")
	if err := os.MkdirAll(pkgs, 0o755); err != nil {
		t.Fatal(err)
	}
	// An unfinished download (.sdp.incomplete) must NOT count as installed.
	if err := os.WriteFile(filepath.Join(pkgs, md5+".sdp.incomplete"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if e.gameInstalled(md5) {
		t.Error(".sdp.incomplete must not count as installed")
	}
	// The finalized package does.
	if err := os.WriteFile(filepath.Join(pkgs, md5+".sdp"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !e.gameInstalled(md5) {
		t.Error("finalized .sdp should count as installed")
	}
}

func TestMapInstalled(t *testing.T) {
	dir := t.TempDir()
	e := &Engine{cfg: Config{DataDir: dir}}

	if e.mapInstalled("Hooked 1.1.1") {
		t.Error("no maps dir -> not installed")
	}

	maps := filepath.Join(dir, "maps")
	if err := os.MkdirAll(maps, 0o755); err != nil {
		t.Fatal(err)
	}
	// Real BAR naming: normalized springname, and case-insensitive.
	if err := os.WriteFile(filepath.Join(maps, "Hooked_1.1.1.sd7"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(maps, "supreme_isthmus_v2.1.sdz"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	if !e.mapInstalled("Hooked 1.1.1") {
		t.Error("Hooked 1.1.1 -> hooked_1.1.1.sd7 (case-insensitive) should match")
	}
	if !e.mapInstalled("Supreme Isthmus v2.1") {
		t.Error("Supreme Isthmus v2.1 -> supreme_isthmus_v2.1.sdz should match")
	}
	if e.mapInstalled("Some Other Map") {
		t.Error("absent map must report not-installed")
	}
}
