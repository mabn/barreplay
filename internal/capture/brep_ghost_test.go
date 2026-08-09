package capture

import (
	"os"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// TestBrepGhostSemantics pins the uploader widget's enemy-ghost and death-
// tombstone semantics against the harness storyline (the enemyVis table and
// scripted lifecycle in tools/brep-harness/harness.lua — unit ids and sample
// windows here must stay in sync with it). The binary-vs-text cross-check
// cannot catch this bug class: a widget that wrongly keeps a dead unit alive
// emits perfectly self-consistent streams in BOTH formats. That happened in a
// real capture — the engine kept returning a morphed (destroyed) enemy
// commander's id from GetAllUnits as a frozen radar-memory dot, and the
// sample loop resurrected the ghost right after UnitDestroyed buried it.
func TestBrepGhostSemantics(t *testing.T) {
	f, err := os.Open("testdata/harness.brepstream")
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()
	var s loadedSink
	if err := ConsumeBrep(f, snapshot.Meta{}, &s); err != nil {
		t.Fatalf("ConsumeBrep: %v", err)
	}

	// byFrame[simFrame][unitID]; the harness samples every 30 frames.
	byFrame := make(map[int32]map[int32]snapshot.UnitState, len(s.frames))
	for _, fr := range s.frames {
		m := make(map[int32]snapshot.UnitState, len(fr.Units))
		for _, u := range fr.Units {
			m[u.UnitID] = u
		}
		byFrame[fr.Frame] = m
	}
	at := func(sample int, id int32) *snapshot.UnitState {
		m := byFrame[int32(sample*30)]
		if m == nil {
			t.Fatalf("no frame decoded at sample %d", sample)
		}
		if u, ok := m[id]; ok {
			return &u
		}
		return nil
	}

	// id 159: radar 10..24, engine memory dot 25..69; UnitDestroyed fires at
	// s=40 while the dot KEEPS being returned by GetAllUnits through s=69.
	// The tombstone must bury it at s=40 for good — before the fix the dot
	// resurrected it (the real-capture armcom morph bug).
	if at(39, 159) == nil {
		t.Errorf("159 should be recorded (memory dot) at s=39")
	}
	for _, smp := range []int{40, 41, 64, 69} { // 64 = segment-1 keyframe
		if at(smp, 159) != nil {
			t.Errorf("159 destroyed at s=40 must stay buried, but present at s=%d", smp)
		}
	}

	// id 162: destroyed in view at s=20 with a corpse-dot returned through
	// s=29 (must stay buried), then the id is REUSED by a new unit in LOS
	// from s=30 (readable health clears the tombstone; new def 20).
	if at(19, 162) == nil {
		t.Errorf("162 should be live at s=19")
	}
	for _, smp := range []int{20, 25, 29} {
		if at(smp, 162) != nil {
			t.Errorf("162 destroyed at s=20 must stay buried, but present at s=%d", smp)
		}
	}
	if u := at(30, 162); u == nil {
		t.Errorf("162 reused by a new unit must be recorded again at s=30")
	} else if u.DefID != 20 {
		t.Errorf("reused 162 should carry the new def 20, got %d", u.DefID)
	}

	// id 165: dies unseen at s=20 (no UnitDestroyed); its dot is recorded
	// through s=49, then the widget's own ghost takes over — frozen at the
	// dot position, never dead-listed, alive at the final sample (139).
	a, b := at(49, 165), at(69, 165)
	if a == nil || b == nil {
		t.Fatalf("165 must persist as dot+ghost (s=49: %v, s=69: %v)", a, b)
	}
	if a.Pos != b.Pos || b.VelX != 0 || b.VelZ != 0 {
		t.Errorf("165 ghost must stay frozen: s=49 %+v vs s=69 %+v", a, b)
	}
	// The segment restart at s=74 legitimately forgets it (fresh instance).

	// id 168: killed in LOS at s=30, and the
	// engine keeps returning the killed unit itself (not a dot) through s=33
	// — in LOS, everything readable, health 0. That hp-0 read must not be
	// mistaken for "alive, so the id was reused": it is the exact shape that
	// left 57 dead units standing at 0 hp in a real 8v8 capture.
	if at(29, 168) == nil {
		t.Errorf("168 should be live at s=29")
	}
	for _, smp := range []int{30, 33, 64, 139} { // 33 = last dying sample, 64 = keyframe
		if u := at(smp, 168); u != nil {
			t.Errorf("168 killed at s=30 must stay buried, but present at s=%d (%+v)", smp, u)
		}
	}

	// id 171: killed at s=71, while the widget is disabled (70..73), so no
	// UnitDestroyed ever reaches it. The fresh instance meets the corpse in
	// LOS at s=74..76 with no tombstone at all — health 0 is the only
	// evidence, and it has to be enough.
	if at(69, 171) == nil {
		t.Errorf("171 should be live at s=69 (before the widget is disabled)")
	}
	for _, smp := range []int{74, 76, 100, 139} { // 74 = segment-2 keyframe
		if u := at(smp, 171); u != nil {
			t.Errorf("171 killed unwitnessed at s=71 must never be recorded, but present at s=%d (%+v)", smp, u)
		}
	}

	// id 126 (regression guard for the good case): LOS 10..29, radar 30..39,
	// then OUR ghost — frozen across the s=64 keyframe until the segment
	// ends, and absent from segment 2.
	ga, gb := at(45, 126), at(69, 126)
	if ga == nil || gb == nil || ga.Pos != gb.Pos {
		t.Errorf("126 ghost must stay frozen s=45..69 (got %+v vs %+v)", ga, gb)
	}
	if at(74, 126) != nil {
		t.Errorf("126 must be absent after the segment restart")
	}
}
