package insights

import (
	"bytes"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

func TestSidesAndTeams(t *testing.T) {
	ins := computeFixture(t)
	if len(ins.Sides) != 2 {
		t.Fatalf("sides = %d, want 2 (Gaia has no player)", len(ins.Sides))
	}
	if got := ins.Sides[0].Players; len(got) != 2 || got[0] != "Ann" || got[1] != "Bob" {
		t.Errorf("side 0 players = %v, want [Ann Bob] (the spectator excluded)", got)
	}
	if ins.Teams[4].Side != -1 {
		t.Errorf("Gaia side = %d, want -1", ins.Teams[4].Side)
	}
	if ins.POV != POVFull || ins.CostCoverage != CostFull {
		t.Errorf("pov/cost = %s/%s", ins.POV, ins.CostCoverage)
	}
	if ins.DurationSec != fxDuration {
		t.Errorf("duration = %v, want %d", ins.DurationSec, fxDuration)
	}
}

func TestArmySeries(t *testing.T) {
	ins := computeFixture(t)
	s := ins.Series
	if want := fxDuration/StepSec + 1; len(s.T) != want {
		t.Fatalf("steps = %d, want %d", len(s.T), want)
	}
	// Step 12 holds its last sample, 194 s: side 0 has trained 14 raiders,
	// side 1 seven, and commanders are not army.
	step := 194 / StepSec
	if got := s.Army[0][step]; got != 14*50 {
		t.Errorf("side 0 army at 195s = %v, want 700", got)
	}
	if got := s.Army[1][step]; got != 7*50 {
		t.Errorf("side 1 army at 195s = %v, want 350", got)
	}
	if got := s.ArmyByCat[0][1][step]; got != 700 {
		t.Errorf("side 0 light army = %v, want 700", got)
	}
	// Value counts everything a side owns, commanders and buildings too, so
	// it is more than the army whenever there is one, and never nothing
	// while the side still stands.
	for side := range s.Value {
		for i, v := range s.Value[side] {
			if v < s.Army[side][i] || (s.Army[side][i] > 0 && v == s.Army[side][i]) {
				t.Fatalf("side %d step %d: value %v against army %v", side, i, v, s.Army[side][i])
			}
		}
	}
	// After the fight nobody has an army.
	if got := s.Army[0][len(s.T)-1] + s.Army[1][len(s.T)-1]; got != 0 {
		t.Errorf("army at end = %v, want 0", got)
	}
	// Income: side 0 = teams 0 + 1 = 10 + 11.
	if got := s.MetalIncome[0][5]; got != 21 {
		t.Errorf("side 0 metal income = %v, want 21", got)
	}
}

func TestDeaths(t *testing.T) {
	ins := computeFixture(t)
	d := ins.Deaths
	if len(d.F) != 14+7+1 {
		t.Fatalf("deaths = %d, want 22", len(d.F))
	}
	unfinished := 0
	for i := range d.F {
		if d.Unfinished[i] == 1 {
			unfinished++
			// Priced at the share of it built when last sampled, not its
			// whole 3600.
			if d.Def[i] != defFusion || d.Cost[i] != 1397.6 {
				t.Errorf("unfinished death = def %d cost %v", d.Def[i], d.Cost[i])
			}
		}
		// The first deaths are the earliest raiders, which had reached
		// their stop lines.
		if i < 2 && d.Def[i] == defRaider && (d.X[i] < 3800 || d.X[i] > 4200) {
			t.Errorf("first raiders died at x=%d, want 3800..4200", d.X[i])
		}
	}
	if unfinished != 1 {
		t.Errorf("unfinished deaths = %d, want 1", unfinished)
	}
	if ins.Defs[defRaider].Human != "Pawn" {
		t.Errorf("defs[raider] = %+v", ins.Defs[defRaider])
	}
}

func TestMilestones(t *testing.T) {
	ins := computeFixture(t)
	type key struct {
		k    string
		side int
	}
	got := map[key]int32{}
	for _, m := range ins.Milestones {
		got[key{m.Key, m.Side}] = m.F
	}
	want := map[key]int32{{"t2lab", 0}: 120 * 30, {"t2lab", 1}: 150 * 30, {"fusion", 1}: 240 * 30}
	if len(got) != len(want) {
		t.Errorf("milestones = %+v", ins.Milestones)
	}
	for k, f := range want {
		if got[k] != f {
			t.Errorf("%v at frame %d, want %d", k, got[k], f)
		}
	}
}

func TestChatAndMarks(t *testing.T) {
	ins := computeFixture(t)
	if len(ins.Chat) != 3 {
		t.Fatalf("chat = %+v", ins.Chat)
	}
	if ins.Chat[1].Side != 1 || ins.Chat[2].Side != -1 {
		t.Errorf("chat sides = %d, %d; want 1 and -1 (spectator)", ins.Chat[1].Side, ins.Chat[2].Side)
	}
	if got := ins.Marks[1][6030/30/StepSec]; got != 1 {
		t.Errorf("side 1 pings = %d, want 1", got)
	}
}

func TestDeterministic(t *testing.T) {
	path := writeFixture(t)
	var out [2][]byte
	for i := range out {
		in, err := FromBRP(parseFixture(t, path))
		if err != nil {
			t.Fatal(err)
		}
		ins, err := Compute(in)
		if err != nil {
			t.Fatal(err)
		}
		if out[i], err = Marshal(ins); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(out[0], out[1]) {
		t.Error("two computations of the same replay differ")
	}
}

// In a capture that names causes, a unit its own side took down is gone but
// not lost: reclaimed by a teammate, or a structure going with no cause at
// all (an upgrade, a cancelled build). An enemy reclaiming it, or a mobile
// unit dying with no cause (a crash), is still a loss.
func TestRemovedByOwnerIsNotALoss(t *testing.T) {
	type rule func(e snapshot.Event, own, foe int32) *snapshot.EventCause
	compute := func(structure bool, first rule) (*Insights, snapshot.Event) {
		in, err := FromBRP(parseFixture(t, writeFixture(t)))
		if err != nil {
			t.Fatal(err)
		}
		sideOf := map[int32]int{}
		for _, tm := range in.Meta.Teams {
			sideOf[tm.TeamID] = int(tm.AllyTeam)
		}
		played := map[int32]bool{}
		for _, pl := range in.Meta.Players {
			played[pl.Team] = !pl.Spectator
		}
		// The lowest-numbered played team on another side: deterministic,
		// and never Gaia.
		foeOf := func(team int32) int32 {
			foe := int32(-1)
			for t2, sd := range sideOf {
				if sd != sideOf[team] && played[t2] && (foe < 0 || t2 < foe) {
					foe = t2
				}
			}
			return foe
		}
		var hit snapshot.Event
		seen := false
		for i, e := range in.Events {
			if e.Kind != snapshot.EventDestroyed {
				continue
			}
			// Every death is a kill by the enemy, except the first mobile
			// (or structure) one, which the rule decides: so the capture
			// names causes, like a re-simulation.
			if !seen && isStructure(in.Meta.UnitDefs[e.DefID]) == structure {
				seen = true
				in.Events[i].Cause = first(e, e.Team, foeOf(e.Team))
				hit = in.Events[i]
				continue
			}
			in.Events[i].Cause = &snapshot.EventCause{UnitID: 1, DefID: 1, Team: foeOf(e.Team), WeaponDef: 1}
		}
		ins, err := Compute(in)
		if err != nil {
			t.Fatal(err)
		}
		return ins, hit
	}
	lost := func(ins *Insights, team int32) (n int) {
		for _, p := range ins.Players {
			if p.Team == team {
				for _, v := range p.Strip.LostN {
					n += v
				}
			}
		}
		return n
	}
	killed, e := compute(false, func(e snapshot.Event, own, foe int32) *snapshot.EventCause {
		return &snapshot.EventCause{UnitID: 1, DefID: 1, Team: foe, WeaponDef: 1}
	})
	// Every death names its killer, so a battle credits each side with
	// exactly what the other lost there.
	for _, b := range killed.Battles {
		credit := make([]float64, len(b.Lost))
		for _, tm := range b.Teams {
			for _, x := range killed.Teams {
				if x.Team == tm.Team && x.Side >= 0 {
					credit[x.Side] += tm.Killed
				}
			}
		}
		if len(credit) != 2 || credit[0] != b.Lost[1].Metal || credit[1] != b.Lost[0].Metal || credit[0] == 0 {
			t.Errorf("battle credit %v, losses %+v", credit, b.Lost)
		}
	}
	n := len(killed.Deaths.F)
	for _, c := range []struct {
		name      string
		structure bool
		rule      rule
		deaths    int
	}{
		{"reclaimed by its own team", false, func(e snapshot.Event, own, foe int32) *snapshot.EventCause {
			return &snapshot.EventCause{UnitID: 1, DefID: 1, Team: own, WeaponDef: weaponReclaimed}
		}, n - 1},
		{"reclaimed by the enemy", false, func(e snapshot.Event, own, foe int32) *snapshot.EventCause {
			return &snapshot.EventCause{UnitID: 1, DefID: 1, Team: foe, WeaponDef: weaponReclaimed}
		}, n},
		{"a mobile unit gone with no cause", false, func(snapshot.Event, int32, int32) *snapshot.EventCause { return nil }, n},
	} {
		got, _ := compute(c.structure, c.rule)
		if len(got.Deaths.F) != c.deaths {
			t.Errorf("%s: deaths %d, want %d", c.name, len(got.Deaths.F), c.deaths)
		}
		if want := lost(killed, e.Team) - (n - c.deaths); lost(got, e.Team) != want {
			t.Errorf("%s: player lost %d, want %d", c.name, lost(got, e.Team), want)
		}
	}
	// A structure going with no cause was replaced or cancelled: not a loss.
	kept, _ := compute(true, func(e snapshot.Event, own, foe int32) *snapshot.EventCause {
		return &snapshot.EventCause{UnitID: 1, DefID: 1, Team: foe, WeaponDef: 1}
	})
	gone, _ := compute(true, func(snapshot.Event, int32, int32) *snapshot.EventCause { return nil })
	if len(gone.Deaths.F) != len(kept.Deaths.F)-1 {
		t.Errorf("a structure gone with no cause: deaths %d, want %d", len(gone.Deaths.F), len(kept.Deaths.F)-1)
	}
}
