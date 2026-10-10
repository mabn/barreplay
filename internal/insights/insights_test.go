package insights

import (
	"bytes"
	"testing"
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
			if d.Def[i] != defFusion || d.Cost[i] != 3600 {
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
