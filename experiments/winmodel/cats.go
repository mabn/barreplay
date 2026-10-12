package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"sort"
	"strings"
)

// Losses by unit CATEGORY (experiments/buildingworth's table: army, con,
// com, def, eco, mex, bld), for Marcin's question whether a building's
// metal should count for more than a unit's when judging who is winning.

var (
	defCat   map[string]string
	eventsOn bool
)

func loadDefCat(path string) {
	b, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	if err := json.Unmarshal(b, &defCat); err != nil {
		panic(err)
	}
}

func catOf(name string) string {
	if c, ok := defCat[name]; ok {
		return c
	}
	return defCat[strings.TrimSuffix(name, "_scav")]
}

// catLosses adds "c:<category>" to g.lostBy: each side's fought-for losses
// per step by category.
func catLosses(g *game, f *file, side map[int32]int, died map[int32]int32) {
	if defCat == nil {
		return
	}
	for i, fr := range f.Deaths.F {
		tm := f.Deaths.Team[i]
		sd, ok := side[tm]
		if !ok || sd < 0 || sd > 1 {
			continue
		}
		if w, ok := died[tm]; ok && fr >= w {
			continue
		}
		st := int(fr) / (step * 30)
		if st >= g.n {
			continue
		}
		c := catOf(f.Defs[f.Deaths.Def[i]].Name)
		if c == "" {
			c = "unknown"
		}
		key := "c:" + c
		a := g.lostBy[key]
		if a == nil {
			a = &[2][]float64{make([]float64, g.n), make([]float64, g.n)}
			g.lostBy[key] = a
		}
		a[sd][st] += f.Deaths.Cost[i]
	}
}

// weightedLost is side s's losses in step i with each category's metal
// multiplied by its weight (absent = 1).
func (g *game) weightedLost(w map[string]float64, s, i int) float64 {
	x := g.lost[s][i]
	for c, k := range w {
		x += (k - 1) * g.lostOf("c:"+c, s, i)
	}
	return x
}

// ---- event study ----

// An EVENT is a side losing at least evMin metal of one category within a
// minute (evWin steps), no earlier than 10% into the game and with a later
// step left to look at; a side's next event of the same category waits
// evGap steps. For each event we read the side's win probability a minute
// before, at the event, and 3 and 5 minutes on, and whether it won.
//
// A model that knows everything a spectator does is CALIBRATED at events: the
// side wins about as often as it was given at the event, and the line does
// not drift further afterwards on average. A lagging model gives the side
// too much at the event, then drifts down: that gap is what the study
// measures.
const (
	evWin = 4
	evGap = 8
)

var (
	evShare = 0.5
)

type evRow struct {
	game                 int
	pBefore, pAt, p3, p5 float64
	won                  float64
	trade                float64 // the other side's losses / this side's, same minute
}

func eventStudy(name string, gs []*game, ps [][]float64) {
	type key struct {
		cat  string
		size string
	}
	rows := map[key][]evRow{}
	for gi, g := range gs {
		p := ps[gi]
		for s := 0; s < 2; s++ {
			for _, c := range []string{"army", "def", "eco", "mex", "bld", "con"} {
				a := g.lostBy["c:"+c]
				if a == nil {
					continue
				}
				lastEv := -100
				for i := evWin; i < g.n-1; i++ {
					if float64(i) < 0.1*float64(g.n) || i-lastEv < evGap {
						continue
					}
					var lc, all, other float64
					for j := i - evWin + 1; j <= i; j++ {
						lc += a[s][j]
						all += g.lost[s][j]
						other += g.lost[1-s][j]
					}
					size := ""
					switch {
					case lc >= 5000:
						size = "5k+"
					case lc >= 1500:
						size = "1.5-5k"
					default:
						continue
					}
					// the category must be most of the side's loss that
					// minute, or the event is about something else
					if lc < evShare*all {
						continue
					}
					lastEv = i
					ps := func(j int) float64 {
						if j >= len(p) {
							j = len(p) - 1
						}
						if j < 0 {
							j = 0
						}
						if s == 0 {
							return p[j]
						}
						return 1 - p[j]
					}
					won := g.y
					if s == 1 {
						won = 1 - g.y
					}
					r := evRow{gi, ps(i - evWin), ps(i), ps(i + 12), ps(i + 20), won, other / math.Max(all, 1)}
					rows[key{c, size}] = append(rows[key{c, size}], r)
					tb := "even"
					switch {
					case r.trade < 0.5:
						tb = "cheap"
					case r.trade > 1.5:
						tb = "costly"
					}
					k2 := key{c, size + " " + tb}
					rows[k2] = append(rows[k2], r)
				}
			}
		}
	}
	var keys []key
	for k := range rows {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(a, b int) bool {
		if keys[a].cat != keys[b].cat {
			return keys[a].cat < keys[b].cat
		}
		return keys[a].size < keys[b].size
	})
	fmt.Printf("events (%s): category size [trade]  n  p-1m  p@ev  p+3m  p+5m  won  gap(p@ev-won) [95%% CI by game]\n", name)
	for _, k := range keys {
		rs := rows[k]
		if len(rs) < 15 {
			continue
		}
		m := func(f func(evRow) float64) float64 {
			t := 0.0
			for _, r := range rs {
				t += f(r)
			}
			return t / float64(len(rs))
		}
		gap := func(rs []evRow) float64 {
			t := 0.0
			for _, r := range rs {
				t += r.pAt - r.won
			}
			return t / float64(len(rs))
		}
		lo, hi := bootstrap(rs, gap)
		fmt.Printf("  %-5s %-14s %4d  %.3f %.3f %.3f %.3f %.3f  %+.3f [%+.3f %+.3f]\n", k.cat, k.size, len(rs),
			m(func(r evRow) float64 { return r.pBefore }), m(func(r evRow) float64 { return r.pAt }),
			m(func(r evRow) float64 { return r.p3 }), m(func(r evRow) float64 { return r.p5 }),
			m(func(r evRow) float64 { return r.won }), gap(rs), lo, hi)
	}
}

// bootstrap resamples whole games (events of one game are not independent).
func bootstrap(rs []evRow, stat func([]evRow) float64) (float64, float64) {
	by := map[int][]evRow{}
	var ids []int
	for _, r := range rs {
		if by[r.game] == nil {
			ids = append(ids, r.game)
		}
		by[r.game] = append(by[r.game], r)
	}
	rng := rand.New(rand.NewSource(1))
	var xs []float64
	for b := 0; b < 400; b++ {
		var s []evRow
		for range ids {
			s = append(s, by[ids[rng.Intn(len(ids))]]...)
		}
		xs = append(xs, stat(s))
	}
	sort.Float64s(xs)
	return xs[10], xs[389]
}

// ---- standing metal (experiments/buildingworth) ----

type standMap map[string]*[2][]float64

func (m standMap) at(c string, s, i int) float64 {
	if m == nil || m[c] == nil || i >= len(m[c][s]) {
		return 0
	}
	return m[c][s][i]
}

func loadStanding(dir string, gs []*game) {
	n := 0
	for _, g := range gs {
		b, err := os.ReadFile(dir + "/" + g.id + ".json")
		if err != nil {
			continue
		}
		var bw struct {
			Cost map[string]map[string][]float64 `json:"cost"`
			HP   map[string]map[string][]float64 `json:"hp"`
		}
		if json.Unmarshal(b, &bw) != nil {
			continue
		}
		conv := func(src map[string]map[string][]float64) standMap {
			out := standMap{}
			for s := 0; s < 2; s++ {
				for c, xs := range src[fmt.Sprint(g.ally[s])] {
					if out[c] == nil {
						out[c] = &[2][]float64{make([]float64, g.n), make([]float64, g.n)}
					}
					copy(out[c][s], xs)
				}
			}
			return out
		}
		g.stand, g.standHP = conv(bw.Cost), conv(bw.HP)
		n++
	}
	fmt.Printf("standing metal for %d of %d games\n", n, len(gs))
}

// ---- paired comparison ----

var firstLoss []float64

// pairedLoss prints how a variant's per-game log loss differs from the first
// variant run, with a 95% interval from resampling games.
func pairedLoss(name string, per []float64) {
	if firstLoss == nil {
		firstLoss = per
		return
	}
	d := make([]float64, len(per))
	m := 0.0
	for i := range per {
		d[i] = per[i] - firstLoss[i]
		m += d[i]
	}
	m /= float64(len(d))
	rng := rand.New(rand.NewSource(2))
	var xs []float64
	for b := 0; b < 1000; b++ {
		t := 0.0
		for range d {
			t += d[rng.Intn(len(d))]
		}
		xs = append(xs, t/float64(len(d)))
	}
	sort.Float64s(xs)
	fmt.Printf("  %-22s loss vs first: %+.4f [%+.4f %+.4f]\n", name, m, xs[25], xs[974])
}

var (
	bootCoef  int
	scoreOnly map[string]bool // nil = score every game
)

// keepListed keeps the games named in a file of game ids (first
// tab-separated field per line; a group file from buildingworth -groups
// works filtered to one group).
func keepListed(path string, gs []*game) []*game {
	b, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	want := map[string]bool{}
	for _, l := range strings.Split(string(b), "\n") {
		if id, _, _ := strings.Cut(strings.TrimSpace(l), "\t"); id != "" {
			want[id] = true
		}
	}
	var keep []*game
	for _, g := range gs {
		if want[g.id] {
			keep = append(keep, g)
		}
	}
	return keep
}

// coefIntervals refits a variant on n resamples of whole games and prints
// each coefficient's median and 95% interval, so coefficients can be
// compared across groups of games.
func coefIntervals(name string, gs []*game, feats [][][]float64, nf, n int) {
	per := make([][]sample, len(gs))
	for i, g := range gs {
		per[i] = samples(g, feats[i])
	}
	draws := make([][]float64, n)
	sem := make(chan struct{}, 8)
	done := make(chan struct{})
	for b := 0; b < n; b++ {
		go func() {
			sem <- struct{}{}
			defer func() { <-sem; done <- struct{}{} }()
			rng := rand.New(rand.NewSource(int64(100 + b)))
			var ss []sample
			for range gs {
				ss = append(ss, per[rng.Intn(len(gs))]...)
			}
			draws[b] = fit(ss, nf)
		}()
	}
	for b := 0; b < n; b++ {
		<-done
	}
	var parts []string
	for k := 0; k < nf; k++ {
		xs := make([]float64, n)
		for b := range draws {
			xs[b] = draws[b][k]
		}
		sort.Float64s(xs)
		q := func(f float64) float64 { return xs[int(math.Round(f*float64(n-1)))] }
		parts = append(parts, fmt.Sprintf("%.2f [%.2f, %.2f]", q(0.5), q(0.025), q(0.975)))
	}
	fmt.Printf("%-22s coef 95%%: %s\n", name, strings.Join(parts, "  "))
}
