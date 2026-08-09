package capture

import (
	"os"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// TestBrepGhostSemantics pins the uploader widget's enemy-visibility and
// death-tombstone semantics against the harness storyline (the enemyVis table
// and scripted lifecycle in tools/brep-harness/harness.lua — unit ids and
// sample windows here must stay in sync with it). The binary-vs-text
// cross-check cannot catch this bug class: a widget that wrongly keeps a dead
// unit alive emits perfectly self-consistent streams in BOTH formats.
//
// Widget >= 1.5.0: the engine's GetAllUnits listing IS the record. An enemy
// the engine stops listing (no LOS, no radar signature, no memory dot)
// disappears from the stream that sample — dropped, not marked dead — and is
// recorded afresh if listed again. The pre-1.5.0 frozen-"ghost" persistence
// (and its LOS scout check) is gone. Death tombstones remain: the engine can
// keep returning a killed unit's id (stale radar-memory dot / lingering
// corpse), which must not be recorded as a live unit.
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

	// id 165: dies unseen at s=20 (no UnitDestroyed); the engine's memory dot
	// keeps it listed through s=49, so it stays recorded — the capture shows
	// what the player's sensors report. From s=50 the engine stops listing it
	// and it must vanish from the stream (no frozen ghost).
	if at(49, 165) == nil {
		t.Errorf("165 must be recorded while its memory dot is listed (s=49)")
	}
	for _, smp := range []int{50, 55, 64, 69, 139} { // 64 = segment-1 keyframe
		if u := at(smp, 165); u != nil {
			t.Errorf("165 unlisted from s=50 must be dropped, but present at s=%d (%+v)", smp, u)
		}
	}

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

	// id 174: in LOS 10..24, then unlisted — it must vanish from the stream
	// on the very sample the engine stops listing it (s=25), with no
	// destroyed event and no lingering ghost.
	if at(24, 174) == nil {
		t.Errorf("174 should be live at s=24")
	}
	for _, smp := range []int{25, 39, 40, 64, 69} { // 64 = segment-1 keyframe
		if u := at(smp, 174); u != nil {
			t.Errorf("174 unlisted from s=25 must be dropped, but present at s=%d (%+v)", smp, u)
		}
	}

	// id 177: damaged on its LAST visible sample (s=30) — the changed hp is
	// recorded — then unlisted and dropped immediately at s=31 (no grace, no
	// scout check: those existed only for ghost persistence).
	if at(30, 177) == nil {
		t.Errorf("177 should be live at s=30")
	}
	for _, smp := range []int{31, 32, 40, 64} { // 64 = segment-1 keyframe
		if u := at(smp, 177); u != nil {
			t.Errorf("177 unlisted from s=31 must be dropped, but present at s=%d (%+v)", smp, u)
		}
	}

	// id 126: LOS 10..29, radar 30..39, then unlisted — recorded through the
	// radar window, gone from s=40 on (and absent from segment 2).
	if at(39, 126) == nil {
		t.Errorf("126 should be recorded (radar) at s=39")
	}
	for _, smp := range []int{40, 45, 64, 69, 74} { // 74 = segment-2 keyframe
		if u := at(smp, 126); u != nil {
			t.Errorf("126 unlisted from s=40 must be dropped, but present at s=%d (%+v)", smp, u)
		}
	}

	// id 156: LOS 0..20, a visibility gap 21..39, LOS again 40..60 — gone for
	// exactly the unlisted stretch, recorded afresh on re-contact, then gone
	// again after s=60. The drop is not a death: the same id simply returns.
	if at(20, 156) == nil {
		t.Errorf("156 should be live at s=20")
	}
	for _, smp := range []int{21, 30, 39} {
		if u := at(smp, 156); u != nil {
			t.Errorf("156 unlisted s=21..39 must be dropped, but present at s=%d (%+v)", smp, u)
		}
	}
	if at(40, 156) == nil || at(60, 156) == nil {
		t.Errorf("156 re-listed at s=40..60 must be recorded again")
	}
	if at(61, 156) != nil {
		t.Errorf("156 unlisted again from s=61 must be dropped")
	}
}
