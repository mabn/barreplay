package insights

import "testing"

func TestFriendlyFireAndOwnBlasts(t *testing.T) {
	// Teams 1 and 3 share side 0, team 2 is side 1.
	p := &pass{hasCauses: true, ro: roster{teamSide: map[int32]int{1: 0, 2: 1, 3: 0}, sides: []Side{{}, {}}},
		out: &Insights{Teams: []Team{{Team: 1, Player: "Ann"}, {Team: 3, Player: "Cy"}}}, usedDef: map[int32]bool{}}
	add := func(f int32, unit, team int32, cost float64, killerUnit, killerTeam, killerDef, weapon int32) int {
		d := &p.out.Deaths
		d.F, d.X, d.Z, d.Def, d.Team, d.Cost = append(d.F, f), append(d.X, 100), append(d.Z, 100), append(d.Def, 1), append(d.Team, team), append(d.Cost, cost)
		d.Unfinished, d.SelfD = append(d.Unfinished, 0), append(d.SelfD, 0)
		p.deathUnit = append(p.deathUnit, unit)
		p.deathKiller = append(p.deathKiller, killerTeam)
		p.deathKillerKind = append(p.deathKillerKind, [2]int32{killerTeam, killerDef})
		p.deathKillerUnit = append(p.deathKillerUnit, killerUnit)
		p.deathWeapon = append(p.deathWeapon, weapon)
		return len(d.F) - 1
	}
	var members []int
	// An enemy gun (team 2, def 7) kills Ann's first fusion; the chain then
	// takes three more, each credited to the one exploding before it.
	members = append(members, add(1000, 10, 1, 1000, 99, 2, 7, 5))
	members = append(members, add(1001, 11, 1, 1000, 10, 1, 1, 6))
	members = append(members, add(1002, 12, 1, 1000, 11, 1, 1, 6))
	members = append(members, add(1003, 13, 1, 1000, 12, 1, 1, 6))
	bt := p.battleOf(members, 2)
	l := bt.Lost[0]
	if l.Own != 3000 || l.OwnDef != 1 || l.Trigger == nil || *l.Trigger != [2]int32{2, 7} {
		t.Errorf("own blasts = %+v, want 3000 by def 1, set off by team 2's def 7", l)
	}
	// Those chain kills are blasts, not friendly fire: no award.
	if a, ok := p.friendlyFire(); ok {
		t.Errorf("a chain of blasts got a friendly-fire award: %+v", a)
	}
	// Cy's living gun (unit 50, def 8) shells Ann's base: 2500 metal in 6 s.
	for i := int32(0); i < 5; i++ {
		add(5000+i*45, 60+i, 1, 500, 50, 3, 8, 9)
	}
	p.wiped = make([]bool, len(p.out.Deaths.F))
	a, ok := p.friendlyFire()
	if !ok || a.Team != 3 || a.Def != 8 || a.Value != 2500 || a.F0 != 5000 || a.F1 != 5180 || a.Pos == nil {
		t.Errorf("friendly fire = %+v, %v; want team 3's def 8, 2500 metal over 5000..5180", a, ok)
	}
}
