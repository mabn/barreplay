package packer

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A minimal but well-formed widget stream (mirrors the pipeline tests).
const statsStream = `BRSNAP DEF {"id":1,"name":"armcom","humanName":"Armada Commander","maxHealth":3000}
BRSNAP T 0 0 armada #ff0000
BRSNAP READY
BRSNAP F 30 1.000 1
BRSNAP U 100 1 0 512.0 80.0 1024.0 3000.0 3000.0
BRSNAP F 60 2.000 1
BRSNAP U 100 1 0 512.0 80.0 1030.0 2900.0 3000.0
BRSNAP EV 58 destroyed 101 1 0
`

// The report renders the section table and the per-def breakdown, with unit
// names resolved from the meta. Both CLIs print this: `pack -stats` and every
// bringest publish.
func TestReportStats(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "not-a-game-id.brsnap")
	if err := os.WriteFile(in, []byte(statsStream), 0o644); err != nil {
		t.Fatal(err)
	}
	brpPath, _, err := Pack(context.Background(), nil, in, dir, "", true)
	if err != nil {
		t.Fatal(err)
	}

	var buf strings.Builder
	if err := ReportStats(&buf, brpPath); err != nil {
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
