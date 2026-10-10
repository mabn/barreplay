package insights

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// The scripted test game: a 2v2 on a 8192x8192 map, six minutes at 1 Hz.
//
//   - Side 0 (teams 0, 1) starts in the west, side 1 (teams 2, 3) in the east.
//   - Each team has a commander at its base. Team 0's walks east to x=3000.
//   - From t=60 s side 0 trains a raider every 10 s that walks east and
//     stops at x=3800; side 1 trains one every 20 s that stops at x=4200.
//   - At t=200 s the fight starts at x=4000: every second, one raider of
//     each side dies, side 1 losing two per second until it runs out.
//   - Milestones: team 0 finishes a T2 lab at 120 s, team 2 at 150 s, team 3
//     a fusion at 240 s.
//   - Team 2 starts a fusion at 260 s that is destroyed unfinished at 300 s.
//   - Team 0 sits on full metal storage from 100 s to 160 s.
//   - Team 1 has a constructor with no target, standing still, all game.
const (
	fxDuration = 360
	defCom     = 1
	defRaider  = 2
	defT2Lab   = 3
	defFusion  = 4
	defCons    = 5
	defCorLab  = 6
	defFusion2 = 7
)

var fixtureDefs = map[int32]snapshot.UnitDef{
	defCom:     {DefID: defCom, Name: "armcom", HumanName: "Armada Commander", CanMove: true, Speed: 37, WeaponCount: 2, MetalCost: 2700, IsBuilder: true},
	defRaider:  {DefID: defRaider, Name: "armpw", HumanName: "Pawn", CanMove: true, Speed: 58, WeaponCount: 1, MetalCost: 50},
	defT2Lab:   {DefID: defT2Lab, Name: "armalab", HumanName: "Advanced Bot Lab", IsBuilding: true, IsFactory: true, MetalCost: 2900, XSize: 7, ZSize: 7},
	defFusion:  {DefID: defFusion, Name: "corfus", HumanName: "Fusion Reactor", IsBuilding: true, MetalCost: 3600, XSize: 10, ZSize: 10},
	defCons:    {DefID: defCons, Name: "armck", HumanName: "Construction Bot", CanMove: true, Speed: 40, IsBuilder: true, MetalCost: 110},
	defCorLab:  {DefID: defCorLab, Name: "coralab", HumanName: "Advanced Bot Lab", IsBuilding: true, IsFactory: true, MetalCost: 2900, XSize: 7, ZSize: 7},
	defFusion2: {DefID: defFusion2, Name: "armfus", HumanName: "Fusion Reactor", IsBuilding: true, MetalCost: 3600, XSize: 10, ZSize: 10},
}

type fxUnit struct {
	id, def, team int32
	x, z, hp      float32
	build         float32
	target        int32
	born          int // second it appears
}

// writeFixture writes the scripted game as a .brp and returns its path.
func writeFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	w, err := snapshot.NewBRPWriter(dir, "fx")
	if err != nil {
		t.Fatal(err)
	}
	meta := snapshot.Meta{
		GameID: "fx", MapName: "Test Map", SampleEvery: 30,
		UnitDefs: fixtureDefs,
		Teams: []snapshot.TeamInfo{
			{TeamID: 0, AllyTeam: 0, Color: "#0000ff"}, {TeamID: 1, AllyTeam: 0, Color: "#0088ff"},
			{TeamID: 2, AllyTeam: 1, Color: "#ff0000"}, {TeamID: 3, AllyTeam: 1, Color: "#ff8800"},
			{TeamID: 4, AllyTeam: 2}, // Gaia
		},
		Players: []snapshot.PlayerInfo{
			{PlayerID: 0, Name: "Ann", Team: 0}, {PlayerID: 1, Name: "Bob", Team: 1},
			{PlayerID: 2, Name: "Cid", Team: 2}, {PlayerID: 3, Name: "Dee", Team: 3},
			{PlayerID: 4, Name: "Spec", Team: 0, Spectator: true},
		},
	}
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}

	nextID := int32(100)
	alive := map[int32]*fxUnit{}
	add := func(def, team int32, x, z float32, sec int) *fxUnit {
		u := &fxUnit{id: nextID, def: def, team: team, x: x, z: z, hp: 100, build: 1, born: sec}
		nextID++
		alive[u.id] = u
		return u
	}
	var events []snapshot.Event
	ev := func(sec int, kind snapshot.EventKind, u *fxUnit) {
		events = append(events, snapshot.Event{Frame: int32(sec * 30), Kind: kind, UnitID: u.id, DefID: u.def, Team: u.team})
	}
	coms := []*fxUnit{
		add(defCom, 0, 1000, 2000, 0), add(defCom, 1, 1000, 6000, 0),
		add(defCom, 2, 7000, 2000, 0), add(defCom, 3, 7000, 6000, 0),
	}
	for _, c := range coms {
		ev(0, snapshot.EventCreated, c)
		ev(0, snapshot.EventFinished, c)
	}
	cons := add(defCons, 1, 1200, 6000, 0)
	ev(0, snapshot.EventCreated, cons)
	ev(0, snapshot.EventFinished, cons)

	var west, east []*fxUnit
	var lab0, lab2, fus3, fus2 *fxUnit
	for sec := 1; sec <= fxDuration; sec++ {
		// Training.
		if sec >= 60 && sec < 200 && sec%10 == 0 {
			u := add(defRaider, int32(sec/10%2), 1500, 4000, sec)
			ev(sec, snapshot.EventCreated, u)
			ev(sec, snapshot.EventFinished, u)
			west = append(west, u)
		}
		if sec >= 60 && sec < 200 && sec%20 == 0 {
			u := add(defRaider, 2+int32(sec/20%2), 6500, 4000, sec)
			ev(sec, snapshot.EventCreated, u)
			ev(sec, snapshot.EventFinished, u)
			east = append(east, u)
		}
		// Buildings.
		switch sec {
		case 100:
			lab0 = add(defT2Lab, 0, 900, 1800, sec)
			lab0.build = 0
			ev(sec, snapshot.EventCreated, lab0)
		case 130:
			lab2 = add(defCorLab, 2, 7100, 1800, sec)
			lab2.build = 0
			ev(sec, snapshot.EventCreated, lab2)
		case 200:
			fus3 = add(defFusion2, 3, 7100, 6200, sec)
			fus3.build = 0
			ev(sec, snapshot.EventCreated, fus3)
		case 260:
			fus2 = add(defFusion, 2, 7300, 2200, sec)
			fus2.build = 0
			ev(sec, snapshot.EventCreated, fus2)
		}
		progress := func(u *fxUnit, from, to int) {
			if u == nil || sec < from || sec > to {
				return
			}
			u.build = float32(sec-from) / float32(to-from)
			if sec == to {
				ev(sec, snapshot.EventFinished, u)
			}
		}
		progress(lab0, 100, 120)
		progress(lab2, 130, 150)
		progress(fus3, 200, 240)
		if fus2 != nil && sec > 260 && sec < 300 {
			fus2.build = float32(sec-260) / 100
		}
		if sec == 300 {
			ev(sec, snapshot.EventDestroyed, fus2)
			delete(alive, fus2.id)
		}
		// Movement.
		if coms[0].x < 3000 {
			coms[0].x += 20
		}
		for _, u := range west {
			if u.x < 3800 {
				u.x += 50
			}
		}
		for _, u := range east {
			if u.x > 4200 {
				u.x -= 50
			}
		}
		// The fight.
		if sec >= 200 {
			kill := func(list *[]*fxUnit, n int) {
				for i := 0; i < n && len(*list) > 0; i++ {
					u := (*list)[0]
					*list = (*list)[1:]
					ev(sec, snapshot.EventDestroyed, u)
					delete(alive, u.id)
				}
			}
			kill(&west, 1)
			kill(&east, 2)
		}

		fr := snapshot.Frame{Frame: int32(sec * 30), TimeSec: float32(sec)}
		for _, u := range sortedUnits(alive) {
			fr.Units = append(fr.Units, snapshot.UnitState{
				UnitID: u.id, DefID: u.def, Team: u.team,
				Pos:    snapshot.Vec3{X: u.x, Z: u.z},
				Health: u.hp, MaxHealth: 100, BuildProgress: u.build, TargetID: u.target,
			})
		}
		for team := int32(0); team < 4; team++ {
			r := snapshot.TeamResource{Team: team, Metal: 200, MetalStorage: 1000, Energy: 500, EnergyStorage: 5000, MetalIncome: float32(10 + team), EnergyIncome: 100}
			if team == 0 && sec >= 100 && sec < 160 {
				r.Metal = 1000
			}
			fr.Resources = append(fr.Resources, r)
		}
		if err := w.WriteFrame(fr); err != nil {
			t.Fatal(err)
		}
	}
	for _, e := range events {
		if err := w.WriteEvent(e); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []snapshot.Comm{
		{Frame: 30, Kind: snapshot.CommChat, PlayerID: 0, Name: "Ann", Dest: snapshot.DestAll, Text: "gl hf"},
		{Frame: 6000, Kind: snapshot.CommChat, PlayerID: 2, Name: "Cid", Dest: snapshot.DestAlly, Text: "they push mid"},
		{Frame: 6030, Kind: snapshot.CommPoint, PlayerID: 2, Name: "Cid", X: 4000, Z: 4000},
		{Frame: 9000, Kind: snapshot.CommChat, PlayerID: 4, Name: "Spec", Dest: snapshot.DestSpec, Text: "nice"},
	} {
		if err := w.WriteComm(c); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "fx.brp")
}

func sortedUnits(m map[int32]*fxUnit) []*fxUnit {
	out := make([]*fxUnit, 0, len(m))
	for _, u := range m {
		out = append(out, u)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].id < out[j-1].id; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func parseFixture(t *testing.T, path string) *snapshot.BRPFile {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	bf, err := snapshot.ParseBRP(f)
	if err != nil {
		t.Fatal(err)
	}
	return bf
}

func computeFixture(t *testing.T) *Insights {
	t.Helper()
	in, err := FromBRP(parseFixture(t, writeFixture(t)))
	if err != nil {
		t.Fatal(err)
	}
	ins, err := Compute(in)
	if err != nil {
		t.Fatal(err)
	}
	return ins
}
