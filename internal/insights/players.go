package insights

import (
	"math"

	"github.com/mabn/barreplay/snapshot"
)

// The player report: one entry per team a player controlled, with what that
// player built, lost and said over time (the strip), where their economy
// leaked, their commander's day, and a few numbers describing how they
// played. Without command data there is no APM and no multitasking axis.

// Player is one team's report.
type Player struct {
	Team      int32          `json:"team"`
	Player    string         `json:"player"`
	Side      int            `json:"side"`
	Strip     Strip          `json:"strip"`
	Leaks     Leaks          `json:"leaks"`
	Commander CommanderDiary `json:"commander"`
	Style     Style          `json:"style"`
}

// Strip is per step, like Series.
type Strip struct {
	BuiltMetal []float64 `json:"builtMetal"` // metal of units finished
	BuiltN     []int     `json:"builtN"`
	LostMetal  []float64 `json:"lostMetal"`
	LostN      []int     `json:"lostN"`
	Chat       []int     `json:"chat"`
}

// Leaks are where the economy went unused.
type Leaks struct {
	// FloatSec is how long the player's whole SIDE sat on full metal storage
	// (overflow is shared with allies, so one full bar is not yet waste), and
	// FloatMetal the player's income over that time — metal that went nowhere.
	FloatSec   float64 `json:"floatSec"`
	FloatMetal float64 `json:"floatMetal"`
	// NotBuilding is the share of builder time spent with no build target and
	// not moving. Reclaiming also has no target, hence "not building" rather
	// than idle. Null when the replay records no build targets (v4 bundles).
	NotBuilding *float64 `json:"notBuilding"`
	BuilderSec  float64  `json:"builderSec"`
}

// CommanderDiary follows the team's commander.
type CommanderDiary struct {
	// Path is [x, z, health %] per step, null while there is no commander.
	Path [][]int32 `json:"path"`
	// Died is the frame the last commander died, -1 if it lived.
	Died int32 `json:"died"`
	// FirstContact is the first frame an enemy army unit came within
	// contactRange of any of the player's units, -1 if none did.
	FirstContact int32 `json:"firstContact"`
}

// Style is the play style card's axes.
type Style struct {
	IncomeShare float64 `json:"incomeShare"` // of the side's metal income
	T2          int32   `json:"t2"`          // first T2 lab finished, -1 if never
	AreaPct     float64 `json:"areaPct"`     // of the map the player's units visited
	// ForwardShare is the share of the player's army value that stood past
	// the midpoint between the two armies. Null outside two-sided games.
	ForwardShare *float64 `json:"forwardShare"`
	// AssistShare is the share of builder time spent helping build something
	// another builder was also on. Null without build targets.
	AssistShare *float64 `json:"assistShare"`
}

const (
	contactRange = 900.0 // elmos
	fullStorage  = 0.98  // metal at this share of storage counts as full
)

// teamAcc accumulates one team's report during the pass.
type teamAcc struct {
	cells        [tourGrid * tourGrid / 64]uint64
	incomeSum    float64
	incomeN      int
	forward      float64
	armyTotal    float64
	builderS     float64
	notBuildingS float64
	assistS      float64
	firstContact int32
	t2           int32
	comDied      int32
}

func (p *pass) team(id int32) *teamAcc {
	a := p.teamAcc[id]
	if a == nil {
		a = &teamAcc{firstContact: -1, t2: -1, comDied: -1}
		p.teamAcc[id] = a
	}
	return a
}

// playerFrame is the per-sample work for the reports, after the army pass
// has filled front (this sample's army centres, cost-weighted).
func (p *pass) playerFrame(fr snapshot.Frame, step int, res []snapshot.TeamResource, front [][3]float64) {
	interval := float64(max(1, p.in.Meta.SampleEvery)) / simFPS
	ns := len(p.ro.sides)

	// Who is targeting what, for assists.
	builders := map[int32]int{}
	if p.in.HasTargets {
		for _, u := range fr.Units {
			if u.TargetID != 0 {
				builders[u.TargetID]++
			}
		}
	}
	// The forward test uses the previous sample's centres: a unit is forward
	// when it stands past the midpoint, toward the enemy.
	var mid, dir [2]float64
	forwardOK := ns == 2 && p.prevFront[0][2] > 0 && p.prevFront[1][2] > 0
	if forwardOK {
		// prevFront holds cost-weighted SUMS; the centre is sum / weight.
		a := [2]float64{p.prevFront[0][0] / p.prevFront[0][2], p.prevFront[0][1] / p.prevFront[0][2]}
		b := [2]float64{p.prevFront[1][0] / p.prevFront[1][2], p.prevFront[1][1] / p.prevFront[1][2]}
		mid = [2]float64{(a[0] + b[0]) / 2, (a[1] + b[1]) / 2}
		dir = [2]float64{b[0] - a[0], b[1] - a[1]}
	}

	coms := map[int32][]int{} // team -> its commanders' indices in fr.Units
	for i, u := range fr.Units {
		d, ok := p.defs[u.DefID]
		if !ok || dead(u) {
			continue
		}
		side := p.ro.side(u.Team)
		if side < 0 {
			continue
		}
		a := p.team(u.Team)
		if c, ok := p.cell(u.Pos.X, u.Pos.Z); ok {
			a.cells[c/64] |= 1 << (c % 64)
		}
		if d.army && forwardOK {
			v := d.cost * float64(u.BuildProgress)
			sign := 1.0
			if side == 1 {
				sign = -1
			}
			if sign*((float64(u.Pos.X)-mid[0])*dir[0]+(float64(u.Pos.Z)-mid[1])*dir[1]) > 0 {
				a.forward += v
			}
			a.armyTotal += v
		}
		// A builder is a def flagged as one, or — for a replay rebuilt from
		// its pieces, whose defs carry no such flag — a unit seen building.
		if u.TargetID != 0 {
			p.hadTarget[u.UnitID] = true
		}
		if p.in.HasTargets && !d.structure && u.BuildProgress >= 1 && (d.builder || p.hadTarget[u.UnitID]) {
			a.builderS += interval
			switch {
			case u.TargetID == 0 && u.VelX == 0 && u.VelZ == 0:
				a.notBuildingS += interval
			case u.TargetID != 0 && builders[u.TargetID] >= 2:
				a.assistS += interval
			}
		}
		if d.commander {
			coms[u.Team] = append(coms[u.Team], i)
		}
	}
	for team, idx := range coms {
		u := fr.Units[p.followCommander(team, fr.Units, idx)]
		hp := int32(0)
		if u.MaxHealth > 0 {
			hp = int32(math.Round(100 * float64(u.Health) / float64(u.MaxHealth)))
		}
		path := p.comPath(team)
		for len(*path) <= step {
			*path = append(*path, nil)
		}
		(*path)[step] = []int32{int32(u.Pos.X), int32(u.Pos.Z), hp}
	}

	// Floating: a side counts as full only when every team on it is.
	if len(res) > 0 {
		full := make([]bool, ns)
		for i := range full {
			full[i] = true
		}
		seen := make([]bool, ns)
		for _, r := range res {
			side := p.ro.side(r.Team)
			if side < 0 {
				continue
			}
			seen[side] = true
			if r.MetalStorage <= 0 || float64(r.Metal) < fullStorage*float64(r.MetalStorage) {
				full[side] = false
			}
		}
		for _, r := range res {
			side := p.ro.side(r.Team)
			if side < 0 {
				continue
			}
			a := p.team(r.Team)
			a.incomeSum += float64(r.MetalIncome)
			a.incomeN++
			if seen[side] && full[side] {
				p.floatSec[r.Team] += interval
				p.floatMetal[r.Team] += float64(r.MetalIncome) * interval
			}
		}
	}

	p.contact(fr)
	p.prevFront = front
}

// contact records each team's first contact with an enemy army unit. It
// stops looking once every team has had one, so it costs nothing after the
// opening.
func (p *pass) contact(fr snapshot.Frame) {
	if len(p.ro.sides) < 2 || p.contacted == p.playerTeams {
		return
	}
	const cellSize = contactRange
	type key struct{ x, z int32 }
	cellOf := func(x, z float32) key { return key{int32(float64(x) / cellSize), int32(float64(z) / cellSize)} }
	army := map[key][]snapshot.UnitState{}
	for _, u := range fr.Units {
		if d, ok := p.defs[u.DefID]; ok && d.army && !dead(u) && p.ro.side(u.Team) >= 0 {
			k := cellOf(u.Pos.X, u.Pos.Z)
			army[k] = append(army[k], u)
		}
	}
	if len(army) == 0 {
		return
	}
	for _, u := range fr.Units {
		side := p.ro.side(u.Team)
		if side < 0 {
			continue
		}
		a := p.team(u.Team)
		if a.firstContact >= 0 {
			continue
		}
		k := cellOf(u.Pos.X, u.Pos.Z)
	search:
		for dx := int32(-1); dx <= 1; dx++ {
			for dz := int32(-1); dz <= 1; dz++ {
				for _, e := range army[key{k.x + dx, k.z + dz}] {
					if p.ro.side(e.Team) == side {
						continue
					}
					if math.Hypot(float64(e.Pos.X-u.Pos.X), float64(e.Pos.Z-u.Pos.Z)) <= contactRange {
						a.firstContact = fr.Frame
						p.contacted++
						break search
					}
				}
			}
		}
	}
}

// followCommander picks which of a team's commanders (idx, into units) its
// path follows: the one it followed last sample while that one is still
// there, else the one nearest where the path left off. A team with two is
// routine — a teammate's commander is given to it when that teammate leaves —
// and taking whichever came first in the frame flipped between them, drawing
// the path as zigzags across the map.
func (p *pass) followCommander(team int32, units []snapshot.UnitState, idx []int) int {
	pick := idx[0]
	if id, ok := p.comFollow[team]; ok {
		for _, i := range idx {
			if units[i].UnitID == id {
				return i
			}
		}
		if path := *p.comPath(team); len(path) > 0 {
			var last []int32
			for k := len(path) - 1; k >= 0 && last == nil; k-- {
				last = path[k]
			}
			if last != nil {
				best := math.Inf(1)
				for _, i := range idx {
					dx, dz := float64(units[i].Pos.X)-float64(last[0]), float64(units[i].Pos.Z)-float64(last[1])
					if d := dx*dx + dz*dz; d < best {
						best, pick = d, i
					}
				}
			}
		}
	}
	p.comFollow[team] = units[pick].UnitID
	return pick
}

func (p *pass) comPath(team int32) *[][]int32 {
	if p.comPaths[team] == nil {
		p.comPaths[team] = &[][]int32{}
	}
	return p.comPaths[team]
}

// playerEvent is the per-event work for the reports.
func (p *pass) playerEvent(e snapshot.Event) {
	if p.ro.side(e.Team) < 0 {
		return
	}
	d := p.defs[e.DefID]
	step := stepOf(e.Frame)
	st := p.strip(e.Team, step)
	switch e.Kind {
	case snapshot.EventFinished:
		if p.evolved.replaced(e) {
			break // spawned by an evolution, not built
		}
		st.BuiltMetal[step] += d.cost
		st.BuiltN[step]++
		if a := p.team(e.Team); a.t2 < 0 && d.milestone >= 0 && milestoneDefs[d.milestone].Key == "t2lab" {
			a.t2 = e.Frame
		}
	case snapshot.EventDestroyed:
		if p.removedByOwner(e) {
			if d.commander && p.selfDestructed(e) {
				// Cashed in, not lost, but the commander's path still ends.
				p.team(e.Team).comDied = e.Frame
			}
			break
		}
		st.LostMetal[step] += p.lossCost(e)
		st.LostN[step]++
		if d.commander {
			p.team(e.Team).comDied = e.Frame
		}
	}
}

// strip returns a team's strip grown to hold step.
func (p *pass) strip(team int32, step int) *Strip {
	st := p.strips[team]
	if st == nil {
		st = &Strip{BuiltMetal: []float64{}, BuiltN: []int{}, LostMetal: []float64{}, LostN: []int{}, Chat: []int{}}
		p.strips[team] = st
	}
	for len(st.BuiltMetal) <= step {
		st.BuiltMetal = append(st.BuiltMetal, 0)
		st.BuiltN = append(st.BuiltN, 0)
		st.LostMetal = append(st.LostMetal, 0)
		st.LostN = append(st.LostN, 0)
		st.Chat = append(st.Chat, 0)
	}
	return st
}

// players assembles the reports, one per team a player controlled.
func (p *pass) players() []Player {
	steps := len(p.out.Series.T)
	out := []Player{}
	// Comms are counted here: they are walked after the frames.
	for _, c := range p.in.Comms {
		if c.Kind != snapshot.CommChat || p.isSpectator(c.PlayerID) {
			continue
		}
		if team, ok := p.ro.playerTeam[c.PlayerID]; ok && p.ro.side(team) >= 0 {
			p.strip(team, stepOf(c.Frame)).Chat[stepOf(c.Frame)]++
		}
	}
	sideIncome := make([]float64, len(p.ro.sides))
	for _, t := range p.ro.teams {
		if t.Side >= 0 {
			if a := p.teamAcc[t.Team]; a != nil && a.incomeN > 0 {
				sideIncome[t.Side] += a.incomeSum / float64(a.incomeN)
			}
		}
	}
	for _, t := range p.ro.teams {
		if t.Side < 0 {
			continue
		}
		a := p.team(t.Team)
		st := p.strip(t.Team, max(0, steps-1))
		for _, xs := range [][]float64{st.BuiltMetal, st.LostMetal} {
			round1All(xs)
		}
		pl := Player{Team: t.Team, Player: t.Player, Side: t.Side, Strip: *st}
		pl.Leaks = Leaks{FloatSec: round1(p.floatSec[t.Team]), FloatMetal: round1(p.floatMetal[t.Team]), BuilderSec: round1(a.builderS)}
		path := *p.comPath(t.Team)
		for len(path) < steps {
			path = append(path, nil)
		}
		pl.Commander = CommanderDiary{Path: path, Died: a.comDied, FirstContact: a.firstContact}
		if a.comDied >= 0 {
			// A later sighting means another commander (a resurrection or a
			// second one) outlived the death.
			for _, pt := range path[stepOf(a.comDied)+1:] {
				if pt != nil {
					pl.Commander.Died = -1
					break
				}
			}
		}
		cells := 0
		for _, w := range a.cells {
			for ; w != 0; w &= w - 1 {
				cells++
			}
		}
		pl.Style = Style{T2: a.t2, AreaPct: round1(100 * float64(cells) / (tourGrid * tourGrid))}
		if s := sideIncome[t.Side]; s > 0 && a.incomeN > 0 {
			pl.Style.IncomeShare = round3(a.incomeSum / float64(a.incomeN) / s)
		}
		if len(p.ro.sides) == 2 && a.armyTotal > 0 {
			v := round3(a.forward / a.armyTotal)
			pl.Style.ForwardShare = &v
		}
		if p.in.HasTargets && a.builderS > 0 {
			nb := round3(a.notBuildingS / a.builderS)
			as := round3(a.assistS / a.builderS)
			pl.Leaks.NotBuilding = &nb
			pl.Style.AssistShare = &as
		}
		out = append(out, pl)
	}
	return out
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }
