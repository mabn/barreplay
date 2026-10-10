package insights

import "testing"

func TestBattles(t *testing.T) {
	ins := computeFixture(t)
	if len(ins.Battles) != 1 {
		t.Fatalf("battles = %+v, want the one fight (the lone fusion is not a battle)", ins.Battles)
	}
	b := ins.Battles[0]
	if b.F0 != 200*30 || b.Lost[0].N != 14 || b.Lost[1].N != 7 || b.Lost[0].Metal != 700 {
		t.Errorf("battle = %+v", b)
	}
	if b.X < 3500 || b.X > 4200 || len(b.Lost[0].Top) != 1 || b.Lost[0].Top[0] != defRaider {
		t.Errorf("battle centre/top = %d / %v", b.X, b.Lost[0].Top)
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
