package combat

import (
	"bytes"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

func i32(v int32) *int32 { return &v }

// A small battle: team 0's tank (1) kills team 1's reactor (10), whose
// blast kills the next reactor (11), whose blast hits a bot (12) — once
// with no attacker, once with the engine naming the exploding reactor.
// Team 1's shell lands after its shooter (20) died.
func scenario() (snapshot.Meta, []snapshot.Event, []snapshot.Fact, []snapshot.Hit, []snapshot.UnitEnd) {
	meta := snapshot.Meta{SampleEvery: 30, UnitDefs: map[int32]snapshot.UnitDef{
		1: {DefID: 1, Name: "tank", MaxHealth: 1000},
		2: {DefID: 2, Name: "reactor", MaxHealth: 500, DeathWeapon: i32(7)},
		3: {DefID: 3, Name: "bot", MaxHealth: 100},
		4: {DefID: 4, Name: "artillery", MaxHealth: 300},
	}}
	facts := []snapshot.Fact{mustFact(`{"k":"wdefs","defs":[{"id":3,"name":"cannon"},{"id":7,"name":"reactorblast","aoe":500}]}`)}
	created := func(u, def, team int32) snapshot.Event {
		return snapshot.Event{Frame: 0, Kind: snapshot.EventCreated, UnitID: u, DefID: def, Team: team}
	}
	events := []snapshot.Event{
		created(1, 1, 0), created(10, 2, 1), created(11, 2, 1), created(12, 3, 1), created(20, 4, 1),
		{Frame: 5, Kind: snapshot.EventDestroyed, UnitID: 20, DefID: 4, Team: 1,
			Cause: &snapshot.EventCause{UnitID: 1, DefID: 1, Team: 0, WeaponDef: 3}},
		{Frame: 40, Kind: snapshot.EventDestroyed, UnitID: 10, DefID: 2, Team: 1,
			Cause: &snapshot.EventCause{UnitID: 1, DefID: 1, Team: 0, WeaponDef: 3}},
		{Frame: 100, Kind: snapshot.EventDestroyed, UnitID: 11, DefID: 2, Team: 1},
	}
	hit := func(f, victim, vDef, vTeam, x int32, attacker, aDef, aTeam, weapon int32, dmg, after float32) snapshot.Hit {
		return snapshot.Hit{Frame: f, Victim: victim, VictimDef: vDef, VictimTeam: vTeam, X: x, Z: 0,
			Attacker: attacker, AttackerDef: aDef, AttackerTeam: aTeam, WeaponDef: weapon,
			ProjOwner: -1, ProjTeam: -1, Damage: dmg, HPAfter: after}
	}
	hits := []snapshot.Hit{
		hit(5, 20, 4, 1, 900, 1, 1, 0, 3, 400, -100),     // 0: tank kills artillery, 100 overkill
		hit(40, 10, 2, 1, 0, 1, 1, 0, 3, 600, -100),      // 1: tank kills reactor 10
		hit(90, 11, 2, 1, 200, -1, -1, -1, 7, 800, -300), // 2: 10's blast kills reactor 11
		hit(160, 12, 3, 1, 300, -1, -1, -1, 7, 60, 40),   // 3: 11's blast hits the bot
		hit(160, 12, 3, 1, 300, 11, 2, 1, 7, 30, 10),     // 4: ...named the reactor itself
		{Frame: 170, Victim: 1, VictimDef: 1, VictimTeam: 0, X: 0, Attacker: -1, AttackerDef: -1, AttackerTeam: -1,
			WeaponDef: 3, Projectile: true, ProjOwner: 20, ProjTeam: 1, Damage: 50, HPAfter: 950}, // 5: dead shooter's shell
	}
	ends := []snapshot.UnitEnd{
		{Frame: 5, Unit: 20, Hit: 1, X: 900},
		{Frame: 40, Unit: 10, Hit: 2, X: 0},
		{Frame: 100, Unit: 11, Hit: 3, X: 200},
		{Frame: 200, Unit: 1, Hit: 6, Alive: true, XP: 0.5},
		{Frame: 200, Unit: 12, Hit: 6, Alive: true},
	}
	return meta, events, facts, hits, ends
}

func mustFact(s string) snapshot.Fact {
	f, err := snapshot.ParseFact([]byte(s))
	if err != nil {
		panic(err)
	}
	return f
}

func TestDeriveChain(t *testing.T) {
	meta, events, facts, hits, ends := scenario()
	opt := DefaultOptions()
	opt.BigBlastDamage = 50
	r := Derive(meta, events, facts, hits, ends, opt)

	// Reactor 11 died in 10's blast: credited to the tank that killed 10.
	k := r.Kills[KillKey{100, 11}]
	if !k.Chain || k.By != (Who{1, 1, 0}) || k.Weapon != -1 {
		t.Errorf("reactor 11's kill = %+v", k)
	}
	if k := r.Kills[KillKey{40, 10}]; k.Chain || k.By != (Who{1, 1, 0}) {
		t.Errorf("reactor 10's kill = %+v", k)
	}

	// Damage per (attacker, weapon, victim), overkill removed; the shell of
	// the dead artillery names its team and def.
	got := map[rowKey]float32{}
	for _, w := range r.Windows {
		for _, row := range w.Rows {
			got[rowKey{row.AttackerTeam, row.AttackerDef, row.WeaponDef, row.VictimTeam, row.VictimDef}] += row.Damage
		}
	}
	want := map[rowKey]float32{
		{0, 1, 3, 1, 4}: 300, // 400 - 100 overkill
		{0, 1, 3, 1, 2}: 500,
		{0, 1, 7, 1, 2}: 500, // the blast that killed 11, credited to the tank
		{0, 1, 7, 1, 3}: 90,  // both hits on the bot, including the self-named one
		{1, 4, 3, 0, 1}: 50,  // the dead shooter's shell
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("damage %+v = %v, want %v (all: %v)", k, got[k], v, got)
		}
	}
	if len(got) != len(want) {
		t.Errorf("damage rows %v", got)
	}

	if r.Stats.FromChain != 3 || r.Stats.FromProjectile != 1 || r.Stats.Hits != 6 {
		t.Errorf("stats %+v", r.Stats)
	}

	// Lives: the tank killed three units (two directly, one by chain) and
	// dealt everything above but the shell; it survived with its XP.
	var tank *snapshot.UnitLife
	for i := range r.Lives {
		if r.Lives[i].UnitID == 1 {
			tank = &r.Lives[i]
		}
	}
	if tank == nil || tank.Kills != 3 || tank.Dealt != 300+500+500+90 || tank.Died != -1 || tank.XP != 0.5 || tank.Taken != 50 {
		t.Errorf("tank life %+v", tank)
	}

	// Both reactors' blasts landed; each is big at this threshold.
	if len(r.Blasts) != 2 || r.Blasts[0].Unit != 10 || r.Blasts[0].Damage != 500 || r.Blasts[0].Kills != 1 ||
		r.Blasts[0].ByUnit == nil || *r.Blasts[0].ByUnit != 1 || r.Blasts[1].Unit != 11 || r.Blasts[1].Damage != 90 {
		t.Errorf("blasts %+v", r.Blasts)
	}

	credited := r.Credit(events)
	if c := credited[7].Cause; c == nil || c.UnitID != 1 || c.Team != 0 {
		t.Errorf("credited cause of reactor 11 = %+v", c)
	}
	if events[7].Cause != nil {
		t.Error("Credit modified its input")
	}
}

func TestDeriveDeterministic(t *testing.T) {
	meta, events, facts, hits, ends := scenario()
	a := Derive(meta, events, facts, hits, ends, DefaultOptions())
	b := Derive(meta, events, facts, hits, ends, DefaultOptions())
	var ba, bb bytes.Buffer
	for _, w := range a.Windows {
		ba.WriteString(rowsString(w))
	}
	for _, w := range b.Windows {
		bb.WriteString(rowsString(w))
	}
	if ba.String() != bb.String() {
		t.Error("two derivations differ")
	}
}

func rowsString(w snapshot.DamageWindow) string {
	var b bytes.Buffer
	for _, r := range w.Rows {
		b.WriteString(string(rune(r.AttackerTeam + 'a')))
	}
	return b.String()
}
