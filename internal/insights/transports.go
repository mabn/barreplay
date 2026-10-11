package insights

import (
	"fmt"
	"math"
	"regexp"
	"sort"

	"github.com/mabn/barreplay/snapshot"
)

// Idle transports: an award for a fleet of air transports that never carried
// anything — a factory left repeating its last order. The defs carry no
// transport flag (an Abductor's unitGroup is "emp"), so the transports are a
// curated table, like the milestones.
var transportRE = regexp.MustCompile(`^(arm|cor|leg)(atlas|valk|dfly|seah|hvytrans|atrans)(_scav)?$`)

func isTransport(name string) bool { return transportRE.MatchString(name) }

const (
	// A carry is read off positions alone: a ground unit of the transport's
	// team within carryNear of it in two consecutive samples while the
	// transport moved at least carryMove — a unit on the ground does not keep
	// pace with an aircraft overhead.
	carryNear = 32
	carryMove = 64
	carryCell = 64
	// idleMin transports, and idleShare of the player's transports of that
	// def, never carried a unit, or there is no award.
	idleMin   = 5
	idleShare = 0.75
)

// carries marks every transport in the frame that is carrying a unit. It
// compares against the previous sample, so it runs before the frame's units
// are tracked.
type carries struct {
	trans  map[int32][2]float32 // transport id -> previous position
	ground map[int32][2]float32 // ground unit id -> previous position
}

func (p *pass) carryFrame(fr snapshot.Frame) {
	c := &p.carry
	var trans []snapshot.UnitState
	for _, u := range fr.Units {
		if d, ok := p.defs[u.DefID]; ok && d.transport && !dead(u) {
			trans = append(trans, u)
		}
	}
	if len(trans) == 0 && len(c.trans) == 0 {
		return
	}
	cells := map[[2]int32][]snapshot.UnitState{}
	ground := map[int32][2]float32{}
	for _, u := range fr.Units {
		d, ok := p.defs[u.DefID]
		if !ok || d.fly || d.structure || dead(u) {
			continue
		}
		k := [2]int32{int32(u.Pos.X) / carryCell, int32(u.Pos.Z) / carryCell}
		cells[k] = append(cells[k], u)
		ground[u.UnitID] = [2]float32{u.Pos.X, u.Pos.Z}
	}
	now := map[int32][2]float32{}
	for _, u := range trans {
		now[u.UnitID] = [2]float32{u.Pos.X, u.Pos.Z}
		was, ok := c.trans[u.UnitID]
		t := p.tracks[u.UnitID]
		if !ok || t == nil || t.def != u.DefID || t.dead || t.carried || hypot(u.Pos.X-was[0], u.Pos.Z-was[1]) < carryMove {
			continue
		}
		cx, cz := int32(u.Pos.X)/carryCell, int32(u.Pos.Z)/carryCell
	near:
		for dx := int32(-1); dx <= 1; dx++ {
			for dz := int32(-1); dz <= 1; dz++ {
				for _, g := range cells[[2]int32{cx + dx, cz + dz}] {
					if g.Team != u.Team || hypot(g.Pos.X-u.Pos.X, g.Pos.Z-u.Pos.Z) > carryNear {
						continue
					}
					if pg, ok := c.ground[g.UnitID]; ok && hypot(pg[0]-was[0], pg[1]-was[1]) <= carryNear {
						t.carried = true
						break near
					}
				}
			}
		}
	}
	c.trans, c.ground = now, ground
}

func hypot(dx, dz float32) float64 { return math.Hypot(float64(dx), float64(dz)) }

// idleTransports is the player whose transports of one def most often never
// carried a unit, when that is most of the ones they built.
func (p *pass) idleTransports() (Award, bool) {
	type group struct {
		n    int
		idle []*track
	}
	groups := map[[2]int32]*group{}
	for _, t := range p.allTracks {
		if !p.defs[t.def].transport || p.ro.side(t.team) < 0 {
			continue
		}
		k := [2]int32{t.team, t.def}
		g := groups[k]
		if g == nil {
			g = &group{}
			groups[k] = g
		}
		g.n++
		if !t.carried {
			g.idle = append(g.idle, t)
		}
	}
	keys := make([][2]int32, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := groups[keys[i]], groups[keys[j]]
		if len(a.idle) != len(b.idle) {
			return len(a.idle) > len(b.idle)
		}
		if keys[i][0] != keys[j][0] {
			return keys[i][0] < keys[j][0]
		}
		return keys[i][1] < keys[j][1]
	})
	for _, k := range keys {
		g := groups[k]
		if len(g.idle) < idleMin || float64(len(g.idle)) < idleShare*float64(g.n) {
			continue
		}
		// allTracks is in the order first seen: the first and last built.
		first, last := g.idle[0], g.idle[len(g.idle)-1]
		cost := 0.0
		for _, t := range g.idle {
			cost += p.defs[t.def].cost
		}
		text := fmt.Sprintf("%d built, none ever carried a unit (%s metal)", len(g.idle), metal(cost))
		if len(g.idle) < g.n {
			text = fmt.Sprintf("%d of %d built never carried a unit (%s metal)", len(g.idle), g.n, metal(cost))
		}
		p.usedDef[k[1]] = true
		return Award{Key: "idle", Label: "Grounded fleet", Text: text, Team: k[0], Def: k[1], Value: float64(len(g.idle)),
			F: last.first, Unit: last.id, F0: first.first, F1: last.first, Path: last.route()}, true
	}
	return Award{}, false
}
