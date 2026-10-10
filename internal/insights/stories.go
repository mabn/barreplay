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
}

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
	battleRadius  = 1500.0                   // elmos from a battle's centre that still join it
	battleGap     = 45 * simFPS              // frames of quiet that end a battle
	battleMinN    = 6                        // deaths for a cluster to count as a battle
	battleMaxN    = 12                       // battles kept (the biggest, then in time order)
	battleTopDefs = 3                        // costliest defs listed per side
	tourGrid      = 32                       // cells per axis of the Tourist's map grid
	tourMinCells  = tourGrid * tourGrid / 20 // 5% of the map, or no Tourist
	closeCallMin  = 0.0                      // health fraction must be above this (alive)
	immortalMinS  = 5 * 60 * simFPS          // frames an Immortal must have lived
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

// battles clusters the death list: a death joins the open battle whose
// centre is within battleRadius and whose last death is under battleGap
// earlier, else it opens a new one.
func (p *pass) battles() []Battle {
	type open struct {
		b      Battle
		sx, sz float64
		n      int
		pts    [][2]float64
		top    []map[int32]float64
		lastF  int32
	}
	ns := len(p.ro.sides)
	var all []*open
	var live []*open
	d := p.out.Deaths
	for i := range d.F {
		if d.X[i] < 0 {
			continue // never sampled: no position
		}
		x, z := float64(d.X[i]), float64(d.Z[i])
		var into *open
		best := battleRadius
		kept := live[:0]
		for _, o := range live {
			if d.F[i]-o.lastF > battleGap {
				continue // closed
			}
			kept = append(kept, o)
			if dist := math.Hypot(x-o.sx/float64(o.n), z-o.sz/float64(o.n)); dist <= best {
				best, into = dist, o
			}
		}
		live = kept
		if into == nil {
			into = &open{b: Battle{F0: d.F[i], Lost: make([]BattleLoss, ns)}, top: make([]map[int32]float64, ns)}
			for s := range into.top {
				into.top[s] = map[int32]float64{}
			}
			live = append(live, into)
			all = append(all, into)
		}
		into.sx += x
		into.sz += z
		into.n++
		into.pts = append(into.pts, [2]float64{x, z})
		into.lastF = d.F[i]
		into.b.F1 = d.F[i]
		if side := p.ro.side(d.Team[i]); side >= 0 {
			l := &into.b.Lost[side]
			l.N++
			l.Metal += d.Cost[i]
			into.top[side][d.Def[i]] += d.Cost[i]
		}
	}
	var out []Battle
	for _, o := range all {
		if o.n < battleMinN {
			continue
		}
		cx, cz := o.sx/float64(o.n), o.sz/float64(o.n)
		r := 0.0
		for _, pt := range o.pts {
			r = math.Max(r, math.Hypot(pt[0]-cx, pt[1]-cz))
		}
		o.b.X, o.b.Z, o.b.R = int32(cx), int32(cz), int32(r)
		for s := range o.b.Lost {
			o.b.Lost[s].Metal = round1(o.b.Lost[s].Metal)
			o.b.Lost[s].Top = topDefs(o.top[s])
		}
		out = append(out, o.b)
	}
	// The biggest by metal lost (then deaths), then back in time order.
	weight := func(b Battle) (float64, int) {
		m, n := 0.0, 0
		for _, l := range b.Lost {
			m += l.Metal
			n += l.N
		}
		return m, n
	}
	sort.SliceStable(out, func(i, j int) bool {
		mi, ni := weight(out[i])
		mj, nj := weight(out[j])
		if mi != mj {
			return mi > mj
		}
		return ni > nj
	})
	if len(out) > battleMaxN {
		out = out[:battleMaxN]
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].F0 < out[j].F0 })
	if out == nil {
		out = []Battle{}
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
		if d.Cost[i] <= 0 {
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
