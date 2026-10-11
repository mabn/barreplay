package insights

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/mabn/barreplay/snapshot"
)

// The map stories: where each army stood over time (the front), where the
// fighting happened (battles), and the awards — all from positions, health
// and lifecycle events. A battle says what each side lost and, when the
// capture names killers (a re-simulation), which teams did the killing from
// wherever they fired; an award goes to a unit for something it did or
// survived.

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
	// Killed is the metal of enemy units the engine credited to the team in
	// the battle, wherever it fired from (a long-range gun, a nuke), so a
	// team shooting into the fight from afar still counts as fighting in it.
	Killed float64 `json:"killed"`
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
	// Worth is what the losses decide a battle by: their metal, with power
	// plants at powerWorth times theirs (losing a fusion loses its output
	// too). Version 7 and later.
	Worth float64 `json:"worth"`
	// Top is the costliest defs lost, by total metal, at most battleTopDefs.
	Top []int32 `json:"top"`
	// Units is every def lost with its count and metal, costliest first, at
	// most battleUnitDefs: what the page draws as icons.
	Units []UnitLoss `json:"units,omitempty"`
}

// UnitLoss is how many of one def a side lost in a battle, and their metal.
type UnitLoss struct {
	Def   int32   `json:"def"`
	N     int     `json:"n"`
	Metal float64 `json:"metal"`
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
	// Unit, F0/F1 and Path are set for an award that goes to a unit's whole
	// life rather than to a death (Version 4): the unit id the viewer follows,
	// the life's first and last sampled frame, and where it went — [frame, x,
	// z] every pathEvery, at most pathMaxPts — so the page can show WHICH
	// unit it was and where it went instead of a moment and a guess.
	Unit int32      `json:"unit,omitempty"`
	F0   int32      `json:"f0,omitempty"`
	F1   int32      `json:"f1,omitempty"`
	Path [][3]int32 `json:"path,omitempty"`
}

const (
	battleRadius       = 1500.0                   // elmos from a battle's centre that still join it
	battleCell         = 500.0                    // elmos per side of a heat-grid cell
	battleBin          = 10                       // seconds per heat bin
	battleFade         = 0.2                      // share of its peak rate a battle runs down to
	battleMaxSec       = 300                      // longest a battle runs, seconds
	battleUnpriced     = 25.0                     // metal a death with no recorded cost weighs
	battleArmyFloor    = 3000.0                   // smallest army total a fight is measured against
	battleMinN         = 6                        // deaths for a peak to count as a battle
	battleMaxN         = 24                       // battles kept (the biggest, then in time order)
	battleAdvanceGap   = 60                       // seconds between a battle's end and the next start of the same force's push
	battleAdvanceShare = 0.3                      // share of the metal killed by units killing in both
	battleTopDefs      = 3                        // costliest defs listed per side
	blowWindow         = 30 * simFPS              // frames the Biggest blow's losses fall within
	battleUnitDefs     = 48                       // defs a battle's unit list carries per side
	tourGrid           = 32                       // cells per axis of the Tourist's map grid
	tourMinCells       = tourGrid * tourGrid / 20 // 5% of the map, or no Tourist
	closeCallMin       = 0.0                      // health fraction must be above this (alive)
	closeCallCost      = 400.0                    // metal a Close call must cost (a fighter at 6% is no story)
	immortalMaxHP      = 0.3                      // health fraction an Immortal must have fallen to
	immortalKillX      = 3.0                      // metal killed after that, in multiples of its own cost
	immortalMinKill    = 1500.0                   // and at least this much metal
	healedMin          = 1.0                      // own health a Most healed unit must have been repaired
	pressureBin        = 30 * simFPS              // window Most healed's busiest moment is found in
	pathEvery          = 5 * simFPS               // frames between recorded path points
	pathMaxPts         = 400                      // path points an award carries at most
)

// pathPt is one recorded position of a unit's life.
type pathPt struct {
	f    int32
	x, z float32
}

// track follows one unit across samples, for the awards.
type track struct {
	id     int32
	def    int32
	team   int32
	first  int32
	last   int32
	x, z   float32
	path   float64
	cells  [tourGrid * tourGrid / 64]uint64
	minHP  float64 // lowest sampled health fraction
	minHPF int32
	pts    []pathPt
	prevHP float32
	maxHP  float32
	hurt   bool  // its health has fallen between two samples
	hurtF  int32 // the last sample where it had
	// What it repaired while finished, in hp: health rises between samples
	// (damage in between hides some, so it is a floor), and the busiest
	// pressureBin of it, for Most healed.
	healed   float64
	hbin     int32
	hbinSum  float64
	hbinF    int32
	hpeak    float64
	hpeakF   int32
	cost     float64
	kills    []kill // enemies the engine credited to it, in frame order
	dead     bool
	army     bool // Immortal (a commander outliving the game is no feat)
	eligible bool // army or commander: Close call
	ground   bool // mobile and not flying: Marathon, Tourist
	carried  bool // a transport seen carrying a unit (transports.go)
}

// kill is one enemy a tracked unit was credited with.
type kill struct {
	f     int32
	metal float64
}

// killedAfter is the metal of the kills credited to the unit after frame f.
func (t *track) killedAfter(f int32) float64 {
	sum := 0.0
	for _, k := range t.kills {
		if k.f > f {
			sum += k.metal
		}
	}
	return sum
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
		t = &track{id: u.UnitID, def: u.DefID, team: u.Team, first: fr, x: u.Pos.X, z: u.Pos.Z, minHP: 2,
			army: d.army, eligible: d.army || d.commander, ground: !d.fly, prevHP: -1, hbin: -1, cost: d.cost}
		if d.commander {
			t.cost = math.Max(t.cost, closeCallCost) // a commander is never cheap
		}
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
	if n := len(t.pts); n == 0 || fr-t.pts[n-1].f >= pathEvery {
		t.pts = append(t.pts, pathPt{fr, u.Pos.X, u.Pos.Z})
	}
	if u.MaxHealth > 0 && u.BuildProgress >= 1 {
		if hp := float64(u.Health) / float64(u.MaxHealth); hp < t.minHP && hp > closeCallMin {
			t.minHP, t.minHPF = hp, fr
		}
		t.maxHP = u.MaxHealth
		if t.prevHP >= 0 && u.Health > t.prevHP {
			rise := float64(u.Health - t.prevHP)
			t.healed += rise
			if b := fr / pressureBin; b != t.hbin {
				t.hbin, t.hbinSum, t.hbinF = b, 0, fr
			}
			t.hbinSum += rise
			if t.hbinSum > t.hpeak {
				t.hpeak, t.hpeakF = t.hbinSum, t.hbinF
			}
		}
		if t.prevHP >= 0 && u.Health < t.prevHP {
			t.hurt, t.hurtF = true, fr
		}
		t.prevHP = u.Health
	}
}

// route is the track's recorded positions, ending where it was last seen,
// thinned evenly to at most pathMaxPts.
func (t *track) route() [][3]int32 {
	pts := t.pts
	if n := len(pts); n == 0 || pts[n-1].f != t.last {
		pts = append(pts[:n:n], pathPt{t.last, t.x, t.z})
	}
	step := (len(pts) + pathMaxPts - 1) / pathMaxPts
	out := make([][3]int32, 0, len(pts)/step+1)
	for i := 0; i < len(pts); i += step {
		out = append(out, [3]int32{pts[i].f, int32(math.Round(float64(pts[i].x))), int32(math.Round(float64(pts[i].z)))})
	}
	if last := pts[len(pts)-1]; out[len(out)-1][0] != last.f {
		out = append(out, [3]int32{last.f, int32(math.Round(float64(last.x))), int32(math.Round(float64(last.z)))})
	}
	return out
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
	found = p.mergeAdvances(found, ns)
	out := make([]Battle, len(found))
	for k, f := range found {
		out[k] = f.b
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].F0 < out[j].F0 })
	return out
}

// mergeAdvances joins a battle to the one before it when it is the same
// force pushing on: it starts within battleAdvanceGap of the other's end,
// near enough (their radii plus battleRadius apart at most), and at least
// battleAdvanceShare of the metal killed in either was killed by units that
// also killed in the other. A raid that wins a fight and walks on into the
// base behind it is one battle that lasts longer, not two; two fights next
// to each other share no killers. Only a capture that names killers (a
// re-simulation) can tell, so nothing else is merged this way.
func (p *pass) mergeAdvances(found []foundBattle, ns int) []foundBattle {
	if !p.hasCauses {
		return found
	}
	d := p.out.Deaths
	killers := func(f foundBattle) (map[[2]int32]float64, float64) {
		by := map[[2]int32]float64{}
		total := 0.0
		for _, i := range f.members {
			if k := p.deathKillerKind[i]; k[0] >= 0 {
				by[k] += d.Cost[i]
				total += d.Cost[i]
			}
		}
		return by, total
	}
	shared := func(a, b map[[2]int32]float64, total float64) float64 {
		if total <= 0 {
			return 0
		}
		s := 0.0
		for k, v := range a {
			if b[k] > 0 {
				s += v
			}
		}
		return s / total
	}
	gap := int32(battleAdvanceGap * simFPS)
	for merged := true; merged; {
		merged = false
		sort.SliceStable(found, func(i, j int) bool { return found[i].b.F0 < found[j].b.F0 })
		for i := 0; i < len(found) && !merged; i++ {
			a := found[i]
			ka, ta := killers(a)
			for j := i + 1; j < len(found); j++ {
				b := found[j]
				if b.b.F0-a.b.F1 > gap || b.b.F1 < a.b.F1 {
					continue
				}
				if math.Hypot(float64(b.b.X-a.b.X), float64(b.b.Z-a.b.Z)) > float64(a.b.R+b.b.R)+battleRadius {
					continue
				}
				kb, tb := killers(b)
				if shared(ka, kb, ta) < battleAdvanceShare && shared(kb, ka, tb) < battleAdvanceShare {
					continue
				}
				members := append(append([]int{}, a.members...), b.members...)
				found[i] = foundBattle{b: p.battleOf(members, ns), members: members}
				found = append(found[:j], found[j+1:]...)
				merged = true
				break
			}
		}
	}
	return found
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
	count := make([]map[int32]int, ns)
	for s := range top {
		top[s] = map[int32]float64{}
		count[s] = map[int32]int{}
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
			l.Worth += d.Cost[i] * p.defs[d.Def[i]].worth
			top[side][d.Def[i]] += d.Cost[i]
			count[side][d.Def[i]]++
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
		bt.Lost[s].Worth = round1(bt.Lost[s].Worth)
		bt.Lost[s].Top = topDefs(top[s])
		bt.Lost[s].Units = unitLosses(top[s], count[s])
	}
	return bt
}

// battleTeams says which teams fought a battle and with how much: each
// team's largest army within reach of it at any sample from a step before
// it to its end, and what the team lost in it.
func (p *pass) battleTeams(members []int, bt Battle) []BattleTeam {
	d := p.out.Deaths
	lost := map[int32]float64{}
	killed := map[int32]float64{}
	for _, i := range members {
		lost[d.Team[i]] += d.Cost[i]
		// Whoever killed it took part, wherever it fired from: a long-range
		// gun, a bomber run or a nuke counts at the target, not at the
		// launcher, which may be across the map.
		if k := p.deathKiller[i]; k >= 0 && p.ro.side(k) >= 0 && p.ro.side(k) != p.ro.side(d.Team[i]) {
			killed[k] += d.Cost[i]
		}
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
	for t := range killed {
		teams[t] = true
	}
	out := make([]BattleTeam, 0, len(teams))
	for t := range teams {
		if p.ro.side(t) < 0 {
			continue
		}
		out = append(out, BattleTeam{Team: t, Army: round1(army[t]), Lost: round1(lost[t]), Killed: round1(killed[t])})
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

// unitLosses lists the defs lost, costliest first (then the most lost, then
// by id, so the result is deterministic), at most battleUnitDefs.
func unitLosses(metal map[int32]float64, n map[int32]int) []UnitLoss {
	out := make([]UnitLoss, 0, len(n))
	for id, k := range n {
		out = append(out, UnitLoss{Def: id, N: k, Metal: round1(metal[id])})
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Metal != b.Metal {
			return a.Metal > b.Metal
		}
		if a.N != b.N {
			return a.N > b.N
		}
		return a.Def < b.Def
	})
	if len(out) > battleUnitDefs {
		out = out[:battleUnitDefs]
	}
	return out
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

// awards picks the seven awards a replay can support without knowing who
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
		out = append(out, Award{Key: key, Label: label, Text: text, Team: t.team, Def: t.def, Value: round1(value), F: f,
			Unit: t.id, F0: t.first, F1: t.last, Path: t.route()})
	}

	// Immortal: a unit that fell to a sliver of its health and then did
	// something unusual — credited with enemies worth several times its own
	// cost after that moment — and lived. Taking damage and surviving is what
	// most of an army does; a Gladiator at 24% that kills 366 metal more is
	// any unit's day. Only a capture that names killers can tell, so there is
	// no Immortal without causes, and most games have none.
	killedAfterLow := func(t *track) float64 { return t.killedAfter(t.minHPF) }
	if p.hasCauses {
		if t := pick(func(a, b *track) bool {
			return killedAfterLow(a)/math.Max(a.cost, 1) > killedAfterLow(b)/math.Max(b.cost, 1)
		},
			func(t *track) bool {
				k := killedAfterLow(t)
				return t.army && alive(t) && t.minHP <= immortalMaxHP && k >= immortalMinKill && k >= immortalKillX*math.Max(t.cost, 1)
			}); t != nil {
			k := killedAfterLow(t)
			add(t, "immortal", "Immortal", fmt.Sprintf("fell to %.0f%% health, then killed %s metal, %.0f× its own cost", math.Ceil(t.minHP*100), metal(k), k/math.Max(t.cost, 1)), k, t.minHPF)
		}
	}
	// Most healed: repaired the most times over its own health — a unit kept
	// in the fight by the builders behind it.
	healedX := func(t *track) float64 {
		if t.maxHP <= 0 {
			return 0
		}
		return t.healed / float64(t.maxHP)
	}
	if t := pick(func(a, b *track) bool { return a.healed > b.healed },
		func(t *track) bool { return t.army && t.cost >= closeCallCost && healedX(t) >= healedMin }); t != nil {
		add(t, "healed", "Most healed", fmt.Sprintf("repaired %.1f× its own health (%s hp)", healedX(t), metal(t.healed)), healedX(t), t.hpeakF)
	}
	if t := pick(func(a, b *track) bool { return a.path > b.path }, func(t *track) bool { return t.ground && t.path > 0 }); t != nil {
		add(t, "marathon", "Marathon", "travelled "+distance(t.path), t.path, t.last)
	}
	if t := pick(func(a, b *track) bool { return a.cellCount() > b.cellCount() }, func(t *track) bool { return t.ground && t.cellCount() >= tourMinCells }); t != nil {
		n := t.cellCount()
		pct := 100 * float64(n) / (tourGrid * tourGrid)
		add(t, "tourist", "Tourist", fmt.Sprintf("visited %.0f%% of the map", pct), pct, t.last)
	}
	if t := pick(func(a, b *track) bool { return a.minHP < b.minHP }, func(t *track) bool { return t.eligible && alive(t) && t.minHP < 0.25 && t.cost >= closeCallCost }); t != nil {
		add(t, "closecall", "Close call", fmt.Sprintf("survived at %.0f%% health", math.Ceil(t.minHP*100)), t.minHP*100, t.minHPF)
	}

	d := p.out.Deaths
	bestUnf := -1
	for i := range d.F {
		// A unit that went down with its team was not lost in the game.
		// A BUILDING destroyed before it was finished: a unit cancelled in
		// its factory refunds its metal and is no story (and is not a loss
		// at all when the capture records causes).
		if d.Cost[i] <= 0 || p.wiped[i] || d.Unfinished[i] != 1 || !p.defs[d.Def[i]].structure {
			continue
		}
		if bestUnf < 0 || d.Cost[i] > d.Cost[bestUnf] {
			bestUnf = i
		}
	}
	if bestUnf >= 0 {
		out = append(out, p.deathAward(bestUnf, Award{Key: "unfinished", Label: "Unfinished business",
			Text: fmt.Sprintf("destroyed %.0f%% built, %s metal in it", 100*d.Cost[bestUnf]/math.Max(p.defs[d.Def[bestUnf]].cost, 1), metal(d.Cost[bestUnf])),
			Team: d.Team[bestUnf], Def: d.Def[bestUnf], Value: d.Cost[bestUnf], F: d.F[bestUnf]}))
	}
	if a, ok := p.biggestBlow(); ok {
		out = append(out, a)
	}
	if a, ok := p.idleTransports(); ok {
		out = append(out, a)
	}
	return out
}

// biggestBlow is the most metal one player lost within blowWindow: a base
// going up, an army caught in the open. One expensive unit dying is no story
// in a game where dozens of them do; losing a fortune at once is. Deaths that
// went down with an eliminated team do not count, and neither does what an
// owner removed (they are not in Deaths). The award's moment is the window's
// costliest death (its def names the card), F0/F1 the window's first and
// last death.
func (p *pass) biggestBlow() (Award, bool) {
	d := p.out.Deaths
	byTeam := map[int32][]int{}
	for i := range d.F {
		if d.Cost[i] > 0 && !p.wiped[i] && p.ro.side(d.Team[i]) >= 0 {
			byTeam[d.Team[i]] = append(byTeam[d.Team[i]], i)
		}
	}
	teams := make([]int32, 0, len(byTeam))
	for t := range byTeam {
		teams = append(teams, t)
	}
	sort.Slice(teams, func(i, j int) bool { return teams[i] < teams[j] })
	bestSum, bestTeam, bestLo, bestHi := 0.0, int32(-1), 0, 0
	for _, t := range teams {
		idx := byTeam[t] // in frame order, like Deaths
		sum, lo := 0.0, 0
		for hi, i := range idx {
			sum += d.Cost[i]
			for d.F[i]-d.F[idx[lo]] > blowWindow {
				sum -= d.Cost[idx[lo]]
				lo++
			}
			// Strictly more: a tie goes to the lower team, then the earlier window.
			if sum > bestSum {
				bestSum, bestTeam, bestLo, bestHi = sum, t, lo, hi
			}
		}
	}
	if bestTeam < 0 {
		return Award{}, false
	}
	idx := byTeam[bestTeam][bestLo : bestHi+1]
	top := map[int32]float64{}
	count := map[int32]int{}
	worst := idx[0]
	for _, i := range idx {
		top[d.Def[i]] += d.Cost[i]
		count[d.Def[i]]++
		if d.Cost[i] > d.Cost[worst] {
			worst = i
		}
	}
	parts := []string{}
	for _, def := range topDefs(top) {
		ud := p.in.Meta.UnitDefs[def]
		name := ud.HumanName
		if name == "" {
			name = ud.Name
		}
		if count[def] > 1 {
			name = fmt.Sprintf("%d %s", count[def], name)
		}
		parts = append(parts, name)
	}
	f0, f1 := d.F[idx[0]], d.F[idx[len(idx)-1]]
	secs := (f1 - f0) / simFPS
	when := fmt.Sprintf("in %d s from %s", secs, clock(f0))
	if secs < 1 {
		when = "at " + clock(f0)
	}
	p.usedDef[d.Def[worst]] = true
	return Award{Key: "blow", Label: "Biggest blow",
		Text: fmt.Sprintf("lost %s metal %s: %s", metal(bestSum), when, strings.Join(parts, ", ")),
		Team: bestTeam, Def: d.Def[worst], Value: round1(bestSum), F: d.F[worst], F0: f0, F1: f1}, true
}

// deathAward names the unit behind death i, so the page can show which one
// it was: its id, and for a mobile unit its life and route.
func (p *pass) deathAward(i int, a Award) Award {
	a.Unit = p.deathUnit[i]
	if t := p.deathTrack[i]; t != nil {
		a.F0, a.F1, a.Path = t.first, t.last, t.route()
	}
	return a
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
