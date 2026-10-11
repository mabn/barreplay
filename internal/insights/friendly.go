package insights

import "fmt"

// Friendly fire and own blasts: what a side lost to its own side.
//
// Two different things hide behind "killed by your own side", and the engine
// records both the same way. A BLAST is a dying unit's explosion — a fusion
// going up and taking the next one with it — which the engine credits to the
// exploding unit, or to nobody. FRIENDLY FIRE is a living unit's weapon
// killing an ally: an Intimidator shelling a teammate's base. The first is
// how a chain of power plants ends, routinely, whoever set it off; the
// second is rare and worth an award.

const (
	friendlyWindow = 10 * simFPS // frames one attack's kills fall within
	friendlyMin    = 2000.0      // metal of allies one attack must destroy for the award
	blastDying     = 3 * simFPS  // a killer that dies this soon after its kill was exploding
	ownTrigger     = 5 * simFPS  // frames before a blast an enemy kill counts as setting it off
)

// killerDying says whether death i's killer was itself going down: it died
// within blastDying of the kill (or a little before, since the engine
// destroys the exploding unit first). Then the kill was its blast.
func (p *pass) killerDying(i int, deathsOf map[int32][]int32) bool {
	if i >= len(p.deathKillerUnit) {
		return false
	}
	ku := p.deathKillerUnit[i]
	if ku < 0 {
		return false
	}
	f := p.out.Deaths.F[i]
	for _, df := range deathsOf[ku] {
		if df >= f-simFPS && df <= f+blastDying {
			return true
		}
	}
	return false
}

// deathsByUnit maps every dead unit id to the frames it died at (ids are
// recycled, so one id can die more than once).
func (p *pass) deathsByUnit() map[int32][]int32 {
	out := map[int32][]int32{}
	for i, u := range p.deathUnit {
		out[u] = append(out[u], p.out.Deaths.F[i])
	}
	return out
}

// ownFire says whether death i was its own side's doing: a blast with no
// enemy behind it (a dying unit of its side, or an explosion the engine
// names nobody for) or an ally's weapon. Only a capture that records causes
// can say; reclaims and self-destructs are owner removals and never reach
// here as losses.
func (p *pass) ownFire(i int) bool {
	if !p.hasCauses || i >= len(p.deathWeapon) {
		return false
	}
	vs := p.ro.side(p.out.Deaths.Team[i])
	if k := p.deathKiller[i]; k >= 0 {
		return p.ro.side(k) == vs && p.deathKillerUnit[i] != p.deathUnit[i]
	}
	return p.deathWeapon[i] >= 0 // an explosion nobody is named for
}

// battleOwnFire fills each side's Own, OwnDef and Trigger for a battle.
func (p *pass) battleOwnFire(members []int, bt *Battle) {
	if !p.hasCauses {
		return
	}
	d := p.out.Deaths
	type acc struct {
		own    float64
		byDef  map[int32]float64
		first  int32
		killed []int // the side's deaths an enemy was credited with
	}
	sides := make([]acc, len(bt.Lost))
	for s := range sides {
		sides[s] = acc{byDef: map[int32]float64{}, first: -1}
	}
	for _, i := range members {
		s := p.ro.side(d.Team[i])
		if s < 0 || s >= len(sides) {
			continue
		}
		a := &sides[s]
		if p.ownFire(i) {
			a.own += d.Cost[i]
			if k := p.deathKillerKind[i]; k[1] > 0 {
				a.byDef[k[1]] += d.Cost[i]
			}
			if a.first < 0 || d.F[i] < a.first {
				a.first = d.F[i]
			}
		} else if k := p.deathKiller[i]; k >= 0 && p.ro.side(k) != s {
			a.killed = append(a.killed, i)
		}
	}
	for s, a := range sides {
		if a.own <= 0 {
			continue
		}
		l := &bt.Lost[s]
		l.Own = round1(a.own)
		best := 0.0
		for def, m := range a.byDef {
			if m > best || (m == best && def < l.OwnDef) {
				l.OwnDef, best = def, m
			}
		}
		// What set it off: the last enemy kill on this side at most
		// ownTrigger before its first own-side death.
		var trig int = -1
		for _, i := range a.killed {
			if d.F[i] <= a.first && d.F[i] >= a.first-ownTrigger && (trig < 0 || d.F[i] >= d.F[trig]) {
				trig = i
			}
		}
		if trig >= 0 {
			if k := p.deathKillerKind[trig]; k[0] >= 0 {
				l.Trigger = &[2]int32{k[0], k[1]}
				p.usedDef[k[1]] = true
			}
		}
		if l.OwnDef > 0 {
			p.usedDef[l.OwnDef] = true
		}
	}
}

// friendlyFire is the "Friendly fire" award: the living unit that destroyed
// the most metal of ANOTHER team on its own side within friendlyWindow, if
// it is at least friendlyMin. A team's own units killing each other is left
// out (that is a player's own business: a blast, a misplaced D-gun), and so
// is every blast, which is the routine way allies' bases go up together.
func (p *pass) friendlyFire() (Award, bool) {
	if !p.hasCauses {
		return Award{}, false
	}
	d := p.out.Deaths
	deathsOf := p.deathsByUnit()
	byKiller := map[int32][]int{}
	var order []int32
	for i := range d.F {
		if i >= len(p.deathKillerUnit) {
			break
		}
		k := p.deathKiller[i]
		if k < 0 || k == d.Team[i] || d.Cost[i] <= 0 || (i < len(p.wiped) && p.wiped[i]) {
			continue
		}
		if ks := p.ro.side(k); ks < 0 || ks != p.ro.side(d.Team[i]) {
			continue
		}
		ku := p.deathKillerUnit[i]
		if ku < 0 || ku == p.deathUnit[i] || p.killerDying(i, deathsOf) {
			continue
		}
		if _, ok := byKiller[ku]; !ok {
			order = append(order, ku)
		}
		byKiller[ku] = append(byKiller[ku], i)
	}
	best, bestLo, bestHi := 0.0, 0, 0
	var bestKiller int32 = -1
	for _, ku := range order {
		idx := byKiller[ku]
		sum, lo := 0.0, 0
		for hi, i := range idx {
			sum += d.Cost[i]
			for d.F[i]-d.F[idx[lo]] > friendlyWindow {
				sum -= d.Cost[idx[lo]]
				lo++
			}
			if sum > best {
				best, bestKiller, bestLo, bestHi = sum, ku, lo, hi
			}
		}
	}
	if bestKiller < 0 || best < friendlyMin {
		return Award{}, false
	}
	idx := byKiller[bestKiller][bestLo : bestHi+1]
	worst := idx[0]
	victims := map[int32]float64{}
	for _, i := range idx {
		if d.Cost[i] > d.Cost[worst] {
			worst = i
		}
		victims[d.Team[i]] += d.Cost[i]
	}
	victim, most := int32(-1), 0.0
	for t, m := range victims {
		if m > most || (m == most && t < victim) {
			victim, most = t, m
		}
	}
	kind := p.deathKillerKind[worst]
	name := p.teamName(victim)
	f0, f1 := d.F[idx[0]], d.F[idx[len(idx)-1]]
	when := "at " + clock(f0)
	if secs := (f1 - f0) / simFPS; secs >= 1 {
		when = fmt.Sprintf("in %d s from %s", secs, clock(f0))
	}
	p.usedDef[kind[1]] = true
	p.usedDef[d.Def[worst]] = true
	var pos *[2]int32
	if d.X[worst] >= 0 {
		pos = &[2]int32{d.X[worst], d.Z[worst]}
	}
	return Award{Key: "friendly", Label: "Friendly fire",
		Text: fmt.Sprintf("destroyed %s metal of %s's units %s", metal(best), name, when),
		Team: kind[0], Def: kind[1], Value: round1(best), F: d.F[worst], F0: f0, F1: f1, Pos: pos}, true
}

// teamName is a team's player, or "Team N".
func (p *pass) teamName(team int32) string {
	for _, t := range p.out.Teams {
		if t.Team == team && t.Player != "" {
			return t.Player
		}
	}
	return fmt.Sprintf("Team %d", team)
}
