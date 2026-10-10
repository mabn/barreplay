package insights

import "testing"

func TestGameEnd(t *testing.T) {
	ro := roster{teams: []Team{
		{Team: 0, Side: 0}, {Team: 1, Side: 0},
		{Team: 2, Side: 1}, {Team: 3, Side: 1},
		{Team: 9, Side: -1}, // Gaia never counts
	}}
	cases := []struct {
		name string
		died map[int32]int32
		want int32
	}{
		{"nobody left", map[int32]int32{}, -1},
		{"one player of a side leaves mid-game", map[int32]int32{2: 9000}, -1},
		{"a side resigns, a straggler seconds later", map[int32]int32{2: 50000, 3: 50300}, 50000},
		{"an early leaver is not the surrender", map[int32]int32{2: 9000, 3: 50000}, 50000},
		{"Gaia dying ends nothing", map[int32]int32{9: 100}, -1},
	}
	for _, c := range cases {
		if got := gameEnd(c.died, ro); got != c.want {
			t.Errorf("%s: gameEnd = %d, want %d", c.name, got, c.want)
		}
	}

	// A free-for-all goes on until one side is left.
	ffa := roster{teams: []Team{{Team: 0, Side: 0}, {Team: 1, Side: 1}, {Team: 2, Side: 2}}}
	if got := gameEnd(map[int32]int32{1: 1000}, ffa); got != -1 {
		t.Errorf("ffa, one out: gameEnd = %d, want -1", got)
	}
	if got := gameEnd(map[int32]int32{1: 1000, 2: 5000}, ffa); got != 5000 {
		t.Errorf("ffa, two out: gameEnd = %d, want 5000", got)
	}
}
