package insights

import (
	"math"
	"sort"
)

// Swing is the win-probability line of a two-sided, full-view game: P[i] is
// the chance that side 0 wins, as the model reads step i, and Moments are the
// biggest shifts in it, numbered in time order.
//
// The model sees only what every replay has (army value and metal income
// per step), so it reads the game as a spectator watching the numbers would,
// not as the players did. It is never told who won; the winner is shown next
// to it so a reader can see where the numbers and the result disagree.
type Swing struct {
	P       []float64 `json:"p"`
	Moments []Moment  `json:"moments"`
	// Fitted and Games copy WinModel's, so the page can say whether the line
	// comes from a model fitted to real games or from hand-set priors.
	Fitted bool `json:"fitted"`
	Games  int  `json:"games,omitempty"`
}

// Moment is one large shift in the win probability.
type Moment struct {
	N int `json:"n"` // 1-based, in time order
	// F0 and F1 bound the window the shift happened over, in sim frames.
	F0 int32 `json:"f0"`
	F1 int32 `json:"f1"`
	// Side gained Delta (a probability, 0..1) over the window.
	Side  int     `json:"side"`
	Delta float64 `json:"delta"`
	// Battle is the index into Insights.Battles of a battle fought inside
	// the window, -1 when none was.
	Battle int `json:"battle"`
}

// WinModel is a logistic model over SwingFeatures: P(side 0 wins) =
// sigmoid(sum Coef[k] * feature[k]). There is no intercept: the features are
// antisymmetric (swapping the sides negates every one), so an even game reads
// 50% by construction.
//
// The coefficients are cmd/winfit's output over published games with a known
// winner. Until that has run over real games they are hand-set priors (an
// army twice the size, alone, reads ~70%); Fitted says which.
var WinModel = struct {
	Coef   [swingFeatures]float64
	Fitted bool
	Games  int // games the fit saw
}{
	Coef:   [swingFeatures]float64{1.2, 0.8, 1.5},
	Fitted: false,
}

const (
	swingFeatures = 3
	// The smoothing constants keep the log ratios sane while both sides
	// are near zero (the first minutes): metal for army and cumulative
	// income, metal/s for income.
	swingArmyK   = 300
	swingIncomeK = 3
	swingCumK    = 300
	// swingIncomeSteps is the trailing window income is averaged over.
	swingIncomeSteps = 4

	// A moment is a shift over momentSteps of at least momentMin, at least
	// momentGap steps from a bigger one; at most maxMoments are kept.
	momentSteps = 4
	momentMin   = 0.12
	momentGap   = 8
	maxMoments  = 6
	// momentFlat is how little the line may move and still count as not yet
	// (or no longer) shifting, when a moment's window is trimmed.
	momentFlat = 0.02
)

// SwingFeatures returns the model's inputs at every step of a two-sided
// series, side 0 against side 1: the log ratio of army value, of metal income
// over the last minute, and of metal income accumulated so far.
func SwingFeatures(s Series) [][swingFeatures]float64 {
	if len(s.Army) != 2 || len(s.MetalIncome) != 2 {
		return nil
	}
	n := len(s.T)
	out := make([][swingFeatures]float64, n)
	var cum [2]float64
	for i := 0; i < n; i++ {
		var army, inc [2]float64
		for side := 0; side < 2; side++ {
			army[side] = at(s.Army[side], i)
			cum[side] += at(s.MetalIncome[side], i) * StepSec
			lo := i - swingIncomeSteps + 1
			if lo < 0 {
				lo = 0
			}
			for j := lo; j <= i; j++ {
				inc[side] += at(s.MetalIncome[side], j)
			}
			inc[side] /= float64(i - lo + 1)
		}
		out[i] = [swingFeatures]float64{
			math.Log((army[0] + swingArmyK) / (army[1] + swingArmyK)),
			math.Log((inc[0] + swingIncomeK) / (inc[1] + swingIncomeK)),
			math.Log((cum[0] + swingCumK) / (cum[1] + swingCumK)),
		}
	}
	return out
}

func at(xs []float64, i int) float64 {
	if i < len(xs) {
		return xs[i]
	}
	return 0
}

// WinProb applies coefficients to one step's features.
func WinProb(coef [swingFeatures]float64, f [swingFeatures]float64) float64 {
	z := 0.0
	for k := range f {
		z += coef[k] * f[k]
	}
	return 1 / (1 + math.Exp(-z))
}

// swing computes the line and its moments, or nil when the game is not a
// two-sided full-view one (the model compares both sides' numbers, which a
// one-sided capture only half has).
func swing(o *Insights) *Swing {
	if len(o.Sides) != 2 || o.POV != POVFull {
		return nil
	}
	feats := SwingFeatures(o.Series)
	if len(feats) == 0 {
		return nil
	}
	sw := &Swing{P: make([]float64, len(feats)), Fitted: WinModel.Fitted, Games: WinModel.Games}
	for i, f := range feats {
		sw.P[i] = math.Round(WinProb(WinModel.Coef, f)*1000) / 1000
	}
	sw.Moments = moments(sw.P, o.Battles, int32(o.DurationSec*simFPS))
	return sw
}

func moments(p []float64, battles []Battle, lastFrame int32) []Moment {
	type cand struct {
		i  int
		dp float64
	}
	var cs []cand
	for i := momentSteps; i < len(p); i++ {
		if dp := p[i] - p[i-momentSteps]; math.Abs(dp) >= momentMin {
			cs = append(cs, cand{i, dp})
		}
	}
	sort.SliceStable(cs, func(a, b int) bool { return math.Abs(cs[a].dp) > math.Abs(cs[b].dp) })
	var picked []cand
	for _, c := range cs {
		near := false
		for _, q := range picked {
			if d := c.i - q.i; d < momentGap && d > -momentGap {
				near = true
				break
			}
		}
		if !near {
			picked = append(picked, c)
			if len(picked) == maxMoments {
				break
			}
		}
	}
	sort.Slice(picked, func(a, b int) bool { return picked[a].i < picked[b].i })
	frame := func(step int) int32 {
		f := int32((step + 1) * StepSec * simFPS) // a step's value is its window's end
		if f > lastFrame {
			f = lastFrame
		}
		return f
	}
	out := make([]Moment, 0, len(picked))
	for n, c := range picked {
		// Trim the window to where the line actually moved: a shift that
		// happened in one step should not read as a minute-long one.
		lo, hi := c.i-momentSteps, c.i
		for lo+1 < hi && math.Abs(p[lo+1]-p[c.i-momentSteps]) < momentFlat {
			lo++
		}
		for hi-1 > lo && math.Abs(p[hi-1]-p[c.i]) < momentFlat {
			hi--
		}
		m := Moment{N: n + 1, F0: frame(lo), F1: frame(hi), Delta: math.Round(math.Abs(c.dp)*1000) / 1000, Battle: -1}
		if c.dp < 0 {
			m.Side = 1
		}
		best := int32(0)
		for b, bt := range battles {
			lo, hi := max(bt.F0, m.F0), min(bt.F1, m.F1)
			if hi >= lo && hi-lo >= best {
				best, m.Battle = hi-lo, b
			}
		}
		out = append(out, m)
	}
	return out
}

// winner maps the winning ally teams to a side index, -1 unless exactly one
// side won.
func winner(sides []Side, allies []int32) int {
	w := -1
	for i, s := range sides {
		for _, a := range allies {
			if s.Ally == a {
				if w >= 0 && w != i {
					return -1
				}
				w = i
			}
		}
	}
	return w
}
