package insights

import (
	"math"
	"testing"
)

func flat(n int, v float64) []float64 {
	xs := make([]float64, n)
	for i := range xs {
		xs[i] = v
	}
	return xs
}

func series(army0, army1, inc0, inc1 []float64) Series {
	s := Series{Army: [][]float64{army0, army1}, MetalIncome: [][]float64{inc0, inc1}}
	for i := range army0 {
		s.T = append(s.T, float64(i*StepSec))
	}
	return s
}

// An even game reads 50% throughout, and swapping the sides mirrors the line.
func TestSwingIsSymmetric(t *testing.T) {
	n := 40
	a0, a1 := flat(n, 0), flat(n, 0)
	for i := range a0 {
		a0[i] = float64(i * 100)
		a1[i] = float64(i * 60)
	}
	even := SwingFeatures(series(a0, a0, flat(n, 10), flat(n, 10)))
	for i, f := range even {
		if p := WinProb(WinModel.Coef, f); p != 0.5 {
			t.Fatalf("even game step %d = %v, want 0.5", i, p)
		}
	}
	ab := SwingFeatures(series(a0, a1, flat(n, 12), flat(n, 8)))
	ba := SwingFeatures(series(a1, a0, flat(n, 8), flat(n, 12)))
	for i := range ab {
		p, q := WinProb(WinModel.Coef, ab[i]), WinProb(WinModel.Coef, ba[i])
		if math.Abs(p+q-1) > 1e-9 {
			t.Fatalf("step %d: %v + %v != 1", i, p, q)
		}
	}
	if p := WinProb(WinModel.Coef, ab[n-1]); p < 0.7 {
		t.Errorf("a side ahead on army and income all game reads %v at the end", p)
	}
}

// A sudden wipe of side 0's army is a numbered moment, credited to side 1
// and to the battle fought over it.
func TestMoments(t *testing.T) {
	n := 60
	a0, a1 := flat(n, 4000), flat(n, 4000)
	for i := 30; i < n; i++ {
		a0[i] = 200
	}
	o := &Insights{
		POV: POVFull, Sides: []Side{{Ally: 0}, {Ally: 1}}, DurationSec: float64(n * StepSec),
		Series:  series(a0, a1, flat(n, 10), flat(n, 10)),
		Battles: []Battle{{F0: 20 * StepSec * simFPS, F1: 25 * StepSec * simFPS}, {F0: 29 * StepSec * simFPS, F1: 31 * StepSec * simFPS}},
	}
	sw := swing(o)
	if sw == nil || len(sw.Moments) != 1 {
		t.Fatalf("moments = %+v", sw)
	}
	m := sw.Moments[0]
	if m.N != 1 || m.Side != 1 || m.Battle != 1 || m.Delta < momentMin {
		t.Errorf("moment = %+v", m)
	}
	// The army fell between steps 29 and 30, whose values hold at the end
	// of their windows: the trimmed window is exactly that one step.
	if m.F0 != 30*StepSec*simFPS || m.F1 != 31*StepSec*simFPS {
		t.Errorf("window %d..%d, want the one step of the wipe %d..%d", m.F0, m.F1, 30*StepSec*simFPS, 31*StepSec*simFPS)
	}
	o.POV = POVAlly
	if swing(o) != nil {
		t.Error("a one-sided capture got a swing line")
	}
}

func TestWinner(t *testing.T) {
	sides := []Side{{Ally: 0}, {Ally: 2}}
	cases := []struct {
		allies []int32
		want   int
	}{{nil, -1}, {[]int32{2}, 1}, {[]int32{0}, 0}, {[]int32{0, 2}, -1}, {[]int32{5}, -1}}
	for _, c := range cases {
		if got := winner(sides, c.allies); got != c.want {
			t.Errorf("winner(%v) = %d, want %d", c.allies, got, c.want)
		}
	}
}
