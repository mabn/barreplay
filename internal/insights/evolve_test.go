package insights

import (
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

func TestEvolutions(t *testing.T) {
	ev := func(f int32, kind snapshot.EventKind, id, team int32, cause *snapshot.EventCause) snapshot.Event {
		return snapshot.Event{Frame: f, Kind: kind, UnitID: id, DefID: 1, Team: team, Cause: cause}
	}
	shot := &snapshot.EventCause{UnitID: 9, DefID: 2, Team: 1, WeaponDef: 3}
	events := []snapshot.Event{
		// Team 0's commander evolves: the new form spawns finished, the old
		// one goes with no cause, all in one frame.
		ev(18000, snapshot.EventCreated, 10, 0, nil),
		ev(18000, snapshot.EventFinished, 10, 0, nil),
		ev(18000, snapshot.EventDestroyed, 1, 0, nil),
		// Team 1 builds a unit over time and loses one at the frame it
		// finishes: neither is an evolution.
		ev(17000, snapshot.EventCreated, 11, 1, nil),
		ev(18000, snapshot.EventFinished, 11, 1, nil),
		ev(18000, snapshot.EventDestroyed, 2, 1, nil),
		// Team 2 gets a free unit while one of its units is shot down: the
		// death has a killer, so it is a loss.
		ev(18000, snapshot.EventCreated, 12, 2, nil),
		ev(18000, snapshot.EventFinished, 12, 2, nil),
		ev(18000, snapshot.EventDestroyed, 3, 2, shot),
	}
	got := evolutions(events)
	want := map[int]bool{1: true, 2: true}
	for i, e := range events {
		if got.replaced(e) != want[i] {
			t.Errorf("event %d %+v: replaced = %v", i, e, !want[i])
		}
	}
}

// A unit that goes with no cause before it was finished is a cancelled
// build, not a loss; finished, it is a crash, which is.
func TestCancelledBuildIsNotALoss(t *testing.T) {
	p := &pass{
		hasCauses: true,
		defs:      map[int32]defInfo{1: {cost: 4400}},
		pending:   map[int32]bool{7: true},
		ro:        roster{teamSide: map[int32]int{5: 0}},
	}
	gone := func(id int32) snapshot.Event {
		return snapshot.Event{Frame: 100, Kind: snapshot.EventDestroyed, UnitID: id, DefID: 1, Team: 5}
	}
	if !p.removedByOwner(gone(7)) {
		t.Error("an unfinished unit gone with no cause counts as a loss")
	}
	if p.removedByOwner(gone(8)) {
		t.Error("a finished unit gone with no cause (a crash) is not a loss")
	}
}

func TestLossCostCountsWhatWasBuilt(t *testing.T) {
	p := &pass{defs: map[int32]defInfo{7: {cost: 1000}}, pending: map[int32]bool{1: true, 2: true}, built: map[int32]float32{1: 0.25}}
	cases := []struct {
		unit int32
		want float64
	}{
		{1, 250}, // a quarter built
		{2, 0},   // never sampled: cancelled as it started
		{3, 1000},
	}
	for _, c := range cases {
		if got := p.lossCost(snapshot.Event{UnitID: c.unit, DefID: 7}); got != c.want {
			t.Errorf("unit %d: lossCost = %v, want %v", c.unit, got, c.want)
		}
	}
}
