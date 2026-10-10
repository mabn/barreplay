// Package combat turns a re-simulation's raw combat record — every hit as the
// engine delivered it (snapshot.Hit), where every unit's life ended
// (snapshot.UnitEnd) and the destroyed events with the engine's own killer —
// into what a summary reads: damage per sample window, per-unit lifetime
// totals, who killed what, and the big blasts.
//
// The capture stores only the source data on purpose. Everything here is a
// judgement — who deserves the credit for a chain of exploding reactors, how
// big a blast has to be to count, that overkill is not damage — and keeping
// the judgement in the reader means it can change without re-simulating a
// game, which is the one expensive thing. Derive is deterministic: the same
// record and Options always give the same Result.
package combat

import (
	"math"
	"sort"

	"github.com/mabn/barreplay/snapshot"
)

// Options are the tunable parts of the derivation.
type Options struct {
	// BlastWindow is how long, in sim frames, a dead unit stays a possible
	// source of a blast: the engine runs a death explosion after the death
	// script, a few seconds after the killing blow.
	BlastWindow int32
	// BlastSlack is added to an explosion's radius when matching a hit to
	// the blast that dealt it: the hit position is the victim's centre, and
	// the blast reaches its edge.
	BlastSlack float32
	// A blast is BIG (reported in Result.Blasts) when it removed at least
	// BigBlastDamage health or killed at least BigBlastKills units.
	BigBlastDamage float32
	BigBlastKills  int32
}

// DefaultOptions are the settings the analysis tools use.
func DefaultOptions() Options {
	return Options{BlastWindow: 600, BlastSlack: 64, BigBlastDamage: 3000, BigBlastKills: 3}
}

// Who is a unit (or just a team and def, when the unit is not known); -1
// for any part that is unknown. A Who with Team < 0 is nobody.
type Who struct {
	Unit int32 `json:"unit"`
	Def  int32 `json:"def"`
	Team int32 `json:"team"`
}

// Nobody is the unknown attacker.
var Nobody = Who{-1, -1, -1}

// Known reports whether the Who names at least a team.
func (w Who) Known() bool { return w.Team >= 0 }

// KillKey identifies one death: the frame and the unit (ids are recycled,
// a frame and an id are not).
type KillKey struct{ Frame, Unit int32 }

// Kill is the credited cause of one death. By is the engine's killer, or —
// when the unit died in a blast — whoever set off the blast (Chain).
// Weapon is the weapon the engine named for the killing blow.
type Kill struct {
	By     Who
	Weapon int32
	Chain  bool
}

// Stats counts how the hits were attributed.
type Stats struct {
	Hits           int     // damage callins with positive damage
	NamedAttacker  int     // the engine named an attacker
	FromProjectile int     // ...no attacker, but the projectile named its shooter
	FromChain      int     // a blast credited to whoever set it off
	NamedWeapon    int     // a weapon def (not an engine cause)
	EngineCause    int     // an engine damage source (lava, crushing, ...)
	Removed        float64 // health removed, overkill excluded
	UnknownRemoved float64 // ...of which nobody is credited with
}

// Result is the derivation.
type Result struct {
	// Windows sums the damage per sample interval (the frame each one
	// starts at), by attacker team/def, weapon, victim team/def — the shape
	// the widget used to write as D records.
	Windows []snapshot.DamageWindow
	// Lives is every unit life's totals; Died is -1 for a survivor.
	Lives []snapshot.UnitLife
	// Blasts are the big death explosions, in the order they landed.
	Blasts []snapshot.FactBlastData
	// Kills is the credited cause of every death the record holds an end
	// for.
	Kills map[KillKey]Kill
	Stats Stats
}

// Credit returns a copy of events in which every destroyed event's Cause is
// the credited killer (a chain explosion names whoever set it off), so code
// written against the cause columns reads the derivation unchanged.
func (r Result) Credit(events []snapshot.Event) []snapshot.Event {
	out := make([]snapshot.Event, len(events))
	copy(out, events)
	for i := range out {
		e := &out[i]
		if e.Kind != snapshot.EventDestroyed {
			continue
		}
		k, ok := r.Kills[KillKey{e.Frame, e.UnitID}]
		if !ok {
			continue
		}
		if !k.By.Known() && k.Weapon == -1 {
			e.Cause = nil
			continue
		}
		e.Cause = &snapshot.EventCause{UnitID: k.By.Unit, DefID: k.By.Def, Team: k.By.Team, WeaponDef: k.Weapon}
	}
	return out
}

// source is a dead unit whose explosion may still be landing.
type source struct {
	unit, def, team int32
	x, z            float32
	death, selfd    int32 // explosion weapon defs, -1 none
	f               int32 // when it became a source
	root            *Who  // who set it off; nil for nobody
	dmg             float32
	kills           int32
	landed          int32 // first frame its blast hit something, -1 not yet
	weapon          int32
	done            bool
}

type life struct {
	l       snapshot.UnitLife
	minFrac float64
}

type blow struct {
	by  Who
	src *source // the blast that dealt it, if one did
}

type rowKey struct{ aTeam, aDef, weapon, vTeam, vDef int32 }

type deriver struct {
	opt         Options
	sampleEvery int32
	defs        map[int32]snapshot.UnitDef
	aoe         map[int32]float32

	sources []*source
	byUnit  map[int32]*source

	open     map[int32]*life
	lives    []snapshot.UnitLife
	lastDef  map[int32]int32
	lastTeam map[int32]int32

	destroyed map[KillKey]snapshot.Event
	// killingBlow is the credited attacker of the hit that took each
	// unit's health to zero, for a death whose event names nobody.
	killingBlow map[int32]blow
	windows     map[int32]map[rowKey]*snapshot.DamageRow
	window      int32

	res Result
}

// Derive computes the Result from a re-simulation's record. meta supplies
// the unit defs (their explosion weapons and health) and the sample
// interval; facts supply the weapon table (explosion radii). A record with
// no hits and no unit ends derives an empty Result.
func Derive(meta snapshot.Meta, events []snapshot.Event, facts []snapshot.Fact, hits []snapshot.Hit, ends []snapshot.UnitEnd, opt Options) Result {
	d := &deriver{
		opt:         opt,
		sampleEvery: max(meta.SampleEvery, 1),
		defs:        meta.UnitDefs,
		aoe:         map[int32]float32{},
		byUnit:      map[int32]*source{},
		open:        map[int32]*life{},
		lastDef:     map[int32]int32{},
		lastTeam:    map[int32]int32{},
		destroyed:   map[KillKey]snapshot.Event{},
		killingBlow: map[int32]blow{},
		windows:     map[int32]map[rowKey]*snapshot.DamageRow{},
		window:      -1,
		res:         Result{Kills: map[KillKey]Kill{}},
	}
	for _, f := range facts {
		if f.Kind != snapshot.FactWeaponDefs {
			continue
		}
		var w snapshot.FactWeaponDefsData
		if f.Decode(&w) == nil {
			for _, wd := range w.Defs {
				if wd.AOE > 0 {
					d.aoe[wd.ID] = wd.AOE
				}
			}
		}
	}
	for _, e := range events {
		if e.Kind == snapshot.EventDestroyed {
			d.destroyed[KillKey{e.Frame, e.UnitID}] = e
		}
	}

	// One pass in the order things happened: a unit end sits before the
	// hit whose index it carries; events (births, transfers) apply once
	// their frame is reached.
	ei, ui := 0, 0
	applyEvents := func(frame int32) {
		for ei < len(events) && events[ei].Frame <= frame {
			d.event(events[ei])
			ei++
		}
	}
	for hi := 0; hi <= len(hits); hi++ {
		for ui < len(ends) && (hi == len(hits) || ends[ui].Hit <= int32(hi)) {
			applyEvents(ends[ui].Frame)
			d.enterWindow(ends[ui].Frame)
			d.end(ends[ui])
			ui++
		}
		if hi < len(hits) {
			applyEvents(hits[hi].Frame)
			d.enterWindow(hits[hi].Frame)
			d.hit(hits[hi])
		}
	}
	applyEvents(math.MaxInt32)
	d.expire(math.MaxInt32, true)
	d.finish()
	return d.res
}

func (d *deriver) event(e snapshot.Event) {
	switch e.Kind {
	case snapshot.EventCreated:
		d.close(e.UnitID, e.Frame) // a recycled id: the old life is over
		d.lastDef[e.UnitID] = e.DefID
		d.lastTeam[e.UnitID] = e.Team
		d.lifeOf(e.UnitID, e.Frame)
	case snapshot.EventGiven:
		d.lastTeam[e.UnitID] = e.Team
		if l := d.open[e.UnitID]; l != nil {
			l.l.Team = e.Team
		}
	case snapshot.EventDestroyed:
		d.lastDef[e.UnitID] = e.DefID
	}
}

// enterWindow moves to the sample window holding frame, retiring the blast
// sources that have aged out (as the widget did at each sample).
func (d *deriver) enterWindow(frame int32) {
	w := frame / d.sampleEvery * d.sampleEvery
	if w != d.window {
		d.window = w
		d.expire(w, false)
	}
}

func (d *deriver) lifeOf(unit, frame int32) *life {
	if l := d.open[unit]; l != nil {
		return l
	}
	def, ok := d.lastDef[unit]
	if !ok {
		def = -1
	}
	team, ok := d.lastTeam[unit]
	if !ok {
		team = -1
	}
	l := &life{l: snapshot.UnitLife{UnitID: unit, DefID: def, Team: team, Born: frame, Died: -1}, minFrac: 1}
	d.open[unit] = l
	return l
}

func (d *deriver) explosions(def int32) (death, selfd int32) {
	death, selfd = -1, -1
	ud, ok := d.defs[def]
	if !ok {
		return
	}
	if ud.DeathWeapon != nil {
		death = *ud.DeathWeapon
	}
	if ud.SelfDWeapon != nil {
		selfd = *ud.SelfDWeapon
	}
	return
}

// addSource makes unit a blast source credited to root (nil: nobody). A
// unit already a source keeps its root, gaining one only if it had none —
// its killing blow and its destroyed event both register it.
func (d *deriver) addSource(unit, def, team, x, z, frame int32, root *Who) {
	if s := d.byUnit[unit]; s != nil {
		if s.root == nil {
			s.root = root
		}
		return
	}
	death, selfd := d.explosions(def)
	if death < 0 && selfd < 0 {
		return
	}
	s := &source{unit: unit, def: def, team: team, x: float32(x), z: float32(z), death: death, selfd: selfd,
		f: frame, root: root, landed: -1, weapon: -1}
	d.sources = append(d.sources, s)
	d.byUnit[unit] = s
}

// blastSource is the source whose explosion a hit by weapon at (x, z) is,
// or nil: the nearest live source exploding with that weapon within the
// blast radius. A source explodes once, so one whose blast has not landed
// yet (or is landing this frame) wins over one already spent; spent ones
// are only a fallback, since a blast can land unseen.
func (d *deriver) blastSource(weapon, x, z, now int32) *source {
	if weapon < 0 {
		return nil
	}
	r := d.aoe[weapon] + d.opt.BlastSlack
	best, spent := (*source)(nil), (*source)(nil)
	bestD, spentD := r*r, r*r
	for _, s := range d.sources {
		if s.done || now-s.f > d.opt.BlastWindow || (s.death != weapon && s.selfd != weapon) {
			continue
		}
		dx, dz := s.x-float32(x), s.z-float32(z)
		dd := dx*dx + dz*dz
		if s.landed < 0 || s.landed == now {
			if dd <= bestD {
				best, bestD = s, dd
			}
		} else if dd <= spentD {
			spent, spentD = s, dd
		}
	}
	if best != nil {
		return best
	}
	return spent
}

// ownBlast is the source a hit or kill the engine credits to unit really
// is, when unit is a dead unit and the weapon its own explosion: the engine
// sometimes names the exploding unit as the attacker of its blast. Credit
// then belongs to whoever set it off, not to the dead unit's own side.
func (d *deriver) ownBlast(unit, weapon int32) *source {
	if unit < 0 || weapon < 0 {
		return nil
	}
	s := d.byUnit[unit]
	if s != nil && (s.death == weapon || s.selfd == weapon) {
		return s
	}
	return nil
}

func (d *deriver) hit(h snapshot.Hit) {
	if h.Damage <= 0 {
		return
	}
	st := &d.res.Stats
	st.Hits++
	if h.AttackerTeam >= 0 {
		st.NamedAttacker++
	}
	if h.WeaponDef >= 0 {
		st.NamedWeapon++
	} else if h.WeaponDef < -1 {
		st.EngineCause++
	}

	attacker := Who{h.Attacker, h.AttackerDef, h.AttackerTeam}
	var src *source
	var root *Who
	if s := d.ownBlast(h.Attacker, h.WeaponDef); s != nil {
		src, attacker = s, Nobody
	} else if h.AttackerTeam < 0 {
		if h.ProjTeam >= 0 {
			def := int32(-1)
			if h.ProjOwner >= 0 {
				if v, ok := d.lastDef[h.ProjOwner]; ok {
					def = v
				}
			}
			attacker = Who{-1, def, h.ProjTeam}
			r := attacker
			root = &r
			st.FromProjectile++
		} else if !h.Projectile {
			src = d.blastSource(h.WeaponDef, h.X, h.Z, h.Frame)
		}
	} else if h.Attacker >= 0 {
		r := attacker
		root = &r
	}
	if src != nil && src.root != nil {
		root = src.root
		attacker = *src.root
		if d.open[attacker.Unit] == nil {
			attacker.Unit = -1 // credit the unit only while it lives
		}
		st.FromChain++
	}

	removed := h.Removed()
	key := rowKey{attacker.Team, attacker.Def, h.WeaponDef, h.VictimTeam, h.VictimDef}
	rows := d.windows[d.window]
	if rows == nil {
		rows = map[rowKey]*snapshot.DamageRow{}
		d.windows[d.window] = rows
	}
	row := rows[key]
	if row == nil {
		row = &snapshot.DamageRow{AttackerTeam: key.aTeam, AttackerDef: key.aDef, WeaponDef: key.weapon,
			VictimTeam: key.vTeam, VictimDef: key.vDef}
		rows[key] = row
	}
	row.Hits++
	if h.Paralyzer {
		row.Paralyze += h.Damage
		return
	}
	row.Damage += removed
	st.Removed += float64(removed)
	if !attacker.Known() {
		st.UnknownRemoved += float64(removed)
	}

	if h.Victim >= 0 {
		v := d.lifeOf(h.Victim, h.Frame).fill(h.VictimDef, h.VictimTeam)
		v.l.Taken += removed
		if ud, ok := d.defs[h.VictimDef]; ok && ud.MaxHealth > 0 {
			frac := max(float64(h.HPAfter)/float64(ud.MaxHealth), 0)
			if frac < v.minFrac {
				v.minFrac = frac
			}
		}
	}
	if attacker.Unit >= 0 && attacker.Unit != h.Victim {
		d.lifeOf(attacker.Unit, h.Frame).fill(attacker.Def, attacker.Team).l.Dealt += removed
	}

	if src != nil {
		if src.landed < 0 {
			src.landed = h.Frame
		}
		src.weapon = h.WeaponDef
		src.dmg += removed
	}
	if h.HPAfter <= 0 && h.Victim >= 0 {
		d.killingBlow[h.Victim] = blow{attacker, src}
		d.addSource(h.Victim, h.VictimDef, h.VictimTeam, h.X, h.Z, h.Frame, root)
	}
}

func (d *deriver) end(u snapshot.UnitEnd) {
	if u.Alive {
		l := d.lifeOf(u.Unit, u.Frame)
		l.l.XP = u.XP
		d.close(u.Unit, -1)
		return
	}
	key := KillKey{u.Frame, u.Unit}
	ev, ok := d.destroyed[key]
	def, team := int32(-1), int32(-1)
	attacker, weapon := Nobody, int32(-1)
	if ok {
		def, team = ev.DefID, ev.Team
		if c := ev.Cause; c != nil {
			attacker, weapon = Who{c.UnitID, c.DefID, c.Team}, c.WeaponDef
		}
	} else {
		if v, ok := d.lastDef[u.Unit]; ok {
			def = v
		}
		if v, ok := d.lastTeam[u.Unit]; ok {
			team = v
		}
	}
	credit := attacker.Unit
	chain := false
	var src *source
	b, hasBlow := d.killingBlow[u.Unit]
	delete(d.killingBlow, u.Unit)
	if s := d.ownBlast(attacker.Unit, weapon); s != nil {
		src, attacker, credit = s, Nobody, -1
	} else if !attacker.Known() {
		src = d.blastSource(weapon, u.X, u.Z, u.Frame)
		if src == nil && hasBlow {
			// The engine named nothing, but the blow that killed it is
			// known: a blast's, or a shot credited through its projectile.
			src = b.src
			if src == nil && b.by.Known() {
				attacker, credit = b.by, b.by.Unit
				if d.open[credit] == nil {
					credit = -1
				}
			}
		}
	}
	if src != nil {
		src.kills++
		if src.root != nil {
			attacker, chain = *src.root, true
			credit = -1
			if d.open[attacker.Unit] != nil {
				credit = attacker.Unit // only while the root lives
			}
		}
	}
	d.res.Kills[key] = Kill{By: attacker, Weapon: weapon, Chain: chain}
	var root *Who
	if attacker.Known() {
		r := attacker
		root = &r
	}
	d.addSource(u.Unit, def, team, u.X, u.Z, u.Frame, root)

	l := d.lifeOf(u.Unit, u.Frame)
	if def >= 0 {
		l.l.DefID = def
	}
	if team >= 0 {
		l.l.Team = team
	}
	l.l.XP = u.XP
	d.close(u.Unit, u.Frame)
	if credit >= 0 && credit != u.Unit {
		d.lifeOf(credit, u.Frame).fill(attacker.Def, attacker.Team).l.Kills++
	}
}

// fill sets what a life does not know yet from a hit or kill naming it.
func (l *life) fill(def, team int32) *life {
	if l.l.DefID < 0 {
		l.l.DefID = def
	}
	if l.l.Team < 0 {
		l.l.Team = team
	}
	return l
}

func (d *deriver) close(unit, died int32) {
	l := d.open[unit]
	if l == nil {
		return
	}
	delete(d.open, unit)
	l.l.Died = died
	l.l.MinHealthPct = int32(math.Round(l.minFrac * 100))
	d.lives = append(d.lives, l.l)
}

// expire retires the sources older than the blast window at now (all of
// them when all), reporting the big blasts among them.
func (d *deriver) expire(now int32, all bool) {
	kept := d.sources[:0]
	for _, s := range d.sources {
		if !all && now-s.f <= d.opt.BlastWindow {
			kept = append(kept, s)
			continue
		}
		s.done = true
		if d.byUnit[s.unit] == s {
			delete(d.byUnit, s.unit)
		}
		if s.landed >= 0 && (s.dmg >= d.opt.BigBlastDamage || s.kills >= d.opt.BigBlastKills) {
			b := snapshot.FactBlastData{Frame: s.landed, Unit: s.unit, Def: s.def, Team: s.team,
				X: int32(s.x), Z: int32(s.z), Weapon: s.weapon, Damage: int32(s.dmg), Kills: s.kills}
			if r := s.root; r != nil {
				u, df, t := r.Unit, r.Def, r.Team
				if u >= 0 {
					b.ByUnit = &u
				}
				if df >= 0 {
					b.ByDef = &df
				}
				b.ByTeam = &t
			}
			d.res.Blasts = append(d.res.Blasts, b)
		}
	}
	d.sources = kept
}

func (d *deriver) finish() {
	// Lives the record never ended (a capture cut short) count as alive.
	ids := make([]int32, 0, len(d.open))
	for id := range d.open {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		d.close(id, -1)
	}
	sort.SliceStable(d.lives, func(i, j int) bool {
		a, b := d.lives[i], d.lives[j]
		if a.Born != b.Born {
			return a.Born < b.Born
		}
		return a.UnitID < b.UnitID
	})
	d.res.Lives = d.lives

	frames := make([]int32, 0, len(d.windows))
	for f := range d.windows {
		frames = append(frames, f)
	}
	sort.Slice(frames, func(i, j int) bool { return frames[i] < frames[j] })
	for _, f := range frames {
		w := snapshot.DamageWindow{Frame: f}
		for _, r := range d.windows[f] {
			w.Rows = append(w.Rows, *r)
		}
		sort.Slice(w.Rows, func(i, j int) bool { return lessRow(w.Rows[i], w.Rows[j]) })
		d.res.Windows = append(d.res.Windows, w)
	}
	sort.SliceStable(d.res.Blasts, func(i, j int) bool {
		a, b := d.res.Blasts[i], d.res.Blasts[j]
		if a.Frame != b.Frame {
			return a.Frame < b.Frame
		}
		return a.Unit < b.Unit
	})
}

func lessRow(a, b snapshot.DamageRow) bool {
	ka := [5]int32{a.AttackerTeam, a.AttackerDef, a.WeaponDef, a.VictimTeam, a.VictimDef}
	kb := [5]int32{b.AttackerTeam, b.AttackerDef, b.WeaponDef, b.VictimTeam, b.VictimDef}
	for i := range ka {
		if ka[i] != kb[i] {
			return ka[i] < kb[i]
		}
	}
	return false
}
