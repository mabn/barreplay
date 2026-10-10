package insights

import (
	"fmt"
	"math"
	"sort"

	"github.com/mabn/barreplay/snapshot"
)

// The map stories: where each army stood over time (the front), where the
// fighting happened (battles), and the awards — all from positions, health
// and lifecycle events. No capture records who killed what, so nothing here
// names a killer: a battle says what each side lost, and an award goes to a
// unit for something it did or survived.

// Battle is a cluster of deaths close in space and time.
type Battle struct {
	F0 int32 `json:"f0"` // first death
	F1 int32 `json:"f1"` // last death
	X  int32 `json:"x"`  // centre of the deaths
	Z  int32 `json:"z"`
	R  int32 `json:"r"` // radius holding them, elmos
	// Lost is what each side lost there, indexed like Insights.Sides.
	Lost []BattleLoss `json:"lost"`
	// Teams is who took part: every team with army there or losses there,
	// in team order. It is what lets a story name the players who fought a
	// battle rather than only their sides. Version 4 and later.
	Teams []BattleTeam `json:"teams"`
}

// BattleTeam is one team's part in a battle, in metal.
type BattleTeam struct {
	Team int32 `json:"team"`
	// Army is the most army metal (armed, mobile, by build progress) the team
	// had within reach of the battle at any sample during it.
	Army float64 `json:"army"`
	// Lost is the metal of the team's units that died in the battle.
	Lost float64 `json:"lost"`
}

// presence is one sample of where every side's army stood, kept once per
// step so a battle can ask who had units at it.
type presence struct {
	f     int32
	units []presentUnit
}

type presentUnit struct {
	team int32
	x, z float32
	v    float32
}

// battleReach is how far beyond the deaths' own radius an army still counts
// as fighting a battle: artillery and long-range units stand back from what
// they kill.
const battleReach = 600.0

type BattleLoss struct {
	N     int     `json:"n"`
	Metal float64 `json:"metal"`
	// Top is the costliest defs lost, by total metal, at most battleTopDefs.
	Top []int32 `json:"top"`
}

// Award goes to one unit.
type Award struct {
	Key   string  `json:"key"`
	Label string  `json:"label"`
	Text  string  `json:"text"` // what it was for, in words with the value
	Team  int32   `json:"team"`
	Def   int32   `json:"def"`
	Value float64 `json:"value"`
	F     int32   `json:"f"` // the moment to watch
}

const (
	battleRadius    = 1500.0                   // elmos from a battle's centre that still join it
	battleCell      = 500.0                    // elmos per side of a heat-grid cell
	battleBin       = 10                       // seconds per heat bin
	battleFade      = 0.2                      // share of its peak rate a battle runs down to
	battleMaxSec    = 300                      // longest a battle runs, seconds
	battleUnpriced  = 25.0                     // metal a death with no recorded cost weighs
	battleArmyFloor = 3000.0                   // smallest army total a fight is measured against
	battleMinN      = 6                        // deaths for a peak to count as a battle
	battleMaxN      = 12                       // battles kept (the biggest, then in time order)
	battleTopDefs   = 3                        // costliest defs listed per side
	tourGrid        = 32                       // cells per axis of the Tourist's map grid
	tourMinCells    = tourGrid * tourGrid / 20 // 5% of the map, or no Tourist
	closeCallMin    = 0.0                      // health fraction must be above this (alive)
	immortalMinS    = 5 * 60 * simFPS          // frames an Immortal must have lived
)

// track follows one unit across samples, for the awards.
type track struct {
	def      int32
	team     int32
	first    int32
	last     int32
	x, z     float32
	path     float64
	cells    [tourGrid * tourGrid / 64]uint64
	minHP    float64 // lowest sampled health fraction
	minHPF   int32
	dead     bool
	army     bool // Immortal (a commander outliving the game is no feat)
	eligible bool // army or commander: Close call
	ground   bool // mobile and not flying: Marathon, Tourist
}

// trackUnit updates a unit's track with one sample.
func (p *pass) trackUnit(fr int32, u snapshot.UnitState, d defInfo) {
	if d.structure {
		return
	}
	t := p.tracks[u.UnitID]
	if t == nil || t.def != u.DefID || t.dead {
		// Unit ids are recycled once a unit is gone: a new def, or an id seen
		// again after its death, is a new unit.
		t = &track{def: u.DefID, team: u.Team, first: fr, x: u.Pos.X, z: u.Pos.Z, minHP: 2,
			army: d.army, eligible: d.army || d.commander, ground: !d.fly}
		p.tracks[u.UnitID] = t
		p.allTracks = append(p.allTracks, t)
	} else {
		t.path += math.Hypot(float64(u.Pos.X-t.x), float64(u.Pos.Z-t.z))
		t.x, t.z = u.Pos.X, u.Pos.Z
	}
	t.last = fr
	t.team = u.Team // a resign gives units to an ally
	if c, ok := p.cell(u.Pos.X, u.Pos.Z); ok {
		t.cells[c/64] |= 1 << (c % 64)
	}
	if u.MaxHealth > 0 && u.BuildProgress >= 1 {
		if hp := float64(u.Health) / float64(u.MaxHealth); hp < t.minHP && hp > closeCallMin {
			t.minHP, t.minHPF = hp, fr
		}
	}
}

// cell is the Tourist grid cell of a position, over the capture's bounds.
func (p *pass) cell(x, z float32) (uint, bool) {
	b := p.in.Bounds
	if b == nil || b.MaxX <= b.MinX || b.MaxZ <= b.MinZ {
		return 0, false
	}
	cx := int((float64(x) - b.MinX) / (b.MaxX - b.MinX) * tourGrid)
	cz := int((float64(z) - b.MinZ) / (b.MaxZ - b.MinZ) * tourGrid)
	cx = max(0, min(tourGrid-1, cx))
	cz = max(0, min(tourGrid-1, cz))
	return uint(cz*tourGrid + cx), true
}

func (t *track) cellCount() int {
	n := 0
	for _, w := range t.cells {
		for ; w != 0; w &= w - 1 {
			n++
		}
	}
	return n
}

// battles finds the most intense fights. Deaths are not clustered by gaps of
// quiet any more: on a front line held all game there is never 45 seconds
// without a death, and in a real 58-minute 8v8 that rule merged each front
// into one "battle" running from 10:00 to 55:47. A battle is instead a PEAK:
//
//  1. Bin the deaths (minus the ones that went down with their team) into
//     battleBin of time by battleCell of map, each weighted by its metal.
//  2. The seed is the hottest spot holding at least battleMinN deaths: the
//     most metal lost within battleRadius over three bins (half a minute),
//     as a share of both armies' value at the time. Raw metal would hand
//     every battle to the last twenty minutes, where one experimental costs
//     more than an early army; what a fight cost the armies that had to pay
//     for it is what makes it matter.
//  3. From the seed's cost-weighted centre, the battle runs for as long as
//     the loss rate within battleRadius stays above battleFade of its peak
//     (one quiet bin is bridged), capped at battleMaxSec.
//  4. Its deaths are taken out and the next peak is found, until battleMaxN
//     battles or a peak under battleMinN deaths.
//
// So every battle is a bounded episode at one place, the biggest first, and
// they are listed in time order.
func (p *pass) battles() []Battle {
	d := p.out.Deaths
	b := p.out.Bounds
	binF := int32(battleBin * simFPS)
	nx := int((b.MaxX-b.MinX)/battleCell) + 1
	nz := int((b.MaxZ-b.MinZ)/battleCell) + 1
	nt := int(p.lastFrame/binF) + 1
	if nx < 1 || nz < 1 || nx*nz > 1<<16 {
		return []Battle{}
	}
	weight := func(i int) float64 { return math.Max(d.Cost[i], battleUnpriced) }
	cellX := func(i int) int { return max(0, min(nx-1, int((float64(d.X[i])-b.MinX)/battleCell))) }
	cellZ := func(i int) int { return max(0, min(nz-1, int((float64(d.Z[i])-b.MinZ)/battleCell))) }
	byBin := make([][]int, nt)
	for i := range d.F {
		if d.X[i] < 0 || (i < len(p.wiped) && p.wiped[i]) {
			continue
		}
		t := int(d.F[i] / binF)
		if t >= nt {
			t = nt - 1
		}
		byBin[t] = append(byBin[t], i)
	}
	taken := make([]bool, len(d.F))
	// The seed square's half-width in cells: inside the circle a battle then
	// collects, so a seed cannot stand on deaths the battle would not take.
	rc := int(math.Round(battleRadius / 2 / battleCell))
	// Per bin, prefix sums of weight and count over the grid.
	w1 := nx + 1
	plane := w1 * (nz + 1)
	sumW := make([]float64, nt*plane)
	sumN := make([]int32, nt*plane)
	build := func() {
		clear(sumW)
		clear(sumN)
		for t, list := range byBin {
			o := t * plane
			for _, i := range list {
				if taken[i] {
					continue
				}
				k := o + (cellZ(i)+1)*w1 + cellX(i) + 1
				sumW[k] += weight(i)
				sumN[k]++
			}
			for z := 1; z <= nz; z++ {
				for x := 1; x <= nx; x++ {
					k := o + z*w1 + x
					sumW[k] += sumW[k-1] + sumW[k-w1] - sumW[k-w1-1]
					sumN[k] += sumN[k-1] + sumN[k-w1] - sumN[k-w1-1]
				}
			}
		}
	}
	box := func(t, cx, cz int) (float64, int32) {
		if t < 0 || t >= nt {
			return 0, 0
		}
		x0, x1 := max(0, cx-rc), min(nx, cx+rc+1)
		z0, z1 := max(0, cz-rc), min(nz, cz+rc+1)
		o := t * plane
		a, bb, c, dd := o+z1*w1+x1, o+z0*w1+x1, o+z1*w1+x0, o+z0*w1+x0
		return sumW[a] - sumW[bb] - sumW[c] + sumW[dd], sumN[a] - sumN[bb] - sumN[c] + sumN[dd]
	}
	near := func(i int, cx, cz float64) bool {
		return math.Hypot(float64(d.X[i])-cx, float64(d.Z[i])-cz) <= battleRadius
	}
	rate := func(t int, cx, cz float64) float64 {
		if t < 0 || t >= nt {
			return 0
		}
		r := 0.0
		for _, i := range byBin[t] {
			if !taken[i] && near(i, cx, cz) {
				r += weight(i)
			}
		}
		return r
	}
	// Both armies' value per bin, from the army series.
	armies := make([]float64, nt)
	for t := range armies {
		step := min(stepOf(int32(t)*binF+binF/2), len(p.out.Series.T)-1)
		for side := range p.ro.sides {
			if step >= 0 && step < len(p.out.Series.Army[side]) {
				armies[t] += p.out.Series.Army[side][step]
			}
		}
		armies[t] = math.Max(armies[t], battleArmyFloor)
	}
	ns := len(p.ro.sides)
	maxBins := battleMaxSec / battleBin
	var found []foundBattle
	for tries := 0; len(found) < battleMaxN && tries < 4*battleMaxN; tries++ {
		build()
		bestW, bestT, bestX, bestZ := 0.0, -1, 0, 0
		for t := 0; t < nt; t++ {
			for cz := 0; cz < nz; cz++ {
				for cx := 0; cx < nx; cx++ {
					var w float64
					var n int32
					for dt := -1; dt <= 1; dt++ {
						ww, nn := box(t+dt, cx, cz)
						w += ww
						n += nn
					}
					if n < battleMinN {
						continue
					}
					if w /= armies[t]; w > bestW {
						bestW, bestT, bestX, bestZ = w, t, cx, cz
					}
				}
			}
		}
		if bestT < 0 {
			break
		}
		// The seed's cost-weighted centre.
		var sx, sz, sw float64
		for t := bestT - 1; t <= bestT+1; t++ {
			if t < 0 || t >= nt {
				continue
			}
			for _, i := range byBin[t] {
				if taken[i] || abs(cellX(i)-bestX) > rc || abs(cellZ(i)-bestZ) > rc {
					continue
				}
				w := weight(i)
				sx += float64(d.X[i]) * w
				sz += float64(d.Z[i]) * w
				sw += w
			}
		}
		cx, cz := sx/sw, sz/sw
		// Grow from the seed's busiest bin while the rate holds.
		t0 := bestT
		peak := rate(bestT, cx, cz)
		for _, t := range []int{bestT - 1, bestT + 1} {
			if r := rate(t, cx, cz); r > peak {
				peak, t0 = r, t
			}
		}
		t1 := t0
		thr := battleFade * peak
		holds := func(t int) bool { return rate(t, cx, cz) >= thr }
		for t1-t0+1 < maxBins {
			if holds(t1 + 1) {
				t1++
			} else if t1-t0+2 < maxBins && holds(t1+2) {
				t1 += 2 // bridge one quiet bin
			} else {
				break
			}
		}
		for t1-t0+1 < maxBins {
			if holds(t0 - 1) {
				t0--
			} else if t1-t0+2 < maxBins && holds(t0-2) {
				t0 -= 2
			} else {
				break
			}
		}
		var members []int
		for t := max(0, t0); t <= min(nt-1, t1); t++ {
			for _, i := range byBin[t] {
				if !taken[i] && near(i, cx, cz) {
					members = append(members, i)
					taken[i] = true
				}
			}
		}
		if len(members) < battleMinN {
			// The seed's deaths were spread past the circle: retire them,
			// or the same seed would be found again.
			for t := max(0, bestT-1); t <= min(nt-1, bestT+1); t++ {
				for _, i := range byBin[t] {
					if abs(cellX(i)-bestX) <= rc && abs(cellZ(i)-bestZ) <= rc {
						taken[i] = true
					}
				}
			}
			continue
		}
		// A peak that picks up where a battle left off, at the same place, is
		// that battle's next phase rather than a new one.
		nb := p.battleOf(members, ns)
		merged := false
		for k := range found {
			o := &found[k]
			if nb.F0-o.b.F1 <= binF && o.b.F0-nb.F1 <= binF &&
				math.Hypot(float64(nb.X-o.b.X), float64(nb.Z-o.b.Z)) <= battleRadius {
				o.members = append(o.members, members...)
				o.b = p.battleOf(o.members, ns)
				merged = true
				break
			}
		}
		if !merged {
			found = append(found, foundBattle{b: nb, members: members})
		}
	}
	out := make([]Battle, len(found))
	for k, f := range found {
		out[k] = f.b
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].F0 < out[j].F0 })
	return out
}

// foundBattle is a battle and the deaths it holds, while battles are found.
type foundBattle struct {
	b       Battle
	members []int
}

// battleOf sums one battle's deaths: when, where, and what each side lost.
func (p *pass) battleOf(members []int, ns int) Battle {
	d := p.out.Deaths
	bt := Battle{F0: math.MaxInt32, Lost: make([]BattleLoss, ns)}
	top := make([]map[int32]float64, ns)
	for s := range top {
		top[s] = map[int32]float64{}
	}
	var sx, sz, sw float64
	for _, i := range members {
		bt.F0 = min(bt.F0, d.F[i])
		bt.F1 = max(bt.F1, d.F[i])
		w := math.Max(d.Cost[i], battleUnpriced)
		sx += float64(d.X[i]) * w
		sz += float64(d.Z[i]) * w
		sw += w
		if side := p.ro.side(d.Team[i]); side >= 0 {
			l := &bt.Lost[side]
			l.N++
			l.Metal += d.Cost[i]
			top[side][d.Def[i]] += d.Cost[i]
		}
	}
	cx, cz := sx/sw, sz/sw
	r := 0.0
	for _, i := range members {
		r = math.Max(r, math.Hypot(float64(d.X[i])-cx, float64(d.Z[i])-cz))
	}
	bt.X, bt.Z, bt.R = int32(cx), int32(cz), int32(r)
	bt.Teams = p.battleTeams(members, bt)
	for s := range bt.Lost {
		bt.Lost[s].Metal = round1(bt.Lost[s].Metal)
		bt.Lost[s].Top = topDefs(top[s])
	}
	return bt
}

// battleTeams says which teams fought a battle and with how much: each
// team's largest army within reach of it at any sample from a step before
// it to its end, and what the team lost in it.
func (p *pass) battleTeams(members []int, bt Battle) []BattleTeam {
	d := p.out.Deaths
	lost := map[int32]float64{}
	for _, i := range members {
		lost[d.Team[i]] += d.Cost[i]
	}
	army := map[int32]float64{}
	reach := float64(bt.R) + battleReach
	from := bt.F0 - StepSec*simFPS
	for _, s := range p.presence {
		if s.f < from || s.f > bt.F1 {
			continue
		}
		here := map[int32]float64{}
		for _, u := range s.units {
			if math.Hypot(float64(u.x)-float64(bt.X), float64(u.z)-float64(bt.Z)) <= reach {
				here[u.team] += float64(u.v)
			}
		}
		for t, v := range here {
			army[t] = math.Max(army[t], v)
		}
	}
	teams := map[int32]bool{}
	for t := range lost {
		teams[t] = true
	}
	for t := range army {
		teams[t] = true
	}
	out := make([]BattleTeam, 0, len(teams))
	for t := range teams {
		if p.ro.side(t) < 0 {
			continue
		}
		out = append(out, BattleTeam{Team: t, Army: round1(army[t]), Lost: round1(lost[t])})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Team < out[j].Team })
	return out
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func topDefs(m map[int32]float64) []int32 {
	ids := make([]int32, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		if m[ids[i]] != m[ids[j]] {
			return m[ids[i]] > m[ids[j]]
		}
		return ids[i] < ids[j]
	})
	if len(ids) > battleTopDefs {
		ids = ids[:battleTopDefs]
	}
	return ids
}

// awards picks the six awards a replay can support without knowing who
// killed what. Ties go to the earlier unit, so the result is deterministic.
func (p *pass) awards() []Award {
	out := []Award{}
	end := p.lastFrame
	alive := func(t *track) bool { return !t.dead && t.last == end }
	pick := func(better func(a, b *track) bool, ok func(t *track) bool) *track {
		var best *track
		for _, t := range p.allTracks {
			if ok(t) && (best == nil || better(t, best)) {
				best = t
			}
		}
		return best
	}
	add := func(t *track, key, label, text string, value float64, f int32) {
		p.usedDef[t.def] = true
		out = append(out, Award{Key: key, Label: label, Text: text, Team: t.team, Def: t.def, Value: round1(value), F: f})
	}

	if t := pick(func(a, b *track) bool { return a.first < b.first },
		func(t *track) bool { return t.army && alive(t) && end-t.first >= immortalMinS }); t != nil {
		sec := float64(end-t.first) / simFPS
		add(t, "immortal", "Immortal", "fought from "+clock(t.first)+" to the end and survived", sec, t.first)
	}
	if t := pick(func(a, b *track) bool { return a.path > b.path }, func(t *track) bool { return t.ground && t.path > 0 }); t != nil {
		add(t, "marathon", "Marathon", "travelled "+distance(t.path), t.path, t.last)
	}
	if t := pick(func(a, b *track) bool { return a.cellCount() > b.cellCount() }, func(t *track) bool { return t.ground && t.cellCount() >= tourMinCells }); t != nil {
		n := t.cellCount()
		pct := 100 * float64(n) / (tourGrid * tourGrid)
		add(t, "tourist", "Tourist", fmt.Sprintf("visited %.0f%% of the map", pct), pct, t.last)
	}
	if t := pick(func(a, b *track) bool { return a.minHP < b.minHP }, func(t *track) bool { return t.eligible && alive(t) && t.minHP < 0.25 }); t != nil {
		add(t, "closecall", "Close call", fmt.Sprintf("survived at %.0f%% health", math.Ceil(t.minHP*100)), t.minHP*100, t.minHPF)
	}

	d := p.out.Deaths
	best, bestUnf := -1, -1
	for i := range d.F {
		// A unit that went down with its team was not lost in the game.
		if d.Cost[i] <= 0 || p.wiped[i] {
			continue
		}
		if d.Unfinished[i] == 1 {
			if bestUnf < 0 || d.Cost[i] > d.Cost[bestUnf] {
				bestUnf = i
			}
		} else if best < 0 || d.Cost[i] > d.Cost[best] {
			// Finished units only: the costliest unfinished loss already
			// has its own award, and one unit should not take two.
			best = i
		}
	}
	if bestUnf >= 0 {
		out = append(out, Award{Key: "unfinished", Label: "Unfinished business",
			Text: "destroyed before it was finished, " + metal(d.Cost[bestUnf]) + " metal",
			Team: d.Team[bestUnf], Def: d.Def[bestUnf], Value: d.Cost[bestUnf], F: d.F[bestUnf]})
	}
	if best >= 0 {
		out = append(out, Award{Key: "costliest", Label: "Most expensive loss",
			Text: "lost at " + clock(d.F[best]) + ", " + metal(d.Cost[best]) + " metal",
			Team: d.Team[best], Def: d.Def[best], Value: d.Cost[best], F: d.F[best]})
	}
	return out
}

// recordFront stores each side's army centre at this step: the cost-weighted
// mean position of its army units at the step's last sample.
func (p *pass) recordFront(step int, sum [][3]float64) {
	for side := range p.ro.sides {
		for len(p.out.Series.Front[side]) <= step {
			p.out.Series.Front[side] = append(p.out.Series.Front[side], nil)
		}
		if w := sum[side][2]; w > 0 {
			p.out.Series.Front[side][step] = []int32{int32(sum[side][0] / w), int32(sum[side][1] / w)}
		} else {
			p.out.Series.Front[side][step] = nil
		}
	}
}

func clock(f int32) string {
	sec := int(f / simFPS)
	return fmt.Sprintf("%d:%02d", sec/60, sec%60)
}

// distance renders a path length in elmos, BAR's world unit (a tank is
// ~40 long), compacted past a thousand.
func distance(elmos float64) string {
	if elmos >= 1000 {
		return fmt.Sprintf("%.1fk elmos", elmos/1000)
	}
	return fmt.Sprintf("%.0f elmos", elmos)
}

func metal(v float64) string {
	if v >= 1000 {
		return fmt.Sprintf("%.1fk", v/1000)
	}
	return fmt.Sprintf("%.0f", v)
}
