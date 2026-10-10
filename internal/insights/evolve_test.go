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
