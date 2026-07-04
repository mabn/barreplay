package engine

import (
	"os"
	"testing"
)

func TestProvisionedCacheRoundTrip(t *testing.T) {
	dir := t.TempDir()
	e := &Engine{cfg: Config{DataDir: dir}}

	// Missing cache -> empty but usable maps.
	pc := e.loadProvisioned()
	if pc.Games == nil || pc.Maps == nil {
		t.Fatal("loadProvisioned returned nil maps")
	}
	if pc.Games["Beyond All Reason test-1"] {
		t.Error("unexpected game in fresh cache")
	}

	// Record and persist.
	pc.Games["Beyond All Reason test-1"] = true
	pc.Maps["Supreme Isthmus v2.1"] = true
	e.saveProvisioned(pc)

	if _, err := os.Stat(e.provisionedPath()); err != nil {
		t.Fatalf("cache not written: %v", err)
	}

	// Reload sees the recorded entries.
	pc2 := e.loadProvisioned()
	if !pc2.Games["Beyond All Reason test-1"] {
		t.Error("game not persisted")
	}
	if !pc2.Maps["Supreme Isthmus v2.1"] {
		t.Error("map not persisted")
	}
	if pc2.Maps["Some Other Map"] {
		t.Error("unrecorded map should not be present")
	}
}
