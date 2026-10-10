package insights

import "testing"

func TestBattles(t *testing.T) {
	ins := computeFixture(t)
	if len(ins.Battles) != 1 {
		t.Fatalf("battles = %+v, want the one fight (the lone fusion is not a battle)", ins.Battles)
	}
	b := ins.Battles[0]
	// Side 1's last raider died walking in, 1500+ elmos east of the fight:
	// a straggler, not part of it.
	if b.F0 != 200*30 || b.Lost[0].N != 14 || b.Lost[1].N != 6 || b.Lost[0].Metal != 700 {
		t.Errorf("battle = %+v", b)
	}
	if b.X < 3500 || b.X > 4200 || len(b.Lost[0].Top) != 1 || b.Lost[0].Top[0] != defRaider {
		t.Errorf("battle centre/top = %d / %v", b.X, b.Lost[0].Top)
	}
	// Who fought it: every team's losses add up to its side's, and the
	// sides that lost raiders had an army there to lose them from.
	lost := make([]float64, len(b.Lost))
	army := make([]float64, len(b.Lost))
	for _, tm := range b.Teams {
		side := -1
		for _, x := range ins.Teams {
			if x.Team == tm.Team {
				side = x.Side
			}
		}
		if side < 0 {
			t.Fatalf("battle team %d has no side", tm.Team)
		}
		lost[side] += tm.Lost
		army[side] += tm.Army
	}
	for s := range b.Lost {
		if lost[s] != b.Lost[s].Metal || army[s] <= 0 {
			t.Errorf("side %d: teams lost %v (want %v), army %v", s, lost[s], b.Lost[s].Metal, army[s])
		}
	}
}

func TestAwards(t *testing.T) {
	ins := computeFixture(t)
	got := map[string]Award{}
	for _, a := range ins.Awards {
		got[a.Key] = a
	}
	// Every raider dies, and a commander outliving the game is no feat.
	if _, ok := got["immortal"]; ok {
		t.Errorf("immortal = %+v, want none", got["immortal"])
	}
	// The fusion is the costliest loss but went unfinished; it takes that
	// award, and the costliest FINISHED loss is a raider.
	if a := got["costliest"]; a.Def != defRaider || a.Value != 50 {
		t.Errorf("costliest = %+v", a)
	}
	if _, ok := got["tourist"]; ok {
		t.Errorf("tourist = %+v, want none (nobody covered 5%% of the map)", got["tourist"])
	}
	if a := got["unfinished"]; a.Def != defFusion || a.Team != 2 || a.F != 300*30 || a.Value != 3600 {
		t.Errorf("unfinished = %+v", a)
	}
	if a := got["marathon"]; a.Def != defRaider && a.Def != defCom {
		t.Errorf("marathon = %+v, want a walker", a)
	}
	if _, ok := ins.Defs[got["marathon"].Def]; !ok {
		t.Error("an award's def must be described in Defs")
	}
}

func TestFront(t *testing.T) {
	ins := computeFixture(t)
	f := ins.Series.Front
	if len(f[0]) != len(ins.Series.T) {
		t.Fatalf("front steps = %d, want %d", len(f[0]), len(ins.Series.T))
	}
	if f[0][2] != nil {
		t.Errorf("side 0 has no army at 30 s, front = %v", f[0][2])
	}
	// At 3 minutes side 0's raiders stand west of side 1's.
	a, b := f[0][12], f[1][12]
	if a == nil || b == nil || a[0] >= b[0] {
		t.Errorf("fronts at 180 s = %v / %v, want side 0 west of side 1", a, b)
	}
}

func TestBattlesLeaveOutEliminations(t *testing.T) {
	in, err := FromBRP(parseFixture(t, writeFixture(t)))
	if err != nil {
		t.Fatal(err)
	}
	// Team 0 is knocked out as the fight starts: its raiders dying from then
	// on go down with it, and the battle is what is left.
	in.TeamDied = map[int32]int32{0: 200 * 30, 4: 0}
	ins, err := Compute(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(ins.Eliminated) != 1 || ins.Eliminated[0] != (Elimination{F: 200 * 30, Team: 0, Recorded: true}) {
		t.Fatalf("eliminated = %+v, want team 0 only (team 4 is Gaia)", ins.Eliminated)
	}
	// Without the elimination side 0 loses 14 there (TestBattles); team 1
	// had only seven raiders to lose.
	if len(ins.Battles) != 1 || ins.Battles[0].Lost[0].N > 7 {
		t.Fatalf("battles = %+v, want side 0 losing only team 1's raiders", ins.Battles)
	}
}

func TestEliminationsInferred(t *testing.T) {
	teams := []Team{{Team: 0, Side: 0}, {Team: 1, Side: 0}, {Team: 2, Side: 1}, {Team: 3, Side: -1}}
	var d Deaths
	die := func(f, team int32) {
		d.F = append(d.F, f)
		d.Team = append(d.Team, team)
	}
	die(100, 0) // an early loss, not part of the burst
	for k := int32(0); k < 10; k++ {
		die(9000+k*3, 0) // team 0's units all go at once at the end
		die(9000+k*3, 1) // so do team 1's, but it still has units after
		die(9000+k*3, 3) // Gaia is never eliminated
	}
	for k := int32(0); k < 5; k++ {
		die(9500+k, 2) // too few to read as a team going down
	}
	lastAlive := map[int32]int32{0: 8990, 1: 9900, 2: 9000, 3: 0}
	got := eliminations(d, nil, lastAlive, teams)
	if len(got) != 1 || got[0] != (Elimination{F: 9000, Team: 0}) {
		t.Fatalf("eliminations = %+v, want team 0 at 9000", got)
	}
	w := wipedDeaths(d, got)
	if w[0] || !w[1] || w[2] {
		t.Errorf("wiped = %v, want only team 0's burst", w[:3])
	}
}
