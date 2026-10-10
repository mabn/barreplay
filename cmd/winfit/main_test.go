package main

import (
	"encoding/json"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"

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
		got, ok, err := load(p)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			ss = append(ss, got...)
		}
	}
	c := newton(ss, 1e-3)
	if c[0] <= 0 {
		t.Fatalf("army coefficient %v, want positive", c)
	}
	loss := func(c [nf]float64) float64 {
		l := 0.0
		for _, s := range ss {
			p := prob(c, s.f)
			if s.y == 1 {
				l -= s.w * logf(p)
			} else {
				l -= s.w * logf(1-p)
			}
		}
		return l
	}
	if loss(c) >= loss([nf]float64{}) {
		t.Errorf("fit loss %v is no better than chance %v", loss(c), loss([nf]float64{}))
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func logf(p float64) float64 { return math.Log(p) }
