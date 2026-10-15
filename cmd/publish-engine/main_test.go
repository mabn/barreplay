package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPickBinary(t *testing.T) {
	data := t.TempDir()
	install := func(version string) string {
		dir := filepath.Join(data, "engine", version)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dir, "spring-headless-patched")
		if err := os.WriteFile(p, nil, 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}

	if _, err := pickBinary(data, "", ""); err == nil || !strings.Contains(err.Error(), "no spring-headless-patched") {
		t.Errorf("empty data dir: err = %v", err)
	}
	only := install("2026.07.04")
	if got, err := pickBinary(data, "", ""); err != nil || got != only {
		t.Errorf("one build: got %q, %v; want %q", got, err, only)
	}
	install("2025.06.24")
	if _, err := pickBinary(data, "", ""); err == nil || !strings.Contains(err.Error(), "pass -version") {
		t.Errorf("two builds: err = %v, want a request for -version", err)
	}
	if got, _ := pickBinary(data, "2026.07.04", ""); got != only {
		t.Errorf("-version: got %q, want %q", got, only)
	}
	if got, _ := pickBinary(data, "2026.07.04", "/elsewhere/build"); got != "/elsewhere/build" {
		t.Errorf("a named binary wins: got %q", got)
	}
}

func TestGateGames(t *testing.T) {
	if got, err := gateGames("", "2026.07.04"); err != nil || !reflect.DeepEqual(got, []string{gateReplays["2026.07.04"]}) {
		t.Errorf("default: %v, %v", got, err)
	}
	if got, _ := gateGames(" a, b ,,", "2026.07.04"); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Errorf("-gate list: %v", got)
	}
	if _, err := gateGames("", "2099.01.01"); err == nil {
		t.Error("a version with no default gate replay was accepted without -gate")
	}
}
