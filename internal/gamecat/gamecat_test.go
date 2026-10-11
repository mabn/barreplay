package gamecat

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// detail builds a replay detail: teams of the given sizes, the first winning.
func detail(settings map[string]any, sizes ...int) *Detail {
	var teams []map[string]any
	for i, n := range sizes {
		ps := make([]map[string]any, n)
		for k := range ps {
			ps[k] = map[string]any{"name": fmt.Sprint("p", i, k)}
		}
		teams = append(teams, map[string]any{"winningTeam": i == 0, "Players": ps, "AIs": []any{}})
	}
	b, _ := json.Marshal(map[string]any{
		"durationMs": 30 * 60_000, "gameEndedNormally": true, "gameSettings": settings, "AllyTeams": teams,
	})
	var d Detail
	if err := json.Unmarshal(b, &d); err != nil {
		panic(err)
	}
	return &d
}

func tweak(lua string) string { return base64.StdEncoding.EncodeToString([]byte(lua)) }

func TestClassify(t *testing.T) {
	lava := map[string]any{"ranked_game": "0", "map_waterislava": "1",
		"tweakdefs": tweak("-- LavaPack v3\n..."), "tweakunits1": tweak("-- Roomba\n...")}
	cases := []struct {
		name string
		d    *Detail
		want Category
	}{
		{"lava lobby 8v8", detail(lava, 8, 8), Lava},
		{"lava tweaks but 7v8 is not stored", detail(lava, 7, 8), Unranked},
		{"lava map without the tweaks", detail(map[string]any{"ranked_game": "1", "map_waterislava": "1"}, 8, 8), LargeRanked},
		{"one core signature alone", detail(map[string]any{"ranked_game": "0", "tweakdefs": tweak("lavapack")}, 8, 8), Unranked},
		{"ranked 5v5", detail(map[string]any{"ranked_game": "1"}, 5, 5), LargeRanked},
		{"ranked 4v4", detail(map[string]any{"ranked_game": "1"}, 4, 4), Ranked},
		{"ranked FFA of 16", detail(map[string]any{"ranked_game": "1"}, 4, 4, 4, 4), Ranked},
		{"unranked 8v8", detail(map[string]any{"ranked_game": "0"}, 8, 8), Unranked},
		{"no ranked_game at all", detail(nil, 1, 1), Unranked},
	}
	for _, c := range cases {
		if got := Classify(c.d); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

// Corrupted padding (length = 1 mod 4) must still decode, as lavabalance's does.
func TestLenientBase64(t *testing.T) {
	enc := tweak("Lava QoL and OneBigNuke") + "A"
	if got := b64ToText(enc); !strings.Contains(strings.ToLower(got), "lava qol and onebignuke") {
		t.Fatalf("decoded %q", got)
	}
}
