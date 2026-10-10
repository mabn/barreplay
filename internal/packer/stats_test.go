package packer

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mabn/barreplay/internal/capture/breptest"
)

// A minimal but well-formed widget stream (mirrors the pipeline tests).
var statsStream = string(breptest.New(`BRSNAP DEF {"id":1,"name":"armcom","humanName":"Armada Commander","maxHealth":3000}
BRSNAP T 0 0 armada #ff0000
BRSNAP READY
`).
	Keyframe(30, breptest.Unit{ID: 100, Def: 1, X: 512, Z: 1024, HP: 3000, MaxHP: 3000, Build: 255}).
	Keyframe(60, breptest.Unit{ID: 100, Def: 1, X: 512, Z: 1030, HP: 2900, MaxHP: 3000, Build: 255}).
	Event(58, "destroyed", 101, 1, 0).
	Bytes())

// The report renders the section table and the per-def breakdown, with unit
// names resolved from the meta. Both CLIs print this: `pack -stats` and every
// bringest publish.
func TestReportStats(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "not-a-game-id.brepstream")
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
