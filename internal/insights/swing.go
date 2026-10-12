package insights

import (
	"math"
	"sort"

	"github.com/mabn/barreplay/internal/gamecat"
)

// Swing is the win-probability line of a two-sided, full-view game: P[i] is
// the chance that side 0 wins, as the model reads step i, and Moments are the
// biggest shifts in it, numbered in time order.
//
// The model sees only what every replay has (army value, standing
// buildings and metal income per step, and the metal each side destroyed),
// so it reads the game as a spectator watching the numbers would, not as the
// players did. It is never told who won; the winner is shown next to it so a
// reader can see where the numbers and the result disagree.
type Swing struct {
	P       []float64 `json:"p"`
	Moments []Moment  `json:"moments"`
	// Fitted and Games copy the model's (WinModels), so the page can say
	// whether the line comes from a model fitted to real games or from
	// hand-set priors.
	Fitted bool `json:"fitted"`
	Games  int  `json:"games,omitempty"`
	// Model names which of WinModels drew the line: ModelLava for one of
	// lavabalance's lava games, ModelRanked for every other. Version 10.
	Model string `json:"model,omitempty"`
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
	// Army, Eco and Build split the shift between what moved it: the share
	// of the model's move toward Side that came from the armies (army value
	// — with standing defences from Version 10 — and from Version 9 the
	// metal each side destroyed), from metal income (recent and accumulated
	// together), and from Version 10 from the other standing buildings
	// (economy, extractors, factories and the rest). They sum to 1; a
	// feature that moved AGAINST Side counts as 0. Version 7 and later.
	Army  float64 `json:"army"`
	Eco   float64 `json:"eco"`
	Build float64 `json:"build,omitempty"`
	// Built is what each side finished building in the builtSec up to F1
	// (from BuiltFrom), by def, the most metal first, at most
	// momentBuiltDefs: what a build-up story shows. Version 10.
	Built     [][]UnitLoss `json:"built,omitempty"`
	BuiltFrom int32        `json:"builtFrom,omitempty"`
}

// WinModelFit is a logistic model over SwingFeatures: P(side 0 wins) =
// sigmoid(sum Coef[k] * feature[k]). There is no intercept: the features are
// antisymmetric (swapping the sides negates every one), so an even game reads
// 50% by construction.
type WinModelFit struct {
	Coef   [swingFeatures]float64
	Fitted bool
	Games  int // games the fit saw
}

// The models, as Swing.Model names them.
const (
	ModelRanked = "ranked8v8"
	ModelLava   = "lava"
)

// WinModels are the fitted models, one per kind of game (Version 10).
//
// The coefficients are experiments/winmodel's fit of the variant "v9
// army+def +eco+bld bld3" (2026-10-12), each over its own group of published
// full-view games with a known winner, cut where they were decided: the lava
// games lavabalance stores (internal/gamecat), and ranked 8v8 games that are
// not lava games. Fitting the groups apart beat one model for all games out
// of sample in every group (log loss: lava 0.511 -> 0.479, ranked Supreme
// Isthmus 0.441 -> 0.431, ranked other maps 0.449 -> 0.401); the standing
// buildings then gained again in each (lava 0.479 -> 0.463, ranked 0.421 ->
// 0.408 on Isthmus and 0.401 -> 0.380 elsewhere). Every game that is not a
// lava game is read with the ranked 8v8 model (Marcin's call): it is what most
// published games are, and no other group has the games to fit its own.
//
// The two read the game differently, which is the point of having two: a lava
// game's economies are about nine times a ranked game's and its armies matter
// far less (army 1.6 against 6.5), and what each side has built carries most
// of its line. Coefficients in feature order: army and defences, income over
// the last three minutes, income so far, metal destroyed, other buildings.
var WinModels = map[string]WinModelFit{
	ModelRanked: {Coef: [swingFeatures]float64{6.477, 6.285, 3.133, 1.129, 3.739}, Fitted: true, Games: 813},
	ModelLava:   {Coef: [swingFeatures]float64{1.621, 2.861, 0.124, 0.260, 3.210}, Fitted: true, Games: 212},
}

// modelFor picks a game's win model: ModelLava for one of lavabalance's lava
// games — the LAVA lobby's tweaks (gamecat.LavaTweaks) on two sides of
// eight players, no AI — and ModelRanked for everything else, including a
// game whose lobby settings are unknown. The rest of lavabalance's rule
// (one winner, a normal end, six minutes) describes how a game ENDED, which
// says nothing about how to read it while it was played.
func modelFor(in Input, ro roster) string {
	if len(ro.sides) != 2 || !gamecat.LavaTweaks(in.ModOptions) {
		return ModelRanked
	}
	humans := make([]int, 2)
	for _, pl := range in.Meta.Players {
		if pl.Spectator {
			continue
		}
		if s := ro.side(pl.Team); s >= 0 {
			humans[s]++
		}
	}
	for _, t := range ro.teams {
		if t.Side >= 0 && ro.ai[t.Team] {
			return ModelRanked
		}
	}
	if humans[0] != 8 || humans[1] != 8 {
		return ModelRanked
	}
	return ModelLava
}

const (
	swingFeatures = 5
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
	// swingBuildK is the virtual metal of the standing-buildings input,
	// smaller than the army's because the buildings that are not defences
	// start from nothing in every game and grow slowly at first (the study
	// tested 3k, 10k and 25k).
	swingBuildK = 10000
	// killBuildingWorth is what a building the enemy destroyed counts for
	// per metal in metal destroyed, when the capture names killers: losing
	// one costs the base, not only the metal (the study's pick of 1-5x; 3x
	// did best). Without killers a reclaimed or upgraded building reads as
	// destroyed, so it counts its plain metal, as it always did.
	killBuildingWorth = 3
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
// series, side 0 against side 1: the log ratio of army value with standing
// defences, of metal income over the last swingIncomeSteps, of metal income
// accumulated so far, of the metal each side has destroyed so far (killed,
// from Killed), and of the other standing buildings. A series with no
// Buildings (before Version 10) reads none, which only a refit on such files
// would be right for.
func SwingFeatures(s Series, killed [2][]float64) [][swingFeatures]float64 {
	if len(s.Army) != 2 || len(s.MetalIncome) != 2 {
		return nil
	}
	n := len(s.T)
	out := make([][swingFeatures]float64, n)
	var cum, kill [2]float64
	for i := 0; i < n; i++ {
		var army, inc, bld [2]float64
		for side := 0; side < 2; side++ {
			army[side] = at(s.Army[side], i)
			if side < len(s.Buildings) {
				for c, xs := range s.Buildings[side] {
					if c == bcDefence {
						army[side] += at(xs, i)
					} else {
						bld[side] += at(xs, i)
					}
				}
			}
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
			math.Log((bld[0] + swingBuildK) / (bld[1] + swingBuildK)),
		}
	}
	return out
}

// Killed is the metal each of two sides destroyed in each step: the other
// side's losses that were fought for (not those going down with an
// eliminated team), by the step the death fell in. Every loss in Deaths
// counts, whoever the engine credited, so it needs no causes; in a capture
// that names them (Insights.Causes) a building (Def.Stand) counts
// killBuildingWorth times its metal.
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
		w := 1.0
		if o.Causes && o.Defs[d.Def[i]].Stand != "" {
			w = killBuildingWorth
		}
		if st := int(f) / (StepSec * simFPS); st < n {
			out[1-s][st] += w * d.Cost[i]
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

// swing computes the line and its moments with the named model (WinModels),
// or nil when the game is not a two-sided full-view one (the model compares
// both sides' numbers, which a one-sided capture only half has).
//
// ecoDef says which defs are economy buildings (isEcoBuilding), for the
// opening's rule; nil treats none as one.
func swing(o *Insights, ecoDef func(int32) bool, model string) *Swing {
	if len(o.Sides) != 2 || o.POV != POVFull {
		return nil
	}
	feats := SwingFeatures(o.Series, Killed(o))
	if len(feats) == 0 {
		return nil
	}
	wm, ok := WinModels[model]
	if !ok {
		model, wm = ModelRanked, WinModels[ModelRanked]
	}
	sw := &Swing{P: make([]float64, len(feats)), Fitted: wm.Fitted, Games: wm.Games, Model: model}
	for i, f := range feats {
		sw.P[i] = math.Round(WinProb(wm.Coef, f)*1000) / 1000
	}
	// Nothing in the first earlyShare of the game is a moment. After it, a
	// shift still inside the first earlyEcoSec (a short game) carried by
	// income and building alone is two economies growing at slightly
	// different speeds — unless the side it moved against lost economy
	// buildings in it.
	opening := int32(earlyShare * o.DurationSec * simFPS)
	skip := func(m Moment) bool {
		if m.F0 < opening {
			return true
		}
		if m.F0 >= earlyEcoSec*simFPS || m.Eco+m.Build < 0.5 {
			return false
		}
		return !ecoLost(o, ecoDef, 1-m.Side, m.F0-StepSec*simFPS, m.F1+StepSec*simFPS)
	}
	sw.Moments = moments(sw.P, feats, wm.Coef, o.Battles, int32(o.DurationSec*simFPS), skip)
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
// the share carried by the armies (their value with the defences, and the
// metal each side destroyed: what fighting moves), by income, and by the
// other standing buildings.
func drivers(coef [swingFeatures]float64, feats [][swingFeatures]float64, lo, hi, side int) (army, eco, build float64) {
	if lo < 0 || hi >= len(feats) {
		return 0, 0, 0
	}
	sign := 1.0
	if side == 1 {
		sign = -1
	}
	dz := func(k int) float64 { return sign * coef[k] * (feats[hi][k] - feats[lo][k]) }
	a := math.Max(0, dz(0)+dz(3))
	e := math.Max(0, dz(1)+dz(2))
	b := math.Max(0, dz(4))
	if a+e+b == 0 {
		return 0, 0, 0
	}
	r := func(x float64) float64 { return math.Round(x/(a+e+b)*100) / 100 }
	return r(a), r(e), r(b)
}

func moments(p []float64, feats [][swingFeatures]float64, coef [swingFeatures]float64, battles []Battle, lastFrame int32, skip func(Moment) bool) []Moment {
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
		m.Army, m.Eco, m.Build = drivers(coef, feats, lo, hi, m.Side)
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
