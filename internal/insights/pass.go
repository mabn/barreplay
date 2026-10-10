package insights

import (
	"sort"
	"unicode/utf8"

	"github.com/mabn/barreplay/snapshot"
)

// defInfo is what the pass needs per def, resolved once.
type defInfo struct {
	army      bool
	cat       int
	cost      float64
	structure bool
	commander bool
	builder   bool
	fly       bool
	milestone int
}

// pass walks the frames once, with the lifecycle events interleaved at their
// frames, and accumulates every section of the file.
type pass struct {
	in   Input
	ro   roster
	out  *Insights
	defs map[int32]defInfo

	events  []snapshot.Event
	nextEv  int
	lastPos map[int32][2]int32 // unit id -> last sampled x, z
	pending map[int32]bool     // created and not yet finished
	usedDef map[int32]bool
	reached map[[2]int]bool // (milestone, side) already recorded

	lastFrame int32
	bounds    Bounds
	seenPos   bool

	incomeN [][]int // [side][step] samples averaged into the income series

	tracks    map[int32]*track // unit id -> its current life
	allTracks []*track         // every life, in the order first seen

	// The player reports (players.go).
	teamAcc     map[int32]*teamAcc
	strips      map[int32]*Strip
	comPaths    map[int32]*[][]int32
	hadTarget   map[int32]bool
	floatSec    map[int32]float64
	floatMetal  map[int32]float64
	prevFront   [][3]float64
	contacted   int
	playerTeams int
}

func newPass(in Input, ro roster) *pass {
	ns := len(ro.sides)
	p := &pass{
		in: in, ro: ro,
		out: &Insights{
			Version:      Version,
			GameID:       in.Meta.GameID,
			MapName:      in.Meta.MapName,
			StepSec:      StepSec,
			CostCoverage: in.CostCoverage,
			POV:          in.pov(),
			Sides:        ro.sides,
			Teams:        ro.teams,
			Defs:         map[int32]Def{},
			Milestones:   []Milestone{},
			Chat:         []ChatLine{},
			Marks:        make([][]int, ns),
			Series: Series{
				T:            []float64{},
				Army:         make([][]float64, ns),
				MetalIncome:  make([][]float64, ns),
				EnergyIncome: make([][]float64, ns),
				ArmyCats:     armyCats,
				ArmyByCat:    make([][][]float64, ns),
				Front:        make([][][]int32, ns),
			},
			Deaths: Deaths{F: []int32{}, X: []int32{}, Z: []int32{}, Def: []int32{}, Team: []int32{}, Cost: []float64{}, Unfinished: []int8{}},
		},
		defs:    map[int32]defInfo{},
		lastPos: map[int32][2]int32{},
		pending: map[int32]bool{},
		usedDef: map[int32]bool{},
		reached: map[[2]int]bool{},
		incomeN: make([][]int, ns),
		tracks:  map[int32]*track{},

		teamAcc:    map[int32]*teamAcc{},
		strips:     map[int32]*Strip{},
		comPaths:   map[int32]*[][]int32{},
		hadTarget:  map[int32]bool{},
		floatSec:   map[int32]float64{},
		floatMetal: map[int32]float64{},
		prevFront:  make([][3]float64, ns),
	}
	for _, t := range ro.teams {
		if t.Side >= 0 {
			p.playerTeams++
		}
	}
	if p.out.CostCoverage == "" {
		p.out.CostCoverage = CostFull
	}
	for s := 0; s < ns; s++ {
		p.out.Marks[s] = []int{}
		p.out.Series.Army[s] = []float64{}
		p.out.Series.MetalIncome[s] = []float64{}
		p.out.Series.EnergyIncome[s] = []float64{}
		p.out.Series.Front[s] = [][]int32{}
		p.out.Series.ArmyByCat[s] = make([][]float64, len(armyCats))
		for c := range armyCats {
			p.out.Series.ArmyByCat[s][c] = []float64{}
		}
		p.incomeN[s] = []int{}
	}
	for id, d := range in.Meta.UnitDefs {
		p.defs[id] = defInfo{
			army:      isArmy(d),
			cat:       armyCat(d),
			cost:      float64(d.MetalCost),
			structure: isStructure(d),
			commander: isCommander(d.Name),
			builder:   d.IsBuilder,
			fly:       d.CanFly,
			milestone: milestoneOf(d.Name),
		}
	}
	p.events = append([]snapshot.Event(nil), in.Events...)
	sort.SliceStable(p.events, func(i, j int) bool { return p.events[i].Frame < p.events[j].Frame })
	return p
}

func stepOf(frame int32) int { return int(frame) / (StepSec * simFPS) }

// grow extends every per-step series to hold step i.
func (p *pass) grow(i int) {
	s := &p.out.Series
	for len(s.T) <= i {
		s.T = append(s.T, float64(len(s.T)*StepSec))
	}
	for side := range p.ro.sides {
		for len(s.Army[side]) <= i {
			s.Army[side] = append(s.Army[side], 0)
			s.MetalIncome[side] = append(s.MetalIncome[side], 0)
			s.EnergyIncome[side] = append(s.EnergyIncome[side], 0)
			p.incomeN[side] = append(p.incomeN[side], 0)
			p.out.Marks[side] = append(p.out.Marks[side], 0)
			for c := range armyCats {
				s.ArmyByCat[side][c] = append(s.ArmyByCat[side][c], 0)
			}
		}
	}
}

// runEvents applies every event up to and including frame f, against the
// positions of the last sample before it.
func (p *pass) runEvents(f int32, all bool) {
	for p.nextEv < len(p.events) && (all || p.events[p.nextEv].Frame <= f) {
		p.event(p.events[p.nextEv])
		p.nextEv++
	}
}

func (p *pass) event(e snapshot.Event) {
	p.playerEvent(e)
	switch e.Kind {
	case snapshot.EventCreated:
		p.pending[e.UnitID] = true
	case snapshot.EventFinished:
		delete(p.pending, e.UnitID)
		d := p.defs[e.DefID]
		side := p.ro.side(e.Team)
		if d.milestone >= 0 && side >= 0 && !p.reached[[2]int{d.milestone, side}] {
			p.reached[[2]int{d.milestone, side}] = true
			ms := milestoneDefs[d.milestone]
			p.out.Milestones = append(p.out.Milestones, Milestone{Key: ms.Key, Label: ms.Label, Side: side, Team: e.Team, Def: e.DefID, F: e.Frame})
			p.usedDef[e.DefID] = true
		}
	case snapshot.EventDestroyed:
		pos, ok := p.lastPos[e.UnitID]
		if !ok {
			pos = [2]int32{-1, -1}
		}
		unfinished := int8(0)
		if p.pending[e.UnitID] {
			unfinished = 1
		}
		delete(p.pending, e.UnitID)
		dl := &p.out.Deaths
		dl.F = append(dl.F, e.Frame)
		dl.X = append(dl.X, pos[0])
		dl.Z = append(dl.Z, pos[1])
		dl.Def = append(dl.Def, e.DefID)
		dl.Team = append(dl.Team, e.Team)
		dl.Cost = append(dl.Cost, round1(p.defs[e.DefID].cost))
		dl.Unfinished = append(dl.Unfinished, unfinished)
		p.usedDef[e.DefID] = true
		delete(p.lastPos, e.UnitID)
		if t := p.tracks[e.UnitID]; t != nil {
			t.dead = true
		}
	}
}

// dead reports a unit whose health is gone but which the engine has not
// removed yet (a crashing aircraft): it is no longer part of anyone's army.
// maxHp 0 is health unknown (an unidentified radar contact), not health gone.
func dead(u snapshot.UnitState) bool { return u.MaxHealth > 0 && u.Health <= 0 }

func (p *pass) frame(fr snapshot.Frame) error {
	p.runEvents(fr.Frame, false)
	p.lastFrame = fr.Frame
	step := stepOf(fr.Frame)
	p.grow(step)
	s := &p.out.Series

	ns := len(p.ro.sides)
	army := make([]float64, ns)
	byCat := make([][]float64, ns)
	for i := range byCat {
		byCat[i] = make([]float64, len(armyCats))
	}
	front := make([][3]float64, ns) // [side] cost-weighted x, z, weight
	for _, u := range fr.Units {
		x, z := u.Pos.X, u.Pos.Z
		p.lastPos[u.UnitID] = [2]int32{int32(x), int32(z)}
		p.extend(float64(x), float64(z))
		d, ok := p.defs[u.DefID]
		if !ok || dead(u) {
			continue
		}
		p.trackUnit(fr.Frame, u, d)
		if !d.army {
			continue
		}
		side := p.ro.side(u.Team)
		if side < 0 {
			continue
		}
		v := d.cost * float64(u.BuildProgress)
		army[side] += v
		byCat[side][d.cat] += v
		front[side][0] += float64(x) * v
		front[side][1] += float64(z) * v
		front[side][2] += v
	}
	p.recordFront(step, front)

	res := fr.Resources
	if len(res) == 0 && p.in.Resources != nil {
		res = p.in.Resources[fr.Frame]
	}
	p.playerFrame(fr, step, res, front)
	for side := 0; side < ns; side++ {
		// The step holds the value at its last sample.
		s.Army[side][step] = army[side]
		for c := range armyCats {
			s.ArmyByCat[side][c][step] = byCat[side][c]
		}
	}

	if len(res) > 0 {
		mi := make([]float64, ns)
		ei := make([]float64, ns)
		for _, r := range res {
			side := p.ro.side(r.Team)
			if side < 0 {
				continue
			}
			mi[side] += float64(r.MetalIncome)
			ei[side] += float64(r.EnergyIncome)
		}
		for side := 0; side < ns; side++ {
			// Running mean over the step's samples.
			n := float64(p.incomeN[side][step])
			s.MetalIncome[side][step] = (s.MetalIncome[side][step]*n + mi[side]) / (n + 1)
			s.EnergyIncome[side][step] = (s.EnergyIncome[side][step]*n + ei[side]) / (n + 1)
			p.incomeN[side][step]++
		}
	}
	return nil
}

func (p *pass) extend(x, z float64) {
	if !p.seenPos {
		p.bounds = Bounds{MinX: x, MaxX: x, MinZ: z, MaxZ: z}
		p.seenPos = true
		return
	}
	if x < p.bounds.MinX {
		p.bounds.MinX = x
	}
	if x > p.bounds.MaxX {
		p.bounds.MaxX = x
	}
	if z < p.bounds.MinZ {
		p.bounds.MinZ = z
	}
	if z > p.bounds.MaxZ {
		p.bounds.MaxZ = z
	}
}

func (p *pass) comms() {
	for _, c := range p.in.Comms {
		team, isPlayer := p.ro.playerTeam[c.PlayerID]
		side := -1
		if isPlayer {
			side = p.ro.side(team)
		}
		switch c.Kind {
		case snapshot.CommChat:
			if len(p.out.Chat) >= maxChat {
				continue
			}
			name := c.Name
			if name == "" {
				name = p.ro.playerName[c.PlayerID]
			}
			if side >= 0 && p.isSpectator(c.PlayerID) {
				side = -1
			}
			p.out.Chat = append(p.out.Chat, ChatLine{F: c.Frame, Name: name, Side: side, Dest: c.Dest, Text: truncate(c.Text, maxChatText)})
		case snapshot.CommPoint:
			if side < 0 || p.isSpectator(c.PlayerID) {
				continue
			}
			step := stepOf(c.Frame)
			if step < len(p.out.Marks[side]) {
				p.out.Marks[side][step]++
			}
		}
	}
}

func (p *pass) isSpectator(playerID int32) bool {
	for _, pl := range p.in.Meta.Players {
		if pl.PlayerID == playerID {
			return pl.Spectator
		}
	}
	return false
}

func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

func (p *pass) finish() {
	p.runEvents(0, true)
	p.grow(stepOf(p.lastFrame))
	p.comms()
	o := p.out
	o.DurationSec = round1(float64(p.lastFrame) / simFPS)
	if b := p.in.Bounds; b != nil {
		o.Bounds = Bounds{MinX: b.MinX, MaxX: b.MaxX, MinZ: b.MinZ, MaxZ: b.MaxZ}
	} else {
		o.Bounds = p.bounds
	}
	for side := range p.ro.sides {
		round1All(o.Series.Army[side])
		round1All(o.Series.MetalIncome[side])
		round1All(o.Series.EnergyIncome[side])
		for c := range armyCats {
			round1All(o.Series.ArmyByCat[side][c])
		}
	}
	sort.SliceStable(o.Milestones, func(i, j int) bool { return o.Milestones[i].F < o.Milestones[j].F })
	o.Battles = p.battles()
	o.Awards = p.awards()
	o.Players = p.players()
	for side := range p.ro.sides {
		for len(o.Series.Front[side]) < len(o.Series.T) {
			o.Series.Front[side] = append(o.Series.Front[side], nil)
		}
	}
	for id := range p.usedDef {
		d := p.in.Meta.UnitDefs[id]
		o.Defs[id] = Def{Name: d.Name, Human: d.HumanName, Cost: round1(float64(d.MetalCost))}
	}
}
