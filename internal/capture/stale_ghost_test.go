package capture

import (
	"fmt"
	"strings"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// Preamble for a live enemy-recording capture: recorder is ally 0, enemy team
// 1 is ally 1; def 1 is mobile, def 2 is a building (ghosts persist), def 3 is
// an immobile-but-builder nano (a building by the footprint rule).
const expiryPreamble = `BRSNAP GID a1b2c3d4e5f60718293a4b5c6d7e8f90
BRSNAP GAME {"protocol":2,"mode":"live","sampleEvery":30,"gameSpeed":30,"recordEnemies":true,"playerID":0,"allyTeam":0,"spectator":false}
BRSNAP DEF {"id":1,"name":"pewpew","canMove":true}
BRSNAP DEF {"id":2,"name":"bunker","isBuilding":true}
BRSNAP DEF {"id":3,"name":"nano","canMove":false,"isBuilder":true}
BRSNAP T 0 0 armada #8040ff
BRSNAP T 1 1 cortex #ff4040
BRSNAP READY
`

// TestBrepStaleGhostExpiry pins the decode-time stale-ghost policy: an enemy
// unit whose sampled state is completely frozen for over staleGhostTTLSecs is
// hidden from decoded frames until something about it changes, while building
// ghosts, own-ally units, and anything still moving/wobbling persist.
func TestBrepStaleGhostExpiry(t *testing.T) {
	e := newBrepEnc(expiryPreamble)
	// Frame 0 keyframe: own unit 3 (parked), enemy mobile ghost 5, enemy
	// building ghost 7, enemy nano ghost 8, untyped enemy blip 9, and a
	// wobbling radar contact 11. All frozen except 11.
	units := func(wobble int) []tu {
		return []tu{
			{id: 3, def: 1, team: 0, x: 50, z: 50, hp: 100, maxHp: 100, build: 255},
			{id: 5, def: 1, team: 1, x: 100, z: 200, hp: 550, maxHp: 550, build: 255},
			{id: 7, def: 2, team: 1, x: 300, z: 300, hp: 900, maxHp: 900, build: 255},
			{id: 8, def: 3, team: 1, x: 350, z: 350, hp: 400, maxHp: 400, build: 255},
			{id: 9, def: 0, team: 1, x: 400, z: 400, hp: 0, maxHp: 0, build: 255},
			{id: 11, def: 0, team: 1, x: 500 + wobble, z: 500 - wobble, hp: 0, maxHp: 0, build: 255},
		}
	}
	e.record('F', frameRecord(0, true, units(0), nil, nil))
	// Delta frames to frame 2100 (70 samples > 60 s TTL): everything frozen is
	// fully predicted (zero units restated); only the wobbling blip restates.
	for f := 30; f <= 2100; f += 30 {
		e.record('F', frameRecord(f, false, []tu{
			{id: 11, def: 0, team: 1, x: 500 + (f/30)%7, z: 500 - (f/30)%7, hp: 0, maxHp: 0, build: 255},
		}, nil, nil))
	}
	// Frame 2130: ghost 5 moves again — it was alive all along; must revive.
	e.record('F', frameRecord(2130, false, []tu{
		{id: 5, def: 1, team: 1, x: 130, z: 200, hp: 550, maxHp: 550, dvx: 30, build: 255},
		{id: 11, def: 0, team: 1, x: 505, z: 495, hp: 0, maxHp: 0, build: 255},
	}, nil, nil))

	var s loadedSink
	if err := ConsumeBrep(strings.NewReader(e.buf.String()), snapshot.Meta{}, &s); err != nil {
		t.Fatalf("ConsumeBrep: %v", err)
	}
	byFrame := map[int32]map[int32]bool{}
	for _, fr := range s.frames {
		m := map[int32]bool{}
		for _, u := range fr.Units {
			m[u.UnitID] = true
		}
		byFrame[fr.Frame] = m
	}
	// TTL is 60 s * 30 fps = 1800 frames from the streak start (frame 0).
	for _, f := range []int32{0, 900, 1800} {
		for _, id := range []int32{3, 5, 7, 8, 9, 11} {
			if !byFrame[f][id] {
				t.Errorf("frame %d: unit %d should still be visible (within TTL)", f, id)
			}
		}
	}
	for _, f := range []int32{1830, 2100} {
		for _, id := range []int32{5, 9} {
			if byFrame[f][id] {
				t.Errorf("frame %d: stale enemy ghost %d should be hidden", f, id)
			}
		}
		for _, id := range []int32{3, 7, 8, 11} {
			if !byFrame[f][id] {
				t.Errorf("frame %d: unit %d must persist (own-ally/building/wobbling)", f, id)
			}
		}
	}
	if !byFrame[2130][5] {
		t.Errorf("frame 2130: ghost 5 moved again and must revive")
	}
	if byFrame[2130][9] {
		t.Errorf("frame 2130: blip 9 is still frozen and must stay hidden")
	}
}

// TestBrepStaleGhostExpiryGate: without the GAME line's recordEnemies (a resim
// capture, an old own-team-only widget) or when spectating full view, the
// policy must not run — absence already means death there, and a parked own
// structure must never be hidden.
func TestBrepStaleGhostExpiryGate(t *testing.T) {
	for name, preamble := range map[string]string{
		"no-recordEnemies": strings.Replace(expiryPreamble, `"recordEnemies":true,`, "", 1),
		"spectator":        strings.Replace(expiryPreamble, `"spectator":false`, `"spectator":true`, 1),
	} {
		e := newBrepEnc(preamble)
		e.record('F', frameRecord(0, true, []tu{
			{id: 5, def: 1, team: 1, x: 100, z: 200, hp: 550, maxHp: 550, build: 255},
		}, nil, nil))
		for f := 30; f <= 2100; f += 30 {
			e.record('F', frameRecord(f, false, nil, nil, nil))
		}
		var s loadedSink
		if err := ConsumeBrep(strings.NewReader(e.buf.String()), snapshot.Meta{}, &s); err != nil {
			t.Fatalf("%s: ConsumeBrep: %v", name, err)
		}
		lastFr := s.frames[len(s.frames)-1]
		if len(lastFr.Units) != 1 {
			t.Errorf("%s: expiry must be inert, want unit 5 at frame %d, got %d units",
				name, lastFr.Frame, len(lastFr.Units))
		}
	}
}

// TestConsumeStaleGhostExpiry is the same policy on the text (.brsnap) path.
func TestConsumeStaleGhostExpiry(t *testing.T) {
	var b strings.Builder
	b.WriteString(expiryPreamble)
	for f := 0; f <= 2100; f += 30 {
		b.WriteString(fmt.Sprintf("BRSNAP F %d %.1f 2\n", f, float64(f)/30))
		b.WriteString("BRSNAP U 5 1 1 100.0 0.0 200.0 550.0 550.0 0.00 0.00 0.00 1.000\n")
		b.WriteString("BRSNAP U 7 2 1 300.0 0.0 300.0 900.0 900.0 0.00 0.00 0.00 1.000\n")
	}
	var r recordingWriter
	if err := Consume(strings.NewReader(b.String()), snapshot.Meta{}, &r); err != nil {
		t.Fatalf("Consume: %v", err)
	}
	last := r.frames[len(r.frames)-1]
	if last.Frame != 2100 {
		t.Fatalf("want last frame 2100, got %d", last.Frame)
	}
	if len(last.Units) != 1 || last.Units[0].UnitID != 7 {
		t.Errorf("frame 2100: want only building ghost 7, got %+v", last.Units)
	}
}
