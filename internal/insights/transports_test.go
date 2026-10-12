package insights

import (
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

func TestPowerPlants(t *testing.T) {
	plant := func(name, group string) snapshot.UnitDef {
		return snapshot.UnitDef{Name: name, UnitGroup: group, IsBuilding: true}
	}
	for _, d := range []snapshot.UnitDef{plant("armfus", "energy"), plant("corafus", "energy"), plant("armwin", ""),
		plant("legadvsol", "energy"), plant("armuwgeo", "energy"), plant("afuslegendary", "energy"), plant("cortide_scav", "energy")} {
		if !isPowerPlant(d) || worthPerMetal(d, false) != powerWorth || worthPerMetal(d, true) != powerWorth {
			t.Errorf("%s is a power plant", d.Name)
		}
	}
	// Storage shares the group, a converter makes metal, a fusion-armed
	// unit is no building.
	for _, d := range []snapshot.UnitDef{plant("armestor", "energy"), plant("armmmkr", "metal"), plant("armmex", "metal"),
		{Name: "armfus", UnitGroup: "energy", CanMove: true, Speed: 1}} {
		if isPowerPlant(d) {
			t.Errorf("%s is not a power plant", d.Name)
		}
	}
}

func TestBuildingWorth(t *testing.T) {
	for _, c := range []struct {
		d      snapshot.UnitDef
		causes bool
		want   float64
	}{
		{snapshot.UnitDef{Name: "armllt", IsBuilding: true, WeaponCount: 1}, true, buildingWorth},
		{snapshot.UnitDef{Name: "armmex", UnitGroup: "metal", IsBuilding: true}, true, buildingWorth},
		{snapshot.UnitDef{Name: "armlab", IsFactory: true, IsBuilding: true, CanMove: true}, true, buildingWorth},
		// Without killers a reclaim reads as a loss: buildings stay plain.
		{snapshot.UnitDef{Name: "armllt", IsBuilding: true, WeaponCount: 1}, false, 1},
		{snapshot.UnitDef{Name: "armpw", CanMove: true, Speed: 1, WeaponCount: 1}, true, 1},
	} {
		if got := worthPerMetal(c.d, c.causes); got != c.want {
			t.Errorf("%s (causes %v): worth %v, want %v", c.d.Name, c.causes, got, c.want)
		}
	}
}

func TestIdleTransports(t *testing.T) {
	const tdef, gdef = 1, 2
	ro := roster{teamSide: map[int32]int{1: 0, 2: 1}}
	p := &pass{ro: ro, tracks: map[int32]*track{}, usedDef: map[int32]bool{}, defs: map[int32]defInfo{
		tdef: {fly: true, transport: true, cost: 100, worth: 1},
		gdef: {cost: 50, worth: 1},
	}}
	frame := func(f int32, us ...snapshot.UnitState) {
		fr := snapshot.Frame{Frame: f, Units: us}
		p.carryFrame(fr)
		for _, u := range fr.Units {
			p.trackUnit(f, u, p.defs[u.DefID])
		}
	}
	at := func(id, def, team int32, x float32) snapshot.UnitState {
		return snapshot.UnitState{UnitID: id, DefID: def, Team: team, Pos: snapshot.Vec3{X: x, Z: 100}, Health: 1, MaxHealth: 1, BuildProgress: 1}
	}
	// Team 1 parks six transports; team 2 has six too, and one of them
	// carries its tank 300 elmos.
	var a, b []snapshot.UnitState
	for i := int32(0); i < 6; i++ {
		a = append(a, at(10+i, tdef, 1, 1000+float32(i)*200))
		b = append(b, at(20+i, tdef, 2, 5000+float32(i)*200))
	}
	frame(0, append(append(append([]snapshot.UnitState{}, a...), b...), at(30, gdef, 2, 5000))...)
	b[0].Pos.X += 300
	frame(30, append(append(append([]snapshot.UnitState{}, a...), b...), at(30, gdef, 2, 5300))...)
	if !p.tracks[20].carried || p.tracks[21].carried || p.tracks[10].carried {
		t.Fatalf("carried: 20=%v 21=%v 10=%v", p.tracks[20].carried, p.tracks[21].carried, p.tracks[10].carried)
	}
	aw, ok := p.idleTransports()
	if !ok || aw.Team != 1 || aw.Def != tdef || aw.Value != 6 || aw.Unit != 15 {
		t.Fatalf("award = %+v %v, want team 1's six", aw, ok)
	}
	// Team 2's five idle of six would qualify on their own too (5/6 > 75%);
	// with them used, neither would.
	for _, id := range []int32{10, 11, 21, 22} {
		p.tracks[id].carried = true
	}
	if aw, ok := p.idleTransports(); ok {
		t.Errorf("award = %+v, want none: under %d idle", aw, idleMin)
	}
}
