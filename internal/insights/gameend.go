package insights

import (
	"errors"
	"sort"

	"github.com/mabn/barreplay/snapshot"
)

// The end of the game, as the summary tells it. A game is decided the moment
// a side gives up — a resign vote, or the last commander dying in a
// commanders-end game — but the engine then blows up everything that side
// still owns, and its whole army going down at once is the biggest "loss" in
// every chart. So the summary ends where the game was decided and ignores
// what came after: the charts, battles, awards and stories all stop there
// (the clips can still play past it).

// surrenderGap is how far apart the eliminations of one side's teams may be
// and still be ONE surrender: a resign vote kills the voting teams together,
// a straggler a few seconds later.
const surrenderGap = 30 * simFPS

// gameEnd is the frame the game was decided, or -1 when no side left it: the
// moment the number of sides still playing fell to one, taken from the start
// of the run of eliminations that emptied the last side to go (one resign
// vote can be spread over several frames). died maps a team to the frame it
// was eliminated.
func gameEnd(died map[int32]int32, ro roster) int32 {
	teams := map[int][]int32{}
	for _, t := range ro.teams {
		if t.Side >= 0 {
			teams[t.Side] = append(teams[t.Side], t.Team)
		}
	}
	if len(teams) < 2 {
		return -1
	}
	type out struct{ last, start int32 }
	var gone []out
	for _, ts := range teams {
		fs := make([]int32, 0, len(ts))
		for _, t := range ts {
			f, ok := died[t]
			if !ok {
				break
			}
			fs = append(fs, f)
		}
		if len(fs) < len(ts) {
			continue // a team of this side was still playing
		}
		sort.Slice(fs, func(i, j int) bool { return fs[i] < fs[j] })
		i := len(fs) - 1
		for i > 0 && fs[i]-fs[i-1] <= surrenderGap {
			i--
		}
		gone = append(gone, out{last: fs[len(fs)-1], start: fs[i]})
	}
	// The game is over once every side but one is out.
	if len(gone) < len(teams)-1 {
		return -1
	}
	sort.Slice(gone, func(i, j int) bool { return gone[i].last < gone[j].last })
	return gone[len(teams)-2].start
}

var errStop = errors.New("insights: past the end")

// until is the input cut at frame end: nothing at or after it is read, except
// the eliminations AT it, which are how the game ended.
func (in Input) until(end int32) Input {
	frames := in.Frames
	in.Frames = func(yield func(snapshot.Frame) error) error {
		err := frames(func(fr snapshot.Frame) error {
			if fr.Frame >= end {
				return errStop
			}
			return yield(fr)
		})
		if errors.Is(err, errStop) {
			return nil
		}
		return err
	}
	ev := make([]snapshot.Event, 0, len(in.Events))
	for _, e := range in.Events {
		if e.Frame < end {
			ev = append(ev, e)
		}
	}
	in.Events = ev
	cm := make([]snapshot.Comm, 0, len(in.Comms))
	for _, c := range in.Comms {
		if c.Frame < end {
			cm = append(cm, c)
		}
	}
	in.Comms = cm
	if in.TeamDied != nil {
		died := map[int32]int32{}
		for t, f := range in.TeamDied {
			if f <= end {
				died[t] = f
			}
		}
		in.TeamDied = died
	}
	return in
}
