package main

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"

	"github.com/mabn/barreplay/internal/insights"
)

// Unit kinds, read off BAR's icon assignments (the viewer's icon table):
// the insights files of before Version 8 name no class.
var (
	iconsOnce sync.Once
	iconOf    map[string]string // def name or icon key -> bitmap basename
)

func loadIcons() {
	_, here, _, _ := runtime.Caller(0)
	b, err := os.ReadFile(filepath.Join(filepath.Dir(here), "../../internal/viz/bardata/icons/icontypes.json"))
	if err != nil {
		panic(err)
	}
	var raw map[string]struct {
		P string `json:"p"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		panic(err)
	}
	iconOf = map[string]string{}
	for k, v := range raw {
		iconOf[k] = strings.TrimSuffix(filepath.Base(v.P), ".png")
	}
}

var (
	defenceIcon = regexp.MustCompile(`^(def_|defence|aa|laserdefense|cordoom|armanni|legbunk|legion_rampart|antinuke|armbrtha|corint|leglrpc|armvulc|corbuzz|tacnuke|nuke$)`)
	ecoIcon     = regexp.MustCompile(`^(energy|fusion|wind|mex_|metalmaker|metalstorage|t3_solinvictus)`)
	navalIcon   = regexp.MustCompile(`(^|_)(ship|sub|battlesub)`)
)

func kindOf(d insights.Def) string {
	iconsOnce.Do(loadIcons)
	ic := iconOf[d.Icon]
	if ic == "" {
		ic = iconOf[strings.TrimSuffix(d.Name, "_scav")]
	}
	switch {
	case ic == "":
		return ""
	case strings.HasPrefix(ic, "factory"):
		return "factory"
	case defenceIcon.MatchString(ic):
		return "defence"
	case ecoIcon.MatchString(ic):
		return "eco"
	case navalIcon.MatchString(ic):
		return "naval"
	}
	return ""
}

// Supreme Isthmus's seas, as fractions of its 12288-elmo square (places.ts):
// a point is at sea when the nearest labelled place is a sea.
var isthmusRE = regexp.MustCompile(`(?i)^supreme isthmus`)

type place struct {
	u, v float64
	sea  bool
}

var isthmusPlaces = func() []place {
	base := []place{{0.19, 0.945, false}, {0.083, 0.84, false}, {0.476, 0.895, false}, {0.387, 0.787, false},
		{0.389, 0.584, false}, {0.426, 0.692, false}, {0.08, 0.523, true}}
	var out []place
	for _, p := range base {
		out = append(out, p, place{1 - p.u, 1 - p.v, p.sea})
	}
	return append(out, place{0.518, 0.505, false}, place{0.4, 0.127, true}, place{0.272, 0.25, true},
		place{0.076, 0.147, false}, place{0.712, 0.7, true}, place{0.797, 0.846, true}, place{0.944, 0.812, false})
}()

func atSea(x, z float64) bool {
	u, v := x/12288, z/12288
	best, sea := math.Inf(1), false
	for _, p := range isthmusPlaces {
		d := (p.u-u)*(p.u-u) + (p.v-v)*(p.v-v)
		if d < best {
			best, sea = d, p.sea
		}
	}
	return sea
}

// geo fills the location and kind series: each side's army centre's way
// toward the enemy start, and its fought-for losses split by where (own
// half, own quarter, Isthmus seas) and by kind (defences, economy,
// factories, ships).
func geo(g *game, f *file, side map[int32]int, died map[int32]int32) {
	n := g.n
	g.mapName = f.MapName
	g.lostBy = map[string]*[2][]float64{}
	add := func(key string, s, st int, c float64) {
		a := g.lostBy[key]
		if a == nil {
			a = &[2][]float64{make([]float64, n), make([]float64, n)}
			g.lostBy[key] = a
		}
		a[s][st] += c
	}
	// A side starts where its army first stood: the mean of its first four
	// army centres.
	var start [2][2]float64
	if len(f.Series.Front) == 2 {
		g.pos = true
		for s := 0; s < 2; s++ {
			k := 0
			for _, p := range f.Series.Front[s] {
				if len(p) == 2 {
					start[s][0] += float64(p[0])
					start[s][1] += float64(p[1])
					if k++; k == 4 {
						break
					}
				}
			}
			if k == 0 {
				g.pos = false
				break
			}
			start[s][0] /= float64(k)
			start[s][1] /= float64(k)
		}
	}
	dx, dz := start[1][0]-start[0][0], start[1][1]-start[0][1]
	d2 := dx*dx + dz*dz
	if d2 < 2000*2000 {
		g.pos = false
	}
	// way is how far x,z is from side s's start toward the other's, 0..1.
	way := func(s int, x, z float64) float64 {
		w := ((x-start[0][0])*dx + (z-start[0][1])*dz) / d2
		if s == 1 {
			w = 1 - w
		}
		return w
	}
	if g.pos {
		for s := 0; s < 2; s++ {
			g.adv[s] = make([]float64, n)
			for i := 0; i < n; i++ {
				g.adv[s][i] = math.NaN()
				if i < len(f.Series.Front[s]) && len(f.Series.Front[s][i]) == 2 {
					p := f.Series.Front[s][i]
					g.adv[s][i] = way(s, float64(p[0]), float64(p[1]))
				}
			}
		}
	}
	sea := isthmusRE.MatchString(f.MapName)
	if sea {
		roles(g, f)
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
		if st >= n {
			continue
		}
		c := f.Deaths.Cost[i]
		if k := kindOf(f.Defs[f.Deaths.Def[i]]); k != "" {
			add(k, sd, st, c)
		}
		x, z := float64(f.Deaths.X[i]), float64(f.Deaths.Z[i])
		if g.pos {
			w := way(sd, x, z)
			if w < 0.5 {
				add("ownHalf", sd, st, c)
			}
			if w < 0.25 {
				add("ownBase", sd, st, c)
			}
			if w > 0.5 {
				add("enemyHalf", sd, st, c)
			}
		}
		if sea && atSea(x, z) {
			add("sea", sd, st, c)
		}
	}
}

// lostSeries returns side s's cumulative losses of the key, nil-safe.
func (g *game) lostOf(key string, s, i int) float64 {
	if a := g.lostBy[key]; a != nil {
		return a[s][i]
	}
	return 0
}

// isthmusRoles are the start spots whose players Marcin asked about, in the
// south-west base (the north-east one is the same rotated half a turn).
var isthmusRoles = map[string][2]float64{"geo": {0.387, 0.787}, "eco": {0.083, 0.84}}

// roles ranks each side's geo and eco players by the metal they built.
func roles(g *game, f *file) {
	n := g.n
	type pl struct {
		side  int
		u, v  float64
		built []float64
	}
	var ps []pl
	for _, p := range f.Players {
		if p.Side < 0 || p.Side > 1 {
			continue
		}
		for _, q := range p.Commander.Path {
			if len(q) >= 2 {
				ps = append(ps, pl{p.Side, float64(q[0]) / 12288, float64(q[1]) / 12288, pad(p.Strip.BuiltMetal, n)})
				break
			}
		}
	}
	if len(ps) < 4 {
		return
	}
	// Each player's cumulative and windowed built metal, ranked per step.
	m := len(ps)
	val := [2][][]float64{make([][]float64, m), make([][]float64, m)}
	for k, p := range ps {
		val[0][k] = make([]float64, n)
		val[1][k] = make([]float64, n)
		c := 0.0
		for i := 0; i < n; i++ {
			c += p.built[i]
			val[0][k][i] = c
			lo := max(0, i-11)
			for j := lo; j <= i; j++ {
				val[1][k][i] += p.built[j]
			}
		}
	}
	rank := func(w, k, i int) float64 {
		better, same := 0, 0
		for o := range ps {
			switch {
			case val[w][o][i] > val[w][k][i]:
				better++
			case o != k && val[w][o][i] == val[w][k][i]:
				same++
			}
		}
		return (float64(better) + float64(same)/2) / float64(m-1)
	}
	g.roleRank = map[string]*[2][2][]float64{}
	for role, at := range isthmusRoles {
		var who [2]int
		for s := 0; s < 2; s++ {
			// The spot in this side's half: the mirror nearer its players.
			var cu, cv float64
			k := 0
			for _, p := range ps {
				if p.side == s {
					cu += p.u
					cv += p.v
					k++
				}
			}
			cu, cv = cu/float64(k), cv/float64(k)
			u, v := at[0], at[1]
			if (u-cu)*(u-cu)+(v-cv)*(v-cv) > (1-u-cu)*(1-u-cu)+(1-v-cv)*(1-v-cv) {
				u, v = 1-u, 1-v
			}
			who[s] = -1
			best := math.Inf(1)
			for j, p := range ps {
				if d := (p.u-u)*(p.u-u) + (p.v-v)*(p.v-v); p.side == s && d < best {
					best, who[s] = d, j
				}
			}
			if best > 0.1*0.1 {
				who[s] = -1
			}
		}
		if who[0] < 0 || who[1] < 0 {
			continue
		}
		r := &[2][2][]float64{}
		for w := 0; w < 2; w++ {
			for s := 0; s < 2; s++ {
				r[w][s] = make([]float64, n)
				for i := 0; i < n; i++ {
					r[w][s][i] = rank(w, who[s], i)
				}
			}
		}
		g.roleRank[role] = r
	}
}
