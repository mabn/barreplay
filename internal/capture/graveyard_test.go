package capture

import (
	"fmt"
	"strings"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// TestBrepGraveyardRepairsOldCaptures pins the decode-time repair pass for the
// captures already uploaded by uploader widgets before 1.2.0: a unit the
// stream itself reported destroyed, then went on emitting forever as a frozen
// 0 hp ghost, must not survive the decode. Unit 7 is that ghost; unit 9 dies
// and has its id recycled by a live unit, which must come back.
func TestBrepGraveyardRepairsOldCaptures(t *testing.T) {
	e := newBrepEnc(brepPreamble)
	e.record('F', frameRecord(0, true, []tu{
		{id: 7, def: 1, team: 0, x: 100, z: 200, hp: 500, maxHp: 500, build: 255},
		{id: 9, def: 1, team: 0, x: 300, z: 400, hp: 600, maxHp: 600, build: 255},
	}, nil, nil))
	e.record('E', []byte("15 destroyed 7 1 0"))
	e.record('E', []byte("20 destroyed 9 1 0"))
	// The buggy widget re-recorded the killed unit at hp 0 (the engine still
	// had it) and then carried it as a zero-byte prediction; id 9 is recycled
	// by a new, living unit.
	e.record('F', frameRecord(30, false, []tu{
		{id: 7, def: 1, team: 0, x: 100, z: 200, hp: 0, maxHp: 500, build: 255},
		{id: 9, def: 2, team: 0, x: 900, z: 900, hp: 111, maxHp: 800, build: 255},
	}, nil, nil))
	e.record('F', frameRecord(60, false, nil, nil, nil))
	// A keyframe restates everything the recorder still tracked, ghost included.
	e.record('F', frameRecord(90, true, []tu{
		{id: 7, def: 1, team: 0, x: 100, z: 200, hp: 0, maxHp: 500, build: 255},
		{id: 9, def: 2, team: 0, x: 900, z: 900, hp: 111, maxHp: 800, build: 255},
	}, nil, nil))

	var s loadedSink
	if err := ConsumeBrep(strings.NewReader(e.buf.String()), snapshot.Meta{}, &s); err != nil {
		t.Fatalf("ConsumeBrep: %v", err)
	}
	if len(s.frames) != 4 {
		t.Fatalf("want 4 frames, got %d", len(s.frames))
	}
	for _, fr := range s.frames[1:] {
		for _, u := range fr.Units {
			if u.UnitID == 7 {
				t.Errorf("frame %d still carries destroyed unit 7: %+v", fr.Frame, u)
			}
		}
	}
	if len(s.frames[0].Units) != 2 {
		t.Errorf("frame 0 (before the deaths) should keep both units, got %d", len(s.frames[0].Units))
	}
	for _, fr := range s.frames[1:] {
		found := false
		for _, u := range fr.Units {
			if u.UnitID == 9 {
				found = true
				if u.DefID != 2 {
					t.Errorf("frame %d: recycled id 9 should carry the new def 2, got %d", fr.Frame, u.DefID)
				}
			}
		}
		if !found {
			t.Errorf("frame %d: id 9, recycled by a living unit, must be recorded", fr.Frame)
		}
	}
	// The events themselves are always passed through untouched.
	if len(s.events) != 2 {
		t.Errorf("want both destroyed events preserved, got %d", len(s.events))
	}
}

// TestConsumeGraveyardRepairsOldCaptures is the same repair on the text
// (.brsnap) path — the two parsers must agree, since one real game is captured
// in both formats to cross-check the encoders.
func TestConsumeGraveyardRepairsOldCaptures(t *testing.T) {
	var b strings.Builder
	b.WriteString("BRSNAP DEF {\"id\":1,\"name\":\"armcom\"}\nBRSNAP T 0 0 armada #8040ff\nBRSNAP READY\n")
	unit := func(id, def, hp int) string {
		return fmt.Sprintf("BRSNAP U %d %d 0 100.0 0.0 200.0 %d.0 500.0 0.0 0.0 0.0 1.000\n", id, def, hp)
	}
	b.WriteString("BRSNAP F 0 0.0 2\n" + unit(7, 1, 500) + unit(9, 1, 600))
	b.WriteString("BRSNAP EV 15 destroyed 7 1 0\n")
	b.WriteString("BRSNAP EV 20 destroyed 9 1 0\n")
	b.WriteString("BRSNAP F 30 1.0 2\n" + unit(7, 1, 0) + unit(9, 2, 111))

	var r recordingWriter
	if err := Consume(strings.NewReader(b.String()), snapshot.Meta{}, &r); err != nil {
		t.Fatalf("Consume: %v", err)
	}
	if len(r.frames) != 2 {
		t.Fatalf("want 2 frames, got %d", len(r.frames))
	}
	if len(r.frames[1].Units) != 1 || r.frames[1].Units[0].UnitID != 9 {
		t.Errorf("frame 30 should keep only the recycled id 9, got %+v", r.frames[1].Units)
	}
}
