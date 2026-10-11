package insights

import (
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

func TestUnitClass(t *testing.T) {
	for _, c := range []struct {
		def  snapshot.UnitDef
		want string
	}{
		{snapshot.UnitDef{Name: "armthund", CanFly: true, CanMove: true, WeaponCount: 1}, classBomber},
		{snapshot.UnitDef{Name: "corshad_scav", CanFly: true, CanMove: true, WeaponCount: 1}, classBomber},
		{snapshot.UnitDef{Name: "armfig", CanFly: true, CanMove: true, WeaponCount: 1}, classFighter},
		{snapshot.UnitDef{Name: "armbrawl", CanFly: true, CanMove: true, WeaponCount: 1}, classGunship},
		{snapshot.UnitDef{Name: "armca", CanFly: true, CanMove: true}, classAir},
		{snapshot.UnitDef{Name: "armroy", CanMove: true, WeaponCount: 2, MetalCost: 900}, classShip},
		{snapshot.UnitDef{Name: "corbats", CanMove: true, WeaponCount: 3, MetalCost: 4000}, classShip},
		{snapshot.UnitDef{Name: "corjugg", CanMove: true, WeaponCount: 3, MetalCost: 30000}, classExperimental},
		{snapshot.UnitDef{Name: "corak", CanMove: true, WeaponCount: 1, MetalCost: 40}, classArmy},
		{snapshot.UnitDef{Name: "armcom", CanMove: true, WeaponCount: 2}, classCommander},
		{snapshot.UnitDef{Name: "armbrtha", WeaponCount: 1, IsBuilding: true}, classLRGun},
		{snapshot.UnitDef{Name: "corsilo", WeaponCount: 1, IsBuilding: true}, classNuke},
		{snapshot.UnitDef{Name: "armllt", WeaponCount: 1, IsBuilding: true}, classDefence},
		{snapshot.UnitDef{Name: "armlab", IsBuilding: true, IsFactory: true, CanMove: true}, classFactory},
		{snapshot.UnitDef{Name: "armmex", IsBuilding: true, UnitGroup: "metal"}, classEco},
		{snapshot.UnitDef{Name: "armrad", IsBuilding: true}, classBuilding},
		{snapshot.UnitDef{Name: "armck", CanMove: true, IsBuilder: true}, classUnit},
		// A mod's unknown flyer is "air", never a guessed role.
		{snapshot.UnitDef{Name: "modbomber9000", CanFly: true, CanMove: true, WeaponCount: 1}, classAir},
	} {
		if got := unitClass(c.def); got != c.want {
			t.Errorf("unitClass(%s) = %q, want %q", c.def.Name, got, c.want)
		}
	}
}

func TestBattleKillers(t *testing.T) {
	// Team 2's bombers (def 9, two of them) kill four of team 1's units;
	// a death with no killer and one by its own side are not credited.
	p := &pass{hasCauses: true, ro: roster{teamSide: map[int32]int{1: 0, 2: 1}, sides: []Side{{}, {}}}, out: &Insights{}, usedDef: map[int32]bool{}}
	add := func(killer [2]int32, unit int32) {
		d := &p.out.Deaths
		d.F, d.X, d.Z, d.Def, d.Team, d.Cost = append(d.F, 3000), append(d.X, 1000), append(d.Z, 1000), append(d.Def, 1), append(d.Team, 1), append(d.Cost, 100)
		d.Unfinished, d.SelfD = append(d.Unfinished, 0), append(d.SelfD, 0)
		p.deathKiller = append(p.deathKiller, killer[0])
		p.deathKillerKind = append(p.deathKillerKind, killer)
		p.deathKillerUnit = append(p.deathKillerUnit, unit)
	}
	var members []int
	for i, u := range []int32{50, 51, 50, 51} {
		members = append(members, i)
		add([2]int32{2, 9}, u)
	}
	members = append(members, 4, 5)
	add([2]int32{-1, -1}, -1)
	add([2]int32{1, 1}, 7)
	b := p.battleOf(members, 2)
	by := b.Lost[0].By
	if len(by) != 1 || by[0] != (UnitKill{Team: 2, Def: 9, N: 4, Metal: 400, Units: 2}) {
		t.Fatalf("By = %+v", by)
	}
	if !p.usedDef[9] {
		t.Error("killer def not kept in Defs")
	}
	if b.Lost[1].By != nil {
		t.Errorf("side 1 lost nothing, By = %+v", b.Lost[1].By)
	}
}
