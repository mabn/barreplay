package main

import (
	"encoding/json"
	"math"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/mabn/barreplay/internal/gamecat"
	"github.com/mabn/barreplay/internal/insights"
)

// Games won by the side with the bigger army, with some noise: the fit must
// load them, give army a positive weight, and beat a model that knows nothing.
func TestFitRecoversTheSignal(t *testing.T) {
	dir := t.TempDir()
	rng := rand.New(rand.NewSource(1))
	for g := 0; g < 60; g++ {
		n := 40
		lead := rng.NormFloat64()
		s := insights.Series{Army: [][]float64{make([]float64, n), make([]float64, n)}, MetalIncome: [][]float64{make([]float64, n), make([]float64, n)}}
		for i := 0; i < n; i++ {
			s.T = append(s.T, float64(i*insights.StepSec))
			base := float64(i * 200)
			s.Army[0][i] = base * (1 + 0.3*lead)
			s.Army[1][i] = base
			s.MetalIncome[0][i], s.MetalIncome[1][i] = 10, 10
		}
		winner := 1
		if lead+0.3*rng.NormFloat64() > 0 {
			winner = 0
		}
		ins := insights.Insights{Version: insights.Version, POV: insights.POVFull, Winner: winner, Series: s, Swing: &insights.Swing{}}
		b, _ := json.Marshal(ins)
		os.WriteFile(filepath.Join(dir, insights.FileName(string(rune('a'+g%26))+string(rune('a'+g/26)))), b, 0o644)
	}
	os.WriteFile(filepath.Join(dir, "x.insights1.json"), []byte(`{"version":1}`), 0o644) // skipped
	var ss []sample
	for _, p := range must(filepath.Glob(filepath.Join(dir, "*.json"))) {
		_, got, ok, err := load(p)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			ss = append(ss, got...)
		}
	}
	c := newton(metalModel, ss, 1e-3)
	if c[0] <= 0 {
		t.Fatalf("army coefficient %v, want positive", c)
	}
	if l, chance := loss(metalModel, c, ss), loss(metalModel, make([]float64, 3), ss); l >= chance {
		t.Errorf("fit loss %v is no better than chance %v", l, chance)
	}
}

// Games won by the side with more energy income while metal is level: the
// energy model must find the signal the metal model cannot, and the combined
// model must do at least as well as the energy one.
func TestEnergyModelFindsEnergySignal(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	var ss []sample
	for g := 0; g < 80; g++ {
		n := 40
		lead := rng.NormFloat64()
		zero := func() [][]float64 { return [][]float64{make([]float64, n), make([]float64, n)} }
		s := insights.Series{Army: zero(), MetalIncome: zero(), EnergyIncome: zero()}
		for i := 0; i < n; i++ {
			s.T = append(s.T, float64(i*insights.StepSec))
			s.Army[0][i], s.Army[1][i] = 1000, 1000
			s.MetalIncome[0][i], s.MetalIncome[1][i] = 10, 10
			s.EnergyIncome[0][i] = 200 * (1 + 0.3*lead)
			s.EnergyIncome[1][i] = 200
		}
		winner := 1
		if lead+0.3*rng.NormFloat64() > 0 {
			winner = 0
		}
		ins := insights.Insights{Version: insights.Version, POV: insights.POVFull, Winner: winner, Series: s, Swing: &insights.Swing{}}
		p := filepath.Join(t.TempDir(), "g.insights.json")
		b, _ := json.Marshal(ins)
		os.WriteFile(p, b, 0o644)
		_, got, ok, err := load(p)
		if err != nil || !ok {
			t.Fatalf("load: ok=%v err=%v", ok, err)
		}
		ss = append(ss, got...)
	}
	metal := loss(metalModel, newton(metalModel, ss, 1e-3), ss)
	ec := newton(energyModel, ss, 1e-3)
	energy := loss(energyModel, ec, ss)
	both := loss(bothModel, newton(bothModel, ss, 1e-3), ss)
	if ec[1]+ec[2] <= 0 {
		t.Errorf("energy coefficients %v, want positive", ec)
	}
	if energy >= metal {
		t.Errorf("energy loss %v not below metal loss %v", energy, metal)
	}
	if both > energy+1e-6 {
		t.Errorf("metal+energy loss %v above energy loss %v", both, energy)
	}
}

func loss(m model, c []float64, ss []sample) float64 {
	l := 0.0
	for _, s := range ss {
		p := prob(m, c, s.f)
		if s.y == 1 {
			l -= s.w * logf(p)
		} else {
			l -= s.w * logf(1-p)
		}
	}
	return l
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func logf(p float64) float64 { return math.Log(p) }

// Games are sorted by their BAR API detail, a good detail is cached and read
// back without the API, and a game the API does not know is "unknown".
func TestCategorizeFetchesAndCaches(t *testing.T) {
	ranked := `{"durationMs":1200000,"gameSettings":{"ranked_game":"1"},"AllyTeams":[{"Players":[{},{},{},{},{}]},{"Players":[{},{},{},{},{}]}]}`
	duel := `{"durationMs":1200000,"gameSettings":{"ranked_game":"1"},"AllyTeams":[{"Players":[{}]},{"Players":[{}]}]}`
	unranked := `{"durationMs":1200000,"gameSettings":{"ranked_game":"0"},"AllyTeams":[{"Players":[{}]},{"Players":[{}]}]}`
	ids := map[string]string{
		strings.Repeat("a", 32): ranked,
		strings.Repeat("b", 32): duel,
		strings.Repeat("c", 32): unranked,
	}
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if b, ok := ids[strings.TrimPrefix(r.URL.Path, "/replays/")]; ok {
			w.Write([]byte(b))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	gs := []game{{id: strings.Repeat("a", 32)}, {id: strings.Repeat("b", 32)}, {id: strings.Repeat("c", 32)}, {id: strings.Repeat("d", 32)}}
	f := &detailFetcher{base: srv.URL, dir: t.TempDir(), http: srv.Client()}
	got := categorize(gs, f)
	want := map[gamecat.Category]int{gamecat.LargeRanked: 1, gamecat.Ranked: 1, gamecat.Unranked: 1, unknown: 1}
	for c, n := range want {
		if len(got[c]) != n {
			t.Errorf("%s: %d games, want %d (%v)", c, len(got[c]), n, got)
		}
	}
	before := hits.Load()
	categorize(gs[:3], f)
	if hits.Load() != before {
		t.Errorf("cached details fetched again: %d requests", hits.Load()-before)
	}
}
