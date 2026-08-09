package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mabn/barreplay/internal/packer"
)

// A minimal but well-formed widget stream (mirrors internal/packer's tests).
const testStream = `BRSNAP DEF {"id":1,"name":"armcom","humanName":"Armada Commander","maxHealth":3000}
BRSNAP T 0 0 armada #ff0000
BRSNAP READY
BRSNAP F 30 1.000 1
BRSNAP U 100 1 0 512.0 80.0 1024.0 3000.0 3000.0
BRSNAP F 60 2.000 1
BRSNAP U 100 1 0 512.0 80.0 1030.0 2900.0 3000.0
BRSNAP EV 58 destroyed 101 1 0
`

// -stats on a packed .brp prints the section table and the per-def breakdown,
// with unit names resolved from the meta.
func TestPrintStats(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "not-a-game-id.brsnap")
	if err := os.WriteFile(in, []byte(testStream), 0o644); err != nil {
		t.Fatal(err)
	}
	brpPath, _, err := packer.Pack(context.Background(), nil, in, dir, "", true)
	if err != nil {
		t.Fatal(err)
	}

	var buf strings.Builder
	if err := printStats(&buf, brpPath); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, want := range []string{
		"section",
		"K keyframes",
		"F frames",
		"top 1 unit defs",
		"armcom (Armada Commander)",
		"frame framing overhead",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("stats output missing %q:\n%s", want, out)
		}
	}
}
