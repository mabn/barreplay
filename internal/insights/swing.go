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
	// Army and Eco split the shift between what moved it: the share of the
	// model's move toward Side that came from the armies (army value, and
	// from Version 9 the metal each side destroyed), and from metal income
	// (recent and accumulated together). They sum to 1; a
	// feature that moved AGAINST Side counts as 0. Version 7 and later.
	Army float64 `json:"army"`
	Eco  float64 `json:"eco"`
}

// WinModel is a logistic model over SwingFeatures: P(side 0 wins) =
// sigmoid(sum Coef[k] * feature[k]). There is no intercept: the features are
// antisymmetric (swapping the sides negates every one), so an even game reads
// 50% by construction.
//
// The coefficients are experiments/winmodel's fit over 1217 published
// full-view games with a known winner (2026-10-11, Versions 6-8, each cut
// where it was decided). Version 9 added the TRADE feature (metal each side
// has destroyed) and stretched the income window from one minute to three:
// out of sample the accuracy (77.0%) and log loss (0.478) are those of the
// Version 7 model, but the line jitters a third less, and of its big moves
// past the opening two thirds now come with a fight one side lost or an
// elimination (44% before) — 0.57 moves a game with nothing to name, against
// 1.71. Income still carries most of the line, which is why the window
// matters: a one-minute window let every economy blip swing it. Fitting per
// category (winfit -categories) made large ranked team games steeper and
// unranked ones flatter but gained little over this one model; the players'
// OpenSkill difference added nothing (BAR balances its teams).
var WinModel = struct {
	Coef   [swingFeatures]float64
	Fitted bool
	Games  int // games the fit saw
}{
	Coef:   [swingFeatures]float64{1.597, 5.294, 4.149, 1.788},
	Fitted: true,
	Games:  1217,
}

const (
	swingFeatures = 4
	// The smoothing constants are VIRTUAL METAL added to both sides before
	// a ratio is taken (metal for army and cumulative income, metal/s for
	// income), so 190 against 559 metal of army in the opening reads as
	// nearly even rather than a 3x lead. Tested at 0.3k/1k/5k/10k/25k over
	// 1191 games (2026-10-11): 25k keeps accuracy (76.9%), predicts the
	// opening best and halves its jitter (4.96 -> 2.79 points a step), at a
	// small cost mid-game (log loss 0.522 vs 0.498 at half time). Marcin's
	// pick. Changing them needs a refit (cmd/winfit).
	swingArmyK   = 25000
	swingIncomeK = 250
	swingCumK    = 25000
	swingTradeK  = 25000
	// swingIncomeSteps is the trailing window income is averaged over:
	// three minutes. One minute (Versions 2-8) predicted no better and made
	// most of the line's big moves ones no event explains (an extractor
	// field coming online, converters toggling, a refunded build).
	swingIncomeSteps = 12

	// A moment is a shift over momentSteps of at least momentMin, at least
	// momentGap steps from a bigger one; at most maxMoments are kept.
	momentSteps = 4
	momentMin   = 0.12
	momentGap   = 8
	maxMoments  = 6
	// momentFlat is how little the line may move and still count as not yet
	// (or no longer) shifting, when a moment's window is trimmed.
	momentFlat = 0.02
	// earlyEcoSec is the opening in which a shift carried mainly by income
	// is no moment: every side is still building its first extractors, and
	// one of them being a few seconds ahead says nothing about the game. A
	// raid that destroys economy buildings there still counts.
	earlyEcoSec = 4 * 60
	// earlyShare is the opening share of the game in which no shift of the
	// line is a moment at all: army and income both still grow from nothing,
	// so the line swings on who built a few seconds sooner. What happened
	// there worth telling is a fight one side clearly won, which the page
	// lists from the battles instead (moments.ts gapBattles).
	earlyShare = 0.3
)

// SwingFeatures returns the model's inputs at every step of a two-sided
// series, side 0 against side 1: the log ratio of army value, of metal income
// over the last swingIncomeSteps, of metal income accumulated so far, and of
// the metal each side has destroyed so far (killed, from Killed).
func SwingFeatures(s Series, killed [2][]float64) [][swingFeatures]float64 {
	if len(s.Army) != 2 || len(s.MetalIncome) != 2 {
		return nil
	}
	n := len(s.T)
	out := make([][swingFeatures]float64, n)
	var cum, kill [2]float64
	for i := 0; i < n; i++ {
		var army, inc [2]float64
		for side := 0; side < 2; side++ {
			army[side] = at(s.Army[side], i)
			cum[side] += at(s.MetalIncome[side], i) * StepSec
			kill[side] += at(killed[side], i)
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
			math.Log((kill[0] + swingTradeK) / (kill[1] + swingTradeK)),
		}
	}
	return out
}

// Killed is the metal each of two sides destroyed in each step: the other
// side's losses that were fought for (not those going down with an
// eliminated team), by the step the death fell in. Every loss in Deaths
// counts, whoever the engine credited, so it needs no causes.
func Killed(o *Insights) [2][]float64 {
	var out [2][]float64
	n := len(o.Series.T)
	for s := range out {
		out[s] = make([]float64, n)
	}
	side := map[int32]int{}
	for _, t := range o.Teams {
		side[t.Team] = t.Side
	}
	wiped := wipedDeaths(o.Deaths, o.Eliminated)
	d := o.Deaths
	for i, f := range d.F {
		s, ok := side[d.Team[i]]
		if !ok || s < 0 || s > 1 || wiped[i] || i >= len(d.Cost) {
			continue
		}
		if st := int(f) / (StepSec * simFPS); st < n {
			out[1-s][st] += d.Cost[i]
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
//
// ecoDef says which defs are economy buildings (isEcoBuilding), for the
// opening's rule; nil treats none as one.
func swing(o *Insights, ecoDef func(int32) bool) *Swing {
	if len(o.Sides) != 2 || o.POV != POVFull {
		return nil
	}
	feats := SwingFeatures(o.Series, Killed(o))
	if len(feats) == 0 {
		return nil
	}
	sw := &Swing{P: make([]float64, len(feats)), Fitted: WinModel.Fitted, Games: WinModel.Games}
	for i, f := range feats {
		sw.P[i] = math.Round(WinProb(WinModel.Coef, f)*1000) / 1000
	}
	// Nothing in the first earlyShare of the game is a moment. After it, a
	// shift still inside the first earlyEcoSec (a short game) carried by
	// income alone is two economies growing at slightly different speeds —
	// unless the side it moved against lost economy buildings in it.
	opening := int32(earlyShare * o.DurationSec * simFPS)
	skip := func(m Moment) bool {
		if m.F0 < opening {
			return true
		}
		if m.F0 >= earlyEcoSec*simFPS || m.Eco < 0.5 {
			return false
		}
		return !ecoLost(o, ecoDef, 1-m.Side, m.F0-StepSec*simFPS, m.F1+StepSec*simFPS)
	}
	sw.Moments = moments(sw.P, feats, o.Battles, int32(o.DurationSec*simFPS), skip)
	return sw
}

// ecoLost is whether side lost an economy building in [f0, f1] — one that
// was fought for, not one that went down with its eliminated team.
func ecoLost(o *Insights, ecoDef func(int32) bool, side int, f0, f1 int32) bool {
	if ecoDef == nil {
		return false
	}
	teamSide := map[int32]int{}
	for _, t := range o.Teams {
		teamSide[t.Team] = t.Side
	}
	wiped := map[int32]int32{}
	for _, e := range o.Eliminated {
		wiped[e.Team] = e.F
	}
	d := o.Deaths
	for i, f := range d.F {
		if f < f0 || f > f1 {
			continue
		}
		if s, ok := teamSide[d.Team[i]]; !ok || s != side {
			continue
		}
		if w, ok := wiped[d.Team[i]]; ok && f >= w {
			continue
		}
		if ecoDef(d.Def[i]) {
			return true
		}
	}
	return false
}

// drivers splits the model's move toward side between step lo and hi into
// the share carried by the armies (their value, and the metal each side
// destroyed: what fighting moves) and by income.
func drivers(feats [][swingFeatures]float64, lo, hi, side int) (army, eco float64) {
	if lo < 0 || hi >= len(feats) {
		return 0, 0
	}
	sign := 1.0
	if side == 1 {
		sign = -1
	}
	dz := func(k int) float64 { return sign * WinModel.Coef[k] * (feats[hi][k] - feats[lo][k]) }
	a := math.Max(0, dz(0)+dz(3))
	e := math.Max(0, dz(1)+dz(2))
	if a+e == 0 {
		return 0, 0
	}
	return math.Round(a/(a+e)*100) / 100, math.Round(e/(a+e)*100) / 100
}

func moments(p []float64, feats [][swingFeatures]float64, battles []Battle, lastFrame int32, skip func(Moment) bool) []Moment {
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
	frame := func(step int) int32 {
		f := int32((step + 1) * StepSec * simFPS) // a step's value is its window's end
		if f > lastFrame {
			f = lastFrame
		}
		return f
	}
	moment := func(c cand) Moment {
		// Trim the window to where the line actually moved: a shift that
		// happened in one step should not read as a minute-long one.
		lo, hi := c.i-momentSteps, c.i
		for lo+1 < hi && math.Abs(p[lo+1]-p[c.i-momentSteps]) < momentFlat {
			lo++
		}
		for hi-1 > lo && math.Abs(p[hi-1]-p[c.i]) < momentFlat {
			hi--
		}
		m := Moment{F0: frame(lo), F1: frame(hi), Delta: math.Round(math.Abs(c.dp)*1000) / 1000, Battle: -1}
		if c.dp < 0 {
			m.Side = 1
		}
		m.Army, m.Eco = drivers(feats, lo, hi, m.Side)
		best := int32(0)
		for b, bt := range battles {
			lo, hi := max(bt.F0, m.F0), min(bt.F1, m.F1)
			if hi >= lo && hi-lo >= best {
				best, m.Battle = hi-lo, b
			}
		}
		return m
	}
	var picked []cand
	var out []Moment
	for _, c := range cs {
		near := false
		for _, q := range picked {
			if d := c.i - q.i; d < momentGap && d > -momentGap {
				near = true
				break
			}
		}
		if near {
			continue
		}
		m := moment(c)
		if skip != nil && skip(m) {
			continue
		}
		picked = append(picked, c)
		out = append(out, m)
		if len(out) == maxMoments {
			break
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].F0 < out[b].F0 })
	for n := range out {
		out[n].N = n + 1
	}
	if out == nil {
		out = []Moment{}
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
