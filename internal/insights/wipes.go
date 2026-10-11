package insights

import "sort"

// Eliminations. When a team leaves the game — its player resigned, its
// commander died in a commander-ends game, or the game ended — the engine
// destroys everything it still owns. Those deaths arrive as destroyed events
// exactly like battle losses, and at the end of a game they are most of the
// deaths there are: a 16-player game that ended in a run of resignations
// gave eight of its twelve "battles" to them. So they are told apart before
// anything counts deaths as fighting.

const (
	wipeGap  = simFPS // frames between deaths that still make one burst
	wipeMinN = 8      // deaths a burst needs to read as a team going down
)

// eliminations lists the teams that left the game, in time order. A recorded
// fact (a v6 capture's teamdied) wins. Without facts — every capture before
// .brp v6 — a team is eliminated at the start of its LAST burst of deaths when
// that burst was big and none of its units was seen alive after it.
// lastAlive maps a team to the last sampled frame holding a live unit of it.
func eliminations(d Deaths, recorded map[int32]int32, lastAlive map[int32]int32, teams []Team) []Elimination {
	out := []Elimination{}
	player := map[int32]bool{}
	for _, t := range teams {
		if t.Side >= 0 {
			player[t.Team] = true
		}
	}
	if recorded != nil {
		for team, f := range recorded {
			if player[team] {
				out = append(out, Elimination{F: f, Team: team, Recorded: true})
			}
		}
	} else {
		frames := map[int32][]int32{}
		for i, team := range d.Team {
			if player[team] {
				frames[team] = append(frames[team], d.F[i])
			}
		}
		for team, fs := range frames {
			// Events are walked in frame order, so each list already is.
			last := len(fs) - 1
			i := last
			for i > 0 && fs[i]-fs[i-1] <= wipeGap {
				i--
			}
			if last-i+1 >= wipeMinN && lastAlive[team] <= fs[last] {
				out = append(out, Elimination{F: fs[i], Team: team})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].F != out[j].F {
			return out[i].F < out[j].F
		}
		return out[i].Team < out[j].Team
	})
	return out
}

// handoffNear is how far (sim frames) a burst of given units may lie from a
// recorded elimination and still be that team's units being handed on.
const handoffNear = 60 * simFPS

// giveBursts follows, per giving team, its latest run of units handed to
// another team: the frames between gives at most wipeGap apart.
type giveBursts map[int32]*giveBurst

type giveBurst struct {
	f0, f1 int32
	n      int
	to     map[int32]int
}

func (g *giveBursts) add(from, to, f int32) {
	if *g == nil {
		*g = giveBursts{}
	}
	b := (*g)[from]
	if b == nil || f-b.f1 > wipeGap {
		b = &giveBurst{f0: f, to: map[int32]int{}}
		(*g)[from] = b
	}
	b.f1 = f
	b.n++
	b.to[to]++
}

// withHandoffs adds the players who left by HANDING their units over: a
// last burst of at least wipeMinN units given away, after which the team
// owned nothing. The engine destroys nothing and records no teamdied, since
// the team still exists, so neither rule in eliminations sees it; the
// player is out of the game all the same. A team already eliminated keeps
// its elimination, but gains the recipient when such a burst came within
// handoffNear of it: a player who RESIGNS is recorded dead by the engine
// and then has their units shared out, and "eliminated" would read as an
// army destroyed when it was handed on whole.
func withHandoffs(out []Elimination, gives giveBursts, lastAlive map[int32]int32, teams []Team) []Elimination {
	known := map[int32]int{}
	for i, e := range out {
		known[e.Team] = i
	}
	for _, t := range teams {
		b := gives[t.Team]
		if t.Side < 0 || b == nil || b.n < wipeMinN {
			continue
		}
		to, most := int32(-1), 0
		for k, n := range b.to {
			if n > most || (n == most && k < to) {
				to, most = k, n
			}
		}
		if i, ok := known[t.Team]; ok {
			if e := &out[i]; e.To == nil && b.f1 >= e.F-handoffNear && b.f0 <= e.F+handoffNear {
				e.To = &to
			}
			continue
		}
		if lastAlive[t.Team] > b.f1 {
			continue
		}
		out = append(out, Elimination{F: b.f0, Team: t.Team, To: &to})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].F != out[j].F {
			return out[i].F < out[j].F
		}
		return out[i].Team < out[j].Team
	})
	return out
}

// wipedDeaths marks the deaths that came with their team's elimination.
func wipedDeaths(d Deaths, elim []Elimination) []bool {
	at := map[int32]int32{}
	for _, e := range elim {
		at[e.Team] = e.F
	}
	out := make([]bool, len(d.F))
	for i := range d.F {
		if f, ok := at[d.Team[i]]; ok && d.F[i] >= f {
			out[i] = true
		}
	}
	return out
}
