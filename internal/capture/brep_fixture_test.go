package capture

import (
	"compress/gzip"
	"math"
	"os"
	"sort"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// TestBrepstreamMatchesTextFixture pins the Lua encoder <-> Go decoder
// lockstep: tools/brep-harness/harness.lua runs the REAL widget
// (assets/lua/replay_uploader.lua) with both emitters enabled over one
// deterministic simulated game, and this test checks that decoding the binary
// .brepstream reconstructs the same game the battle-tested text parser reads
// from the .brsnap — same frames, same unit sets, values equal up to the
// binary format's documented quantization (whole elmos/hp, dv/sampleEvery
// velocity, 1/255 build). Regenerate the fixtures after any codec change (see
// the harness header).
func TestBrepstreamMatchesTextFixture(t *testing.T) {
	// Text reference.
	tf, err := os.Open("testdata/harness.brsnap.gz")
	if err != nil {
		t.Fatalf("open text fixture: %v", err)
	}
	defer tf.Close()
	tz, err := gzip.NewReader(tf)
	if err != nil {
		t.Fatalf("gunzip text fixture: %v", err)
	}
	var text loadedSink
	if err := Consume(tz, snapshot.Meta{}, &text); err != nil {
		t.Fatalf("Consume(text): %v", err)
	}

	// Binary under test.
	bf, err := os.Open("testdata/harness.brepstream")
	if err != nil {
		t.Fatalf("open brepstream fixture: %v", err)
	}
	defer bf.Close()
	var bin loadedSink
	if err := ConsumeBrep(bf, snapshot.Meta{}, &bin); err != nil {
		t.Fatalf("ConsumeBrep: %v", err)
	}

	// Meta must agree (both heads carry the same GID/GAME/DEF/T/P lines).
	if bin.meta.GameID != text.meta.GameID || bin.meta.GameID == "" {
		t.Errorf("GameID: bin %q text %q", bin.meta.GameID, text.meta.GameID)
	}
	if bin.meta.MapName != text.meta.MapName || bin.meta.MapName == "" {
		t.Errorf("MapName: bin %q text %q", bin.meta.MapName, text.meta.MapName)
	}
	if len(bin.meta.UnitDefs) != len(text.meta.UnitDefs) || len(bin.meta.UnitDefs) == 0 {
		t.Errorf("UnitDefs: bin %d text %d", len(bin.meta.UnitDefs), len(text.meta.UnitDefs))
	}

	if len(bin.frames) == 0 || len(bin.frames) != len(text.frames) {
		t.Fatalf("frames: bin %d text %d", len(bin.frames), len(text.frames))
	}
	for i := range bin.frames {
		fb, ft := bin.frames[i], text.frames[i]
		if fb.Frame != ft.Frame {
			t.Fatalf("frame %d: sim frame bin %d text %d", i, fb.Frame, ft.Frame)
		}
		tu := append([]snapshot.UnitState(nil), ft.Units...)
		sort.Slice(tu, func(a, b int) bool { return tu[a].UnitID < tu[b].UnitID })
		if len(fb.Units) != len(tu) {
			t.Fatalf("frame %d: units bin %d text %d", fb.Frame, len(fb.Units), len(tu))
		}
		for j := range fb.Units {
			ub, ut := fb.Units[j], tu[j]
			if ub.UnitID != ut.UnitID || ub.DefID != ut.DefID || ub.Team != ut.Team {
				t.Fatalf("frame %d unit %d: identity bin %+v text %+v", fb.Frame, j, ub, ut)
			}
			// Text carries 0.1-precision floats; binary quantizes to whole
			// units, so they may differ by up to 0.5 (+0.05 text rounding).
			near(t, fb.Frame, ub.UnitID, "x", ub.Pos.X, ut.Pos.X, 0.56)
			near(t, fb.Frame, ub.UnitID, "z", ub.Pos.Z, ut.Pos.Z, 0.56)
			near(t, fb.Frame, ub.UnitID, "hp", ub.Health, ut.Health, 0.56)
			near(t, fb.Frame, ub.UnitID, "maxHp", ub.MaxHealth, ut.MaxHealth, 0.56)
			// dv quantizes to whole displacement per interval: 0.5/30 (+ text %.2f).
			near(t, fb.Frame, ub.UnitID, "vx", ub.VelX, ut.VelX, 0.5/30+0.006)
			near(t, fb.Frame, ub.UnitID, "vz", ub.VelZ, ut.VelZ, 0.5/30+0.006)
			// build quantizes to 1/255 (+ text %.3f).
			near(t, fb.Frame, ub.UnitID, "build", ub.BuildProgress, ut.BuildProgress, 0.5/255+0.0006)
		}
		// Command state (protocol 3): the text stream dumps the full non-idle
		// set each frame while the binary reconstructs it from keyframe+delta
		// records — the tuples must match EXACTLY (all-integer, quantized
		// identically by the widget before both emitters).
		tc := append([]snapshot.UnitCommand(nil), ft.Commands...)
		sort.Slice(tc, func(a, b int) bool { return tc[a].UnitID < tc[b].UnitID })
		if len(fb.Commands) != len(tc) {
			t.Fatalf("frame %d: commands bin %d text %d", fb.Frame, len(fb.Commands), len(tc))
		}
		for j := range fb.Commands {
			if fb.Commands[j] != tc[j] {
				t.Fatalf("frame %d command %d: bin %+v text %+v", fb.Frame, j, fb.Commands[j], tc[j])
			}
		}
		if len(fb.Resources) != len(ft.Resources) {
			t.Fatalf("frame %d: resources bin %d text %d", fb.Frame, len(fb.Resources), len(ft.Resources))
		}
		for j := range fb.Resources {
			rb, rt := fb.Resources[j], ft.Resources[j]
			if rb.Team != rt.Team {
				t.Fatalf("frame %d res %d: team bin %d text %d", fb.Frame, j, rb.Team, rt.Team)
			}
			// Binary resources are raw f32; text rounds to 0.1/0.01.
			near(t, fb.Frame, rb.Team, "metal", rb.Metal, rt.Metal, 0.051)
			near(t, fb.Frame, rb.Team, "energyIncome", rb.EnergyIncome, rt.EnergyIncome, 0.0051)
		}
	}

	if len(bin.events) == 0 || len(bin.events) != len(text.events) {
		t.Fatalf("events: bin %d text %d", len(bin.events), len(text.events))
	}
	for i := range bin.events {
		if bin.events[i] != text.events[i] {
			t.Fatalf("event %d: bin %+v text %+v", i, bin.events[i], text.events[i])
		}
	}
}

func near(t *testing.T, frame, id int32, what string, got, want, tol float32) {
	t.Helper()
	if math.Abs(float64(got-want)) > float64(tol) {
		t.Fatalf("frame %d unit/team %d %s: bin %v text %v (tol %v)", frame, id, what, got, want, tol)
	}
}
