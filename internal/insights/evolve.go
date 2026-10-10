package insights

import "github.com/mabn/barreplay/snapshot"

// evolution is a unit REPLACED by another in place: BAR's evolving
// commanders (and any other evolving unit) are swapped for their next form
// by removing the old unit and spawning the new one already finished, in the
// same frame and for the same team. Neither half is anything a player did:
// the old unit was not lost and the new one was not built.
type evolution struct {
	old map[int32]int32 // unit id -> frame it was replaced
	new map[int32]int32 // unit id -> frame it was spawned
}

// evolutions finds them in the events. The signature is the instant spawn:
// created and finished in one frame, which nothing a builder makes does.
// Each such spawn takes one causeless death of its team in that frame, so a
// unit that genuinely died at the same moment (it has a killer, in a capture
// that names them) is never mistaken for one.
func evolutions(events []snapshot.Event) evolution {
	ev := evolution{old: map[int32]int32{}, new: map[int32]int32{}}
	type key struct{ frame, team int32 }
	created := map[int32]int32{} // unit id -> created frame
	spawns := map[key][]int32{}
	deaths := map[key][]int32{}
	for _, e := range events {
		k := key{e.Frame, e.Team}
		switch e.Kind {
		case snapshot.EventCreated:
			created[e.UnitID] = e.Frame
		case snapshot.EventFinished:
			if f, ok := created[e.UnitID]; ok && f == e.Frame {
				spawns[k] = append(spawns[k], e.UnitID)
			}
		case snapshot.EventDestroyed:
			if e.Cause == nil {
				deaths[k] = append(deaths[k], e.UnitID)
			}
		}
	}
	for k, ids := range spawns {
		gone := deaths[k]
		n := min(len(ids), len(gone))
		for i := 0; i < n; i++ {
			ev.new[ids[i]] = k.frame
			ev.old[gone[i]] = k.frame
		}
	}
	return ev
}

// replaced reports an event of either half of an evolution.
func (ev evolution) replaced(e snapshot.Event) bool {
	switch e.Kind {
	case snapshot.EventDestroyed:
		f, ok := ev.old[e.UnitID]
		return ok && f == e.Frame
	case snapshot.EventFinished:
		f, ok := ev.new[e.UnitID]
		return ok && f == e.Frame
	}
	return false
}
