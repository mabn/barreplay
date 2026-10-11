// Command winmodel compares variants of the summary's win-probability model
// (internal/insights swing.go) on published insights files: out-of-fold
// accuracy and log loss (5 folds by game id), how noisy the line is (mean
// move per 15 s step, zigzags of 5+ points a game), and how many of its big
// moves line up with an event the summary can name.
//
// A big move is what the summary would make a moment of: 12+ points within
// a minute, past the opening 30%, 2 minutes from a bigger one. It is NAMED
// when the side it moved against lost a fight in it (lost at least 1000
// metal, and 10% of its army, more than it destroyed) or had a team
// eliminated. The second line of each row says how many moves overlap one
// of the file's battles, and which feature carried the unnamed ones.
//
// Files of any version from 6 are read; a file written before Version 7 is
// cut where the game was decided, as Version 7 does. Fetch them from the
// bucket (the catalog at /api/replays lists every rid; the newest
// replays/<rid>.insights<N>.json of each) and run:
//
//	go run ./experiments/winmodel [-only "current,+trade win12"] [-os rosters.jsonl] <dir>
//
// -map limits the run to one map (e.g. "(?i)^supreme isthmus"). geo.go adds
// location and unit-kind features: the army centres' advance toward the
// enemy start, and losses by place and kind; only the advance helped, and
// only log loss.
//
// On Supreme Isthmus it also ranks each side's geo and eco players by metal
// built among all players; that added nothing.
//
// -os adds the players' OpenSkill difference as a feature (catalog rosters,
// one {"id","allies":[{"ally","os":[...]}]} per line); it added nothing.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"hash/fnv"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/mabn/barreplay/internal/insights"
)

const step = insights.StepSec

type file struct {
	Version     int                    `json:"version"`
	GameID      string                 `json:"gameId"`
	POV         string                 `json:"pov"`
	DurationSec float64                `json:"durationSec"`
	Sides       []insights.Side        `json:"sides"`
	Teams       []insights.Team        `json:"teams"`
	Series      insights.Series        `json:"series"`
	Deaths      insights.Deaths        `json:"deaths"`
	Battles     []insights.Battle      `json:"battles"`
	Eliminated  []insights.Elimination `json:"eliminated"`
	Winner      int                    `json:"winner"`
	MapName     string                 `json:"mapName"`
	Defs        map[int32]insights.Def `json:"defs"`
	Players     []insights.Player      `json:"players"`
}

// game is one two-sided game cut where it was decided.
type game struct {
	id    string
	fold  int
	y     float64 // 1 when side 0 won
	n     int
	t     []float64
	army  [2][]float64
	value [2][]float64 // nil when the file has none
	inc   [2][]float64
	lost  [2][]float64 // metal lost in the step, fought for
	enIn  [2][]float64
	elim  [2][]int // steps at which a team of the side was eliminated
	bat   []insights.Battle
	ally  [2]int32
	skill float64 // mean OS of side 0 minus side 1; NaN when unknown

	// Where things happened (geo.go); pos is false when either side has
	// no army centre to start from.
	mapName string
	pos     bool
	adv     [2][]float64 // army centre's way from own start to the enemy's, 0..1; NaN with no army
	lostBy  map[string]*[2][]float64
	// roleRank[role][w][side][step]: where the side's player at that
	// Isthmus position ranks by metal built (w 0 cumulative, 1 the last 3
	// minutes) among every player in the game, 0 = most, 1 = least.
	roleRank map[string]*[2][2][]float64
}

func main() {
	only := flag.String("only", "", "comma-separated variant names to run")
	mapRE := flag.String("map", "", "only games on maps matching this regexp")
	osFile := flag.String("os", "", "catalog rosters (jsonl: id, allies[{ally, os[]}])")
	flag.BoolVar(&debug, "debug", false, "print the series around the first unnamed income-carried moves")
	flag.Parse()
	gs := loadAll(flag.Args())
	if *mapRE != "" {
		re := regexp.MustCompile(*mapRE)
		var keep []*game
		for _, g := range gs {
			if re.MatchString(g.mapName) {
				keep = append(keep, g)
			}
		}
		gs = keep
	}
	if *osFile != "" {
		loadSkill(*osFile, gs)
	}
	roled := 0
	for _, g := range gs {
		if len(g.roleRank) == 2 {
			roled++
		}
	}
	fmt.Printf("%d games (%d with geo and eco players placed)\n", len(gs), roled)
	var names []string
	if *only != "" {
		names = strings.Split(*only, ",")
	}
	fmt.Printf("%-22s %6s %6s | %5s %5s %5s %5s | %6s %5s | %5s %5s %5s\n", "variant", "acc", "loss", "@25", "@50", "@75", "@90", "jitter", "rev5", "moves", "named", "unnam")
	for _, v := range variants {
		if names != nil && !contains(names, v.name) {
			continue
		}
		run(v, gs)
	}
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

func loadAll(roots []string) []*game {
	var paths []string
	for _, r := range roots {
		filepath.WalkDir(r, func(p string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() && strings.HasSuffix(p, ".json") {
				paths = append(paths, p)
			}
			return nil
		})
	}
	sort.Strings(paths)
	out := make([]*game, len(paths))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, p := range paths {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			b, err := os.ReadFile(p)
			if err != nil {
				return
			}
			var f file
			if json.Unmarshal(b, &f) != nil {
				return
			}
			out[i] = build(&f)
		}()
	}
	wg.Wait()
	var gs []*game
	seen := map[string]bool{}
	for _, g := range out {
		if g != nil && !seen[g.id] {
			seen[g.id] = true
			gs = append(gs, g)
		}
	}
	return gs
}

func build(f *file) *game {
	if f.POV != "full" || len(f.Sides) != 2 || f.Winner < 0 || f.Winner > 1 {
		return nil
	}
	s := f.Series
	if len(s.Army) != 2 || len(s.MetalIncome) != 2 {
		return nil
	}
	side := map[int32]int{}
	for _, t := range f.Teams {
		side[t.Team] = t.Side
	}
	died := map[int32]int32{}
	for _, e := range f.Eliminated {
		died[e.Team] = e.F
	}
	end := gameEnd(died, f.Teams)
	n := len(s.T)
	if end >= 0 {
		for n > 0 && s.T[n-1]*30 > float64(end)+step*30 {
			n--
		}
	}
	if n < 8 {
		return nil
	}
	h := fnv.New32a()
	h.Write([]byte(f.GameID))
	g := &game{id: f.GameID, fold: int(h.Sum32() % 5), n: n, t: s.T[:n], bat: f.Battles, skill: math.NaN()}
	g.ally = [2]int32{f.Sides[0].Ally, f.Sides[1].Ally}
	if f.Winner == 0 {
		g.y = 1
	}
	for k := 0; k < 2; k++ {
		g.army[k] = pad(s.Army[k], n)
		g.inc[k] = pad(s.MetalIncome[k], n)
		if len(s.EnergyIncome) == 2 {
			g.enIn[k] = pad(s.EnergyIncome[k], n)
		}
		if len(s.Value) == 2 {
			g.value[k] = pad(s.Value[k], n)
		}
		g.lost[k] = make([]float64, n)
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
		if st < n {
			g.lost[sd][st] += f.Deaths.Cost[i]
		}
	}
	geo(g, f, side, died)
	for _, e := range f.Eliminated {
		if sd, ok := side[e.Team]; ok && sd >= 0 && sd <= 1 {
			g.elim[sd] = append(g.elim[sd], int(e.F)/(step*30))
		}
	}
	return g
}

func pad(xs []float64, n int) []float64 {
	out := make([]float64, n)
	copy(out, xs)
	return out
}

// gameEnd mirrors insights' gameEnd for files written before Version 7 cut
// the game there.
func gameEnd(died map[int32]int32, teams []insights.Team) int32 {
	bySide := map[int][]int32{}
	for _, t := range teams {
		if t.Side >= 0 {
			bySide[t.Side] = append(bySide[t.Side], t.Team)
		}
	}
	if len(bySide) < 2 {
		return -1
	}
	type out struct{ last, start int32 }
	var gone []out
	for _, ts := range bySide {
		var fs []int32
		for _, t := range ts {
			f, ok := died[t]
			if !ok {
				break
			}
			fs = append(fs, f)
		}
		if len(fs) < len(ts) {
			continue
		}
		sort.Slice(fs, func(i, j int) bool { return fs[i] < fs[j] })
		last := fs[len(fs)-1]
		i := len(fs) - 1
		for i > 0 && last-fs[i-1] <= 300 {
			i--
		}
		gone = append(gone, out{last, fs[i]})
	}
	if len(gone) < len(bySide)-1 {
		return -1
	}
	sort.Slice(gone, func(i, j int) bool { return gone[i].last < gone[j].last })
	return gone[len(bySide)-2].start
}

// ---- model ----

type variant struct {
	name string
	feat func(g *game) [][]float64 // antisymmetric features per step
	post func(p []float64) []float64
}

func sigmoid(z float64) float64 { return 1 / (1 + math.Exp(-z)) }

func dot(c, f []float64) float64 {
	z := 0.0
	for k := range f {
		z += c[k] * f[k]
	}
	return z
}

type sample struct {
	f []float64
	y float64
	w float64
}

func fit(ss []sample, nf int) []float64 {
	c := make([]float64, nf)
	l2 := 1e-3
	for iter := 0; iter < 60; iter++ {
		g := make([]float64, nf)
		h := make([][]float64, nf)
		for k := range h {
			h[k] = make([]float64, nf)
			g[k] = l2 * c[k]
			h[k][k] = l2
		}
		for _, s := range ss {
			p := sigmoid(dot(c, s.f))
			for a := 0; a < nf; a++ {
				g[a] += s.w * (p - s.y) * s.f[a]
				for b := 0; b < nf; b++ {
					h[a][b] += s.w * p * (1 - p) * s.f[a] * s.f[b]
				}
			}
		}
		st := solve(h, g)
		moved := 0.0
		for k := range c {
			c[k] -= st[k]
			moved += math.Abs(st[k])
		}
		if moved < 1e-9 {
			break
		}
	}
	return c
}

func solve(a [][]float64, b []float64) []float64 {
	n := len(b)
	for i := 0; i < n; i++ {
		p := i
		for r := i + 1; r < n; r++ {
			if math.Abs(a[r][i]) > math.Abs(a[p][i]) {
				p = r
			}
		}
		a[i], a[p] = a[p], a[i]
		b[i], b[p] = b[p], b[i]
		if a[i][i] == 0 {
			continue
		}
		for r := i + 1; r < n; r++ {
			f := a[r][i] / a[i][i]
			for k := i; k < n; k++ {
				a[r][k] -= f * a[i][k]
			}
			b[r] -= f * b[i]
		}
	}
	x := make([]float64, n)
	for i := n - 1; i >= 0; i-- {
		if a[i][i] == 0 {
			continue
		}
		s := b[i]
		for k := i + 1; k < n; k++ {
			s -= a[i][k] * x[k]
		}
		x[i] = s / a[i][i]
	}
	return x
}

func samples(g *game, fs [][]float64) []sample {
	w := 1 / float64(len(fs))
	out := make([]sample, 0, 2*len(fs))
	for _, f := range fs {
		m := make([]float64, len(f))
		for k := range f {
			m[k] = -f[k]
		}
		out = append(out, sample{f, g.y, w}, sample{m, 1 - g.y, w})
	}
	return out
}

// ---- evaluation ----

var (
	debug  bool
	debugN int
)

const (
	moveSteps = 4
	moveMin   = 0.12
	moveGap   = 8
	opening   = 0.3
)

func run(v variant, gs []*game) {
	feats := make([][][]float64, len(gs))
	for i, g := range gs {
		feats[i] = v.feat(g)
	}
	nf := len(feats[0][0])
	coefAll := []float64{}
	ps := make([][]float64, len(gs))
	for fold := 0; fold < 5; fold++ {
		var ss []sample
		for i, g := range gs {
			if g.fold != fold {
				ss = append(ss, samples(g, feats[i])...)
			}
		}
		c := fit(ss, nf)
		for i, g := range gs {
			if g.fold == fold {
				p := make([]float64, len(feats[i]))
				for j, f := range feats[i] {
					p[j] = sigmoid(dot(c, f))
				}
				if v.post != nil {
					p = v.post(p)
				}
				ps[i] = p
			}
		}
	}
	{
		var ss []sample
		for i, g := range gs {
			ss = append(ss, samples(g, feats[i])...)
		}
		coefAll = fit(ss, nf)
	}
	var acc, loss, wsum float64
	at := []float64{0.25, 0.5, 0.75, 0.9}
	atAcc := make([]float64, 4)
	atN := make([]float64, 4)
	var jit, jitN, rev float64
	var moves, named, inBattle float64
	drv := make([]float64, nf)
	for i, g := range gs {
		p := ps[i]
		w := 1 / float64(len(p))
		for j, pj := range p {
			pp := math.Min(math.Max(pj, 1e-9), 1-1e-9)
			l := -(g.y*math.Log(pp) + (1-g.y)*math.Log(1-pp))
			r := 0.0
			if (pp > 0.5) == (g.y == 1) {
				r = 1
			}
			if pp == 0.5 {
				r = 0.5
			}
			acc += w * r
			loss += w * l
			wsum += w
			fr := float64(j+1) / float64(len(p))
			for k, a := range at {
				if math.Abs(fr-a) <= 0.025 {
					atAcc[k] += r
					atN[k]++
				}
			}
			if j > 0 {
				jit += math.Abs(pj - p[j-1])
				jitN++
			}
		}
		rev += reversals(p, 0.05)
		mv, nm, ib := explain(g, p, feats[i], coefAll, drv)
		moves += mv
		named += nm
		inBattle += ib
	}
	G := float64(len(gs))
	fmt.Printf("%-22s %5.1f%% %6.3f | %5.1f %5.1f %5.1f %5.1f | %6.2f %5.1f | %5.2f %4.0f%% %5.2f   coef %s\n", v.name,
		100*acc/wsum, loss/wsum,
		100*atAcc[0]/atN[0], 100*atAcc[1]/atN[1], 100*atAcc[2]/atN[2], 100*atAcc[3]/atN[3],
		100*jit/jitN, rev/G, moves/G, 100*named/math.Max(moves, 1), (moves-named)/G, fmtCoef(coefAll))
	fmt.Printf("%-22s moves overlapping a battle %.0f%%; unnamed moves by main driver: %s\n", "", 100*inBattle/math.Max(moves, 1), fmtCoef(drv))
}

func fmtCoef(c []float64) string {
	s := make([]string, len(c))
	for i, x := range c {
		s[i] = fmt.Sprintf("%.3f", x)
	}
	return strings.Join(s, " ")
}

// reversals counts zigzags of at least d.
func reversals(p []float64, d float64) float64 {
	if len(p) == 0 {
		return 0
	}
	n := 0.0
	ext := p[0]
	dir := 0
	for _, x := range p[1:] {
		switch {
		case dir >= 0 && x > ext:
			ext, dir = x, 1
		case dir <= 0 && x < ext:
			ext, dir = x, -1
		case dir == 1 && ext-x >= d:
			n++
			ext, dir = x, -1
		case dir == -1 && x-ext >= d:
			n++
			ext, dir = x, 1
		case dir == 0 && math.Abs(x-ext) >= d:
			if x > ext {
				dir = 1
			} else {
				dir = -1
			}
			ext = x
		}
	}
	return n
}

// explain finds the line's big moves past the opening, as the summary picks
// them, and counts how many come with an event it can name: the side the
// line moved against lost a fight (lost >= 1000 metal and at least 10% of its
// army more than the other side in the window), or a team of it was
// eliminated.
func explain(g *game, p []float64, fs [][]float64, coef []float64, drv []float64) (moves, named, inBattle float64) {
	type cand struct {
		i  int
		dp float64
	}
	var cs []cand
	start := int(opening * float64(len(p)))
	for i := moveSteps; i < len(p); i++ {
		if i-moveSteps < start {
			continue
		}
		if dp := p[i] - p[i-moveSteps]; math.Abs(dp) >= moveMin {
			cs = append(cs, cand{i, dp})
		}
	}
	sort.SliceStable(cs, func(a, b int) bool { return math.Abs(cs[a].dp) > math.Abs(cs[b].dp) })
	var picked []int
	for _, c := range cs {
		near := false
		for _, q := range picked {
			if d := c.i - q; d < moveGap && d > -moveGap {
				near = true
			}
		}
		if near {
			continue
		}
		picked = append(picked, c.i)
		moves++
		gain := 0
		if c.dp < 0 {
			gain = 1
		}
		f0, f1 := int32((c.i-moveSteps)*step*30), int32((c.i+2)*step*30)
		for _, b := range g.bat {
			if b.F0 <= f1 && b.F1 >= f0 {
				inBattle++
				break
			}
		}
		if nameable(g, gain, c.i-moveSteps-1, c.i+1) {
			named++
		} else {
			sign := 1.0
			if gain == 1 {
				sign = -1
			}
			best, bk := 0.0, -1
			for k := range coef {
				d := sign * coef[k] * (fs[c.i][k] - fs[c.i-moveSteps][k])
				if d > best {
					best, bk = d, k
				}
			}
			if bk >= 0 {
				drv[bk]++
			}
			if bk == 1 && debug && debugN < 25 {
				debugN++
				lo := max(0, c.i-moveSteps-12)
				fmt.Printf("  %s step %d (%.0fs) gain %d dp %.2f\n", g.id, c.i, g.t[c.i], gain, c.dp)
				for j := lo; j <= min(c.i+2, g.n-1); j++ {
					fmt.Printf("    %4.0fs inc %7.1f %7.1f  army %7.0f %7.0f lost %6.0f %6.0f p %.2f\n", g.t[j], g.inc[0][j], g.inc[1][j], g.army[0][j], g.army[1][j], g.lost[0][j], g.lost[1][j], p[j])
				}
			}
		}
	}
	return
}

func nameable(g *game, gain, lo, hi int) bool {
	if lo < 0 {
		lo = 0
	}
	if hi >= g.n {
		hi = g.n - 1
	}
	other := 1 - gain
	for _, e := range g.elim[other] {
		if e >= lo && e <= hi {
			return true
		}
	}
	var lostO, lostG float64
	for i := lo; i <= hi; i++ {
		lostO += g.lost[other][i]
		lostG += g.lost[gain][i]
	}
	base := g.army[other][lo]
	return lostO-lostG >= 1000 && lostO-lostG >= 0.1*base
}

func loadSkill(path string, gs []*game) {
	b, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	type row struct {
		ID     string `json:"id"`
		Allies []struct {
			Ally int32     `json:"ally"`
			OS   []float64 `json:"os"`
		} `json:"allies"`
	}
	m := map[string]row{}
	for _, l := range strings.Split(string(b), "\n") {
		var r row
		if json.Unmarshal([]byte(l), &r) == nil {
			m[r.ID] = r
		}
	}
	known := 0
	for _, g := range gs {
		r, ok := m[g.id]
		if !ok {
			continue
		}
		var mean [2]float64
		var got [2]bool
		for _, a := range r.Allies {
			for s := 0; s < 2; s++ {
				if a.Ally == g.ally[s] && len(a.OS) > 0 {
					t := 0.0
					for _, x := range a.OS {
						t += x
					}
					mean[s], got[s] = t/float64(len(a.OS)), true
				}
			}
		}
		if got[0] && got[1] {
			g.skill = mean[0] - mean[1]
			known++
		}
	}
	fmt.Printf("skill known for %d games\n", known)
}
