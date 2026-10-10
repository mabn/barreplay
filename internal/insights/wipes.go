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
