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
		{"teams knocked out in the final push are not the surrender", map[int32]int32{2: 50000, 3: 50800}, 50800},
	}
	for _, c := range cases {
		if got := gameEnd(c.died, ro); got != c.want {
			t.Errorf("%s: gameEnd = %d, want %d", c.name, got, c.want)
		}
	}

	// ccd1ca6a: an 8v8 whose losing side lost three teams one after another
	// (each within 30 s of the previous) before the other four resigned
	// together at 40:34. The game ends at the resign, not at the first of them.
	big := roster{}
	for t := int32(0); t < 16; t++ {
		big.teams = append(big.teams, Team{Team: t, Side: int(t / 8)})
	}
	died := map[int32]int32{11: 68461, 12: 71431, 9: 72061, 8: 72151, 15: 73021, 14: 73021, 13: 73021, 10: 73021}
	if got := gameEnd(died, big); got != 73021 {
		t.Errorf("ccd1ca6a: gameEnd = %d, want 73021", got)
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
