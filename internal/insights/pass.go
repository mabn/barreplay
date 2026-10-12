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
	transport bool
	milestone int
	worth     float64 // what a loss of it is worth per metal (worthPerMetal)
	bcat      int     // building category (buildings.go), -1 for none
	bcost     float64 // the metal it counts for standing (buildingOf)
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
	built   map[int32]float32  // a pending unit's last sampled build progress
	usedDef map[int32]bool
	reached map[[2]int]bool // (milestone, side) already recorded

	lastFrame int32
	bounds    Bounds
	seenPos   bool

	incomeN [][]int // [side][step] samples averaged into the income series

	tracks    map[int32]*track // unit id -> its current life
	allTracks []*track         // every life, in the order first seen
	// deathUnit and deathTrack line up with out.Deaths: the dead unit's id
	// and its track (nil for a structure), for the awards that go to a death.
	deathUnit  []int32
	deathTrack []*track
	// deathKiller is the team the engine named as the killer, -1 when none
	// (a capture without causes, a death with no attacker).
	deathKiller []int32
	// deathKillerKind is the killer's (team, def), {-1, -1} when none: what
	// tells one force's advance from two fights (stories.go mergeAdvances).
	deathKillerKind [][2]int32
	// deathKillerUnit is the killing unit's id (-1 when none) and
	// deathWeapon the weapon def of the blow (-1 when none): what tells
	// friendly fire from a blast with nobody behind it (friendly.go).
	deathKillerUnit []int32
	deathWeapon     []int32

	hasCauses bool // some destroyed event names a cause: a re-simulation
	// selfdArmed is each unit with a self-destruct order standing: the frame
	// it was given. A second order cancels the first (the engine toggles).
	selfdArmed map[int32]int32
	killsBy    map[int32][]int32 // unit id -> frames of the deaths credited to it
	evolved    evolution

	presence     []presence // army positions, one sample per step (stories.go)
	presenceStep int        // the last step sampled into presence, -1 for none

	teamAlive map[int32]int32 // team -> last sampled frame holding a live unit of it
	wiped     []bool          // per death: it went down with its team (wipes.go)

	// The player reports (players.go).
	teamAcc     map[int32]*teamAcc
	strips      map[int32]*Strip
	comPaths    map[int32]*[][]int32
	comFollow   map[int32]int32 // team -> the commander unit its path follows
	hadTarget   map[int32]bool
	floatSec    map[int32]float64
	floatMetal  map[int32]float64
	prevFront   [][3]float64
	contacted   int
	playerTeams int

	carry carries    // transports seen carrying a unit (transports.go)
	gives giveBursts // units handed to another team, by giver (wipes.go)

	finished []builtRec // every building finished, in frame order (Moment.Built)
	model    string     // the win model (WinModels), picked by modelFor
}

// builtRec is one building finished: what each moment's build-up is told from.
type builtRec struct {
	f    int32
	side int
	def  int32
	cost float64
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
				Value:        make([][]float64, ns),
				MetalIncome:  make([][]float64, ns),
				EnergyIncome: make([][]float64, ns),
				ArmyCats:     armyCats,
				ArmyByCat:    make([][][]float64, ns),
				Front:        make([][][]int32, ns),
				BuildingCats: buildingCats,
				Buildings:    make([][][]float64, ns),
			},
			Deaths: Deaths{F: []int32{}, X: []int32{}, Z: []int32{}, Def: []int32{}, Team: []int32{}, Cost: []float64{}, Unfinished: []int8{}, SelfD: []int8{}},
		},
		defs:       map[int32]defInfo{},
		lastPos:    map[int32][2]int32{},
		pending:    map[int32]bool{},
		selfdArmed: map[int32]int32{},
		usedDef:    map[int32]bool{},
		built:      map[int32]float32{},
		reached:    map[[2]int]bool{},
		incomeN:    make([][]int, ns),
		tracks:     map[int32]*track{},

		presenceStep: -1,

		teamAlive: map[int32]int32{},

		teamAcc:    map[int32]*teamAcc{},
		strips:     map[int32]*Strip{},
		comPaths:   map[int32]*[][]int32{},
		comFollow:  map[int32]int32{},
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
	p.evolved = evolutions(in.Events)
	p.killsBy = map[int32][]int32{}
	for _, e := range in.Events {
		if e.Kind == snapshot.EventDestroyed && e.Cause != nil && e.Cause.UnitID >= 0 && e.Cause.UnitID != e.UnitID {
			p.killsBy[e.Cause.UnitID] = append(p.killsBy[e.Cause.UnitID], e.Frame)
		}
	}
	for _, e := range in.Events {
		if e.Kind == snapshot.EventDestroyed && e.Cause != nil {
			p.hasCauses = true
			break
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
		p.out.Series.Buildings[s] = make([][]float64, len(buildingCats))
		for c := range buildingCats {
			p.out.Series.Buildings[s][c] = []float64{}
		}
		p.incomeN[s] = []int{}
	}
	legacy := in.CostCoverage == CostArmy
	for id, d := range in.Meta.UnitDefs {
		bcat, bcost := buildingOf(d, legacy)
		p.defs[id] = defInfo{
			army:      isArmy(d),
			cat:       armyCat(d),
			cost:      float64(d.MetalCost),
			structure: isStructure(d),
			commander: isCommander(d.Name),
			builder:   d.IsBuilder,
			fly:       d.CanFly,
			transport: isTransport(d.Name),
			worth:     worthPerMetal(d, p.hasCauses),
			milestone: milestoneOf(d.Name),
			bcat:      bcat,
			bcost:     bcost,
		}
	}
	p.model = modelFor(in, ro)
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
			s.Value[side] = append(s.Value[side], 0)
			s.MetalIncome[side] = append(s.MetalIncome[side], 0)
			s.EnergyIncome[side] = append(s.EnergyIncome[side], 0)
			p.incomeN[side] = append(p.incomeN[side], 0)
			p.out.Marks[side] = append(p.out.Marks[side], 0)
			for c := range armyCats {
				s.ArmyByCat[side][c] = append(s.ArmyByCat[side][c], 0)
			}
			for c := range buildingCats {
				s.Buildings[side][c] = append(s.Buildings[side][c], 0)
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
	case snapshot.EventGiven:
		if e.Cause != nil && e.Cause.Team >= 0 && e.Cause.Team != e.Team {
			p.gives.add(e.Cause.Team, e.Team, e.Frame)
		}
	case snapshot.EventSelfD:
		if _, on := p.selfdArmed[e.UnitID]; on {
			delete(p.selfdArmed, e.UnitID)
		} else {
			p.selfdArmed[e.UnitID] = e.Frame
		}
	case snapshot.EventCreated:
		p.pending[e.UnitID] = true
	case snapshot.EventFinished:
		delete(p.pending, e.UnitID)
		delete(p.built, e.UnitID)
		d := p.defs[e.DefID]
		side := p.ro.side(e.Team)
		if d.bcat >= 0 && side >= 0 {
			p.finished = append(p.finished, builtRec{e.Frame, side, e.DefID, d.bcost})
		}
		if d.milestone >= 0 && side >= 0 && !p.reached[[2]int{d.milestone, side}] {
			p.reached[[2]int{d.milestone, side}] = true
			ms := milestoneDefs[d.milestone]
			m := Milestone{Key: ms.Key, Label: ms.Label, Side: side, Team: e.Team, Def: e.DefID, F: e.Frame, Unit: e.UnitID}
			if pos, ok := p.lastPos[e.UnitID]; ok {
				m.Pos = &pos
			}
			p.out.Milestones = append(p.out.Milestones, m)
			p.usedDef[e.DefID] = true
		}
	case snapshot.EventDestroyed:
		selfd := p.selfDestructed(e)
		removed := p.removedByOwner(e)
		delete(p.selfdArmed, e.UnitID)
		if removed {
			// Taken down by its own side: the unit is gone, but nothing
			// was lost and nothing was fought over.
			delete(p.pending, e.UnitID)
			delete(p.built, e.UnitID)
			delete(p.lastPos, e.UnitID)
			if t := p.tracks[e.UnitID]; t != nil {
				t.dead = true
			}
			return
		}
		pos, ok := p.lastPos[e.UnitID]
		if !ok {
			pos = [2]int32{-1, -1}
		}
		unfinished := int8(0)
		if p.pending[e.UnitID] {
			unfinished = 1
		}
		cost := p.lossCost(e) // before the build is forgotten
		delete(p.pending, e.UnitID)
		delete(p.built, e.UnitID)
		dl := &p.out.Deaths
		dl.F = append(dl.F, e.Frame)
		dl.X = append(dl.X, pos[0])
		dl.Z = append(dl.Z, pos[1])
		dl.Def = append(dl.Def, e.DefID)
		dl.Team = append(dl.Team, e.Team)
		dl.Cost = append(dl.Cost, round1(cost))
		dl.Unfinished = append(dl.Unfinished, unfinished)
		dl.SelfD = append(dl.SelfD, b2i(selfd))
		p.usedDef[e.DefID] = true
		delete(p.lastPos, e.UnitID)
		p.deathUnit = append(p.deathUnit, e.UnitID)
		killer := int32(-1)
		if e.Cause != nil && e.Cause.Team >= 0 {
			killer = e.Cause.Team
		}
		p.deathKiller = append(p.deathKiller, killer)
		killerKind := [2]int32{-1, -1}
		if e.Cause != nil && e.Cause.Team >= 0 && e.Cause.DefID > 0 && e.Cause.UnitID != e.UnitID {
			killerKind = [2]int32{e.Cause.Team, e.Cause.DefID}
		}
		p.deathKillerKind = append(p.deathKillerKind, killerKind)
		ku, wd := int32(-1), int32(-1)
		if e.Cause != nil {
			ku, wd = e.Cause.UnitID, e.Cause.WeaponDef
		}
		p.deathKillerUnit = append(p.deathKillerUnit, ku)
		p.deathWeapon = append(p.deathWeapon, wd)
		if c := e.Cause; c != nil && cost > 0 {
			// Credit the killing unit's track with an ENEMY it took down.
			if kt := p.tracks[c.UnitID]; kt != nil && !kt.dead && kt.def == c.DefID {
				if ks, vs := p.ro.side(kt.team), p.ro.side(e.Team); ks >= 0 && vs >= 0 && ks != vs {
					kt.kills = append(kt.kills, kill{e.Frame, cost})
				}
			}
		}
		t := p.tracks[e.UnitID]
		if t != nil && !t.dead {
			t.dead = true
		} else {
			t = nil
		}
		p.deathTrack = append(p.deathTrack, t)
	}
}

// selfdMaxSec is the longest a self-destruct order is taken to stand before
// the blast: BAR's countdowns are a few seconds (a commander's is the
// longest), and a unit that dies a minute after an order nobody cancelled
// died of something else.
const selfdMaxSec = 60

// selfDestructed is whether a destroyed unit blew itself up: its owner's
// order was standing, and nothing else is named as the cause (a self-
// destruct's blast names no killer; a capture with no causes names none
// for any death, and then the standing order is the whole evidence).
func (p *pass) selfDestructed(e snapshot.Event) bool {
	at, on := p.selfdArmed[e.UnitID]
	if !on || e.Frame-at > selfdMaxSec*30 {
		return false
	}
	return e.Cause == nil || e.Cause.UnitID == e.UnitID || e.Cause.UnitID < 0
}

// fightSec is how recently a self-destructed unit must have been hurt to
// count as fighting, and blastSec how long after its blast a death is still
// its doing.
const (
	fightSec = 20
	blastSec = 3
)

// fought is whether a self-destructed unit went in a fight: its blast killed
// something (the engine credits the blast to the unit, in a capture that
// names causes — an enemy or its own side's buildings, both worth telling),
// or it had been hurt in the last fightSec. Otherwise its owner simply
// cashed it in, which is no more a loss than a reclaim.
func (p *pass) fought(e snapshot.Event) bool {
	for _, f := range p.killsBy[e.UnitID] {
		if f >= e.Frame && f <= e.Frame+blastSec*30 {
			return true
		}
	}
	if t := p.tracks[e.UnitID]; t != nil && !t.dead && t.def == e.DefID && t.hurt && e.Frame-t.hurtF <= fightSec*30 {
		return true
	}
	return false
}

func b2i(b bool) int8 {
	if b {
		return 1
	}
	return 0
}

// weaponReclaimed is the weapon id the engine names in a destroyed event's
// cause when a builder reclaims a unit: one of its negative, engine-owned
// damage types (measured on a real re-simulation: all 888 of them were a
// builder taking down its own team's unit, e.g. armrespawn clearing armwin).
const weaponReclaimed = -12

// removedByOwner reports a unit its own side took down, which is routine
// housekeeping rather than a loss. An EVOLUTION (evolve.go) is one in any
// capture; two more are readable only in one that names causes (a
// re-simulation; older captures count those deaths, as they always did):
//
//   - RECLAIMED by its own side: wind turbines cleared for something better,
//     a lab taken down; the metal comes back. Reclaiming an ENEMY unit is a
//     real loss for its owner and stays one.
//   - A STRUCTURE destroyed with no cause at all. Anything the enemy kills
//     names its killer; a building that goes with none was replaced (BAR
//     removes a metal extractor when an advanced one is built over it, and
//     a geothermal the same way), cancelled while unfinished, or
//     self-destructed. On a real 8v8 re-sim this was 14 of the 25 structure
//     deaths in one "trade" the summary used to report, every one of them
//     an upgrade. A finished mobile unit is left alone: a shot-down
//     aircraft dies later, in its crash, with no cause either. An
//     UNFINISHED one going with no cause is a cancelled build.
func (p *pass) removedByOwner(e snapshot.Event) bool {
	if e.Kind == snapshot.EventDestroyed && p.selfDestructed(e) && !p.fought(e) {
		// Blown up by its owner away from any fight: cashing it in (a
		// commander for its metal), not a loss.
		return true
	}
	if e.Kind == snapshot.EventDestroyed && p.evolved.replaced(e) {
		// Evolved into its next form (evolve.go): replaced, not lost.
		return true
	}
	if e.Kind != snapshot.EventDestroyed || !p.hasCauses {
		return false
	}
	c := e.Cause
	if c == nil {
		// An UNFINISHED unit going with no cause is a cancelled build (a
		// half-built Liche in its lab), whatever it is; a finished mobile one
		// is a crash, which is a real loss.
		return (p.defs[e.DefID].structure || p.pending[e.UnitID]) && p.ro.side(e.Team) >= 0
	}
	if c.WeaponDef != weaponReclaimed || c.Team < 0 {
		return false
	}
	side := p.ro.side(e.Team)
	return side >= 0 && p.ro.side(c.Team) == side
}

// lossCost is the metal a destroyed unit was worth: its price, or for one
// still under construction the share of it built so far — the rest was never
// spent. A build destroyed before any sample saw it is worth nothing.
func (p *pass) lossCost(e snapshot.Event) float64 {
	c := p.defs[e.DefID].cost
	if p.pending[e.UnitID] {
		return c * float64(p.built[e.UnitID])
	}
	return c
}

// dead reports a unit whose health is gone but which the engine has not
// removed yet (a crashing aircraft): it is no longer part of anyone's army.
// maxHp 0 is health unknown (an unidentified radar contact), not health gone.
func dead(u snapshot.UnitState) bool { return u.MaxHealth > 0 && u.Health <= 0 }

func (p *pass) frame(fr snapshot.Frame) error {
	p.runEvents(fr.Frame, false)
	p.lastFrame = fr.Frame
	p.carryFrame(fr)
	step := stepOf(fr.Frame)
	p.grow(step)
	s := &p.out.Series

	ns := len(p.ro.sides)
	army := make([]float64, ns)
	value := make([]float64, ns)
	byCat := make([][]float64, ns)
	for i := range byCat {
		byCat[i] = make([]float64, len(armyCats))
	}
	bld := make([][]float64, ns)
	for i := range bld {
		bld[i] = make([]float64, len(buildingCats))
	}
	front := make([][3]float64, ns) // [side] cost-weighted x, z, weight
	var here *presence
	if step != p.presenceStep {
		p.presenceStep = step
		p.presence = append(p.presence, presence{f: fr.Frame})
		here = &p.presence[len(p.presence)-1]
	}
	for _, u := range fr.Units {
		x, z := u.Pos.X, u.Pos.Z
		p.lastPos[u.UnitID] = [2]int32{int32(x), int32(z)}
		if p.pending[u.UnitID] {
			p.built[u.UnitID] = u.BuildProgress
		}
		p.extend(float64(x), float64(z))
		d, ok := p.defs[u.DefID]
		if !ok || dead(u) {
			continue
		}
		p.teamAlive[u.Team] = fr.Frame
		p.trackUnit(fr.Frame, u, d)
		if side := p.ro.side(u.Team); side >= 0 {
			value[side] += d.cost * float64(u.BuildProgress)
			if d.bcat >= 0 {
				bld[side][d.bcat] += d.bcost * float64(u.BuildProgress)
			}
		}
		if !d.army {
			continue
		}
		side := p.ro.side(u.Team)
		if side < 0 {
			continue
		}
		v := d.cost * float64(u.BuildProgress)
		if here != nil {
			here.units = append(here.units, presentUnit{team: u.Team, x: x, z: z, v: float32(v)})
		}
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
		s.Value[side][step] = round1(value[side])
		for c := range armyCats {
			s.ArmyByCat[side][c][step] = byCat[side][c]
		}
		for c := range buildingCats {
			s.Buildings[side][c][step] = bld[side][c]
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
	o.Causes = p.hasCauses
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
		for c := range buildingCats {
			round1All(o.Series.Buildings[side][c])
		}
	}
	sort.SliceStable(o.Milestones, func(i, j int) bool { return o.Milestones[i].F < o.Milestones[j].F })
	o.Eliminated = withHandoffs(eliminations(o.Deaths, p.in.TeamDied, p.teamAlive, o.Teams), p.gives, p.teamAlive, o.Teams)
	p.wiped = wipedDeaths(o.Deaths, o.Eliminated)
	o.Battles = p.battles()
	o.Winner = winner(o.Sides, p.in.Meta.Winners)
	// The line reads which deaths were buildings off Defs, as cmd/winfit
	// reads them off the file: fill them for what is used so far (the
	// awards below may add more, filled at the end).
	p.fillDefs()
	o.Swing = swing(o, func(id int32) bool { return isEcoBuilding(p.in.Meta.UnitDefs[id]) }, p.model)
	if o.Swing != nil {
		for i := range o.Swing.Moments {
			p.momentBuilt(&o.Swing.Moments[i])
		}
	}
	o.Awards = p.awards()
	o.Players = p.players()
	for side := range p.ro.sides {
		for len(o.Series.Front[side]) < len(o.Series.T) {
			o.Series.Front[side] = append(o.Series.Front[side], nil)
		}
	}
	p.fillDefs()
}

// fillDefs describes every def used so far in Insights.Defs.
func (p *pass) fillDefs() {
	for id := range p.usedDef {
		if _, ok := p.out.Defs[id]; ok {
			continue
		}
		d := p.in.Meta.UnitDefs[id]
		stand := ""
		if di := p.defs[id]; di.bcat >= 0 {
			stand = buildingCats[di.bcat]
		}
		p.out.Defs[id] = Def{Name: d.Name, Human: d.HumanName, Cost: round1(float64(d.MetalCost)), Icon: d.IconType, Power: isPowerPlant(d), Worth: worthOut(p.defs[id].worth), Class: unitClass(d), Stand: stand}
	}
}

// builtSec is how far back a moment's build-up looks: the win model's income
// window, since a building finished then is still in what the model reads.
const builtSec = swingIncomeSteps * StepSec

// momentBuiltDefs caps the defs one side's build-up lists per building
// category, so a stretch of turrets cannot push the mines out of it.
const momentBuiltDefs = 8

// momentBuilt fills a moment's Built: what each side finished in the
// builtSec up to its end, by def, the most metal first.
func (p *pass) momentBuilt(m *Moment) {
	m.BuiltFrom = max(0, m.F1-builtSec*simFPS)
	m.Built = make([][]UnitLoss, len(p.ro.sides))
	for side := range m.Built {
		byDef := map[int32]*UnitLoss{}
		for _, b := range p.finished {
			if b.side != side || b.f <= m.BuiltFrom || b.f > m.F1 {
				continue
			}
			u := byDef[b.def]
			if u == nil {
				u = &UnitLoss{Def: b.def}
				byDef[b.def] = u
			}
			u.N++
			u.Metal += b.cost
		}
		list := make([]UnitLoss, 0, len(byDef))
		for _, u := range byDef {
			u.Metal = round1(u.Metal)
			list = append(list, *u)
		}
		sort.Slice(list, func(i, j int) bool {
			if list[i].Metal != list[j].Metal {
				return list[i].Metal > list[j].Metal
			}
			return list[i].Def < list[j].Def
		})
		kept := list[:0]
		perCat := make([]int, len(buildingCats))
		for _, u := range list {
			if c := p.defs[u.Def].bcat; c >= 0 && perCat[c] < momentBuiltDefs {
				perCat[c]++
				kept = append(kept, u)
				p.usedDef[u.Def] = true
			}
		}
		m.Built[side] = kept
	}
}

// worthOut is Def.Worth: absent when a loss counts its plain metal.
func worthOut(w float64) float64 {
	if w == 1 {
		return 0
	}
	return w
}
