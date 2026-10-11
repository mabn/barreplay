// Command winfit fits the summary's win-probability model
// (insights.WinModel) to games with a known winner, and prints the
// coefficients to commit in internal/insights/swing.go.
//
// Its input is insights files, the same ones the viewer reads: a game is used
// when it names a winner and has a swing line (two sides, full view). Collect
// them with the insights CLI in compute-only mode, which saves already
// published files as they are:
//
//	go run ./cmd/insights -upload= -all -out ./ins
//	go run ./cmd/winfit ./ins
//
// Every step of every game is a sample (features at that step, label = did
// side 0 win), weighted so each game counts once however long it ran, and
// mirrored (sides swapped) so the fit has no side bias to learn. The fit is
// Newton's method on the L2-regularised log loss, which for three
// coefficients converges in a handful of iterations. It prints the log loss
// and accuracy of the current coefficients and the fitted ones, overall and
// at fixed points through a game, so a fit that is not better is visible
// before it is committed.
//
// -categories also splits the games into internal/gamecat's categories (lava
// games lavabalance rates, large ranked team games, other ranked, unranked),
// read from each game's BAR API detail, and fits each one on its own — to see
// whether one set of weights describes them all. A detail is fetched once and
// kept under the user cache dir (barreplay/api.bar-rts.com/replays/), so a
// rerun asks the API only about games it has not seen:
//
//	go run ./cmd/winfit -categories ./ins
//
// -energy asks whether ENERGY income predicts the winner better than metal
// income. It reads the same files (every insights file already carries each
// side's energy income), builds the model's income features from energy
// instead of metal, and fits three models on the same games: the live one
// (army + metal), army + energy, and army + metal + energy, printing them
// side by side. It then fits every model again on each PHASE of a game alone
// (early/mid/late thirds of each game, and 0-10 / 10-25 / 25+ minutes of
// game time), to show which resource matters when. Nothing it fits changes
// the live model:
//
//	go run ./cmd/winfit -energy ./ins
//	go run ./cmd/winfit -energy -categories ./ins
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/mabn/barreplay/internal/gamecat"
	"github.com/mabn/barreplay/internal/insights"
)

// A sample carries every candidate feature; a model picks some of them.
const (
	fArmy      = iota // log ratio of army value
	fMetalInc         // ... of metal income over the last minute
	fMetalCum         // ... of metal income so far
	fEnergyInc        // ... of energy income over the last minute
	fEnergyCum        // ... of energy income so far
	nAll
)

// The energy features' smoothing constants. Metal's are 3 metal/s and 300
// metal (insights.swingIncomeK/swingCumK); BAR economies run at roughly
// twenty energy to the metal, so energy's are twenty times those.
const (
	energyIncK = 60
	energyCumK = 6000
)

// model is a choice of features; its coefficients pair with them in order.
type model struct {
	name  string
	feats []int
	label string // what the coefficients are, for the tables' header
}

var (
	metalModel  = model{"metal", []int{fArmy, fMetalInc, fMetalCum}, "army/inc/cum"}
	energyModel = model{"energy", []int{fArmy, fEnergyInc, fEnergyCum}, "army/einc/ecum"}
	bothModel   = model{"metal+energy", []int{fArmy, fMetalInc, fMetalCum, fEnergyInc, fEnergyCum}, "army/inc/cum/einc/ecum"}
)

type sample struct {
	f    [nAll]float64
	y    float64
	w    float64
	frac float64 // how far through its game, 0..1
	sec  float64 // game time at the step's end, seconds
}

// minGames is the fewest games a fit is made from; under it a fit describes
// those games, not BAR.
const minGames = 20

type game struct {
	id string
	ss []sample
}

func main() {
	l2 := flag.Float64("l2", 1e-3, "L2 regularisation strength")
	cats := flag.Bool("categories", false, "also fit each game category (lava / large ranked / ranked / unranked) on its own, from the BAR API's replay details")
	apiBase := flag.String("api", "https://api.bar-rts.com", "BAR API base URL (-categories)")
	cacheDir := flag.String("cache", "auto", "where -categories keeps fetched details (auto = the user cache dir; empty = no cache)")
	energy := flag.Bool("energy", false, "also fit models on energy income (army+energy, army+metal+energy) and compare them with the metal model on the same games")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: winfit [flags] <insights file or dir> [...]\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}
	var samples []sample
	var all []game
	games, skipped, broken := 0, 0, 0
	for _, root := range flag.Args() {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".json") || !strings.Contains(filepath.Base(path), ".insights") {
				return nil
			}
			id, ss, ok, err := load(path)
			if err != nil {
				// A truncated download is one game lost, not the run.
				fmt.Fprintf(os.Stderr, "winfit: skipping %s: %v\n", path, err)
				broken++
				return nil
			}
			if !ok {
				skipped++
				return nil
			}
			games++
			samples = append(samples, ss...)
			all = append(all, game{id, ss})
			return nil
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "winfit: %v\n", err)
			os.Exit(1)
		}
	}
	fmt.Printf("%d games (%d files skipped: no winner, no swing line, or another version)\n", games, skipped)
	if broken > 0 {
		fmt.Printf("%d files unreadable (delete them and fetch again)\n", broken)
	}
	if games < minGames {
		fmt.Fprintln(os.Stderr, "winfit: fewer than 20 games; a fit would describe these games, not BAR")
		os.Exit(1)
	}
	current := insights.WinModel.Coef[:]
	fit := newton(metalModel, samples, *l2)
	report("current", metalModel, current, samples)
	report("fitted", metalModel, fit, samples)
	fmt.Printf("\n// Paste into internal/insights/swing.go:\n")
	fmt.Printf("\tCoef:   [swingFeatures]float64{%.3f, %.3f, %.3f},\n\tFitted: true,\n\tGames:  %d,\n", fit[0], fit[1], fit[2], games)
	var extra []fitted
	if *energy {
		extra = []fitted{{energyModel, newton(energyModel, samples, *l2)}, {bothModel, newton(bothModel, samples, *l2)}}
		fmt.Printf("\n== metal vs energy income, fitted on the same %d games (log loss / accuracy; all in-sample) ==\n", games)
		table(append([]row{{"current", metalModel, current}, {"metal fit", metalModel, fit}}, fitRows(extra, " fit")...), samples)
		models := []model{metalModel, energyModel, bothModel}
		phaseReport("thirds of each game", thirds, models, samples, *l2)
		phaseReport("game time", byClock, models, samples, *l2)
	}
	if *cats {
		dir := *cacheDir
		if dir == "auto" {
			dir = ""
			if d, err := os.UserCacheDir(); err == nil {
				dir = filepath.Join(d, "barreplay", "api.bar-rts.com", "replays")
			}
		}
		f := &detailFetcher{base: strings.TrimRight(*apiBase, "/"), dir: dir, http: &http.Client{Timeout: 30 * time.Second}}
		byCat := categorize(all, f)
		reportCategories(byCat, fit, extra, *l2)
	}
}

// categorize fetches every game's detail (8 at a time) and groups the games
// by category; a game whose detail cannot be had is "unknown".
func categorize(gs []game, f *detailFetcher) map[gamecat.Category][]game {
	cats := make([]gamecat.Category, len(gs))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	var mu sync.Mutex
	failed := 0
	for i, g := range gs {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			d, err := f.detail(g.id)
			if err != nil {
				mu.Lock()
				failed++
				if failed <= 5 {
					fmt.Fprintf(os.Stderr, "winfit: %s: %v\n", g.id, err)
				}
				mu.Unlock()
				cats[i] = unknown
				return
			}
			cats[i] = gamecat.Classify(d)
		}()
	}
	wg.Wait()
	if failed > 0 {
		fmt.Fprintf(os.Stderr, "winfit: %d games without a BAR API detail, counted as %q\n", failed, unknown)
	}
	out := map[gamecat.Category][]game{}
	for i, g := range gs {
		out[cats[i]] = append(out[cats[i]], g)
	}
	return out
}

const unknown gamecat.Category = "unknown"

var gameIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// detailFetcher reads api.bar-rts.com/replays/<id>, keeping each good answer
// on disk: a finished game's detail never changes.
type detailFetcher struct {
	base string
	dir  string // "" = no cache
	http *http.Client
}

func (f *detailFetcher) detail(id string) (*gamecat.Detail, error) {
	if !gameIDRe.MatchString(id) {
		return nil, fmt.Errorf("no game id in the insights file")
	}
	var p string
	if f.dir != "" {
		p = filepath.Join(f.dir, id+".json")
		if b, err := os.ReadFile(p); err == nil {
			if d, err := decodeDetail(b); err == nil {
				return d, nil
			}
		}
	}
	resp, err := f.http.Get(f.base + "/replays/" + id)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET replays/%s: %s", id, resp.Status)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	d, err := decodeDetail(b)
	if err != nil {
		return nil, fmt.Errorf("replays/%s: %w", id, err)
	}
	if p != "" {
		// Best-effort, and via a rename so a killed run leaves no half file.
		if os.MkdirAll(f.dir, 0o755) == nil {
			tmp := p + ".tmp"
			if os.WriteFile(tmp, b, 0o644) == nil {
				os.Rename(tmp, p)
			}
		}
	}
	return d, nil
}

func decodeDetail(b []byte) (*gamecat.Detail, error) {
	var d gamecat.Detail
	if err := json.Unmarshal(b, &d); err != nil {
		return nil, err
	}
	if len(d.AllyTeams) == 0 {
		return nil, fmt.Errorf("detail has no teams")
	}
	return &d, nil
}

// reportCategories fits each category with enough games on its own and
// compares, on that category's games, the current weights, the all-games fit
// and the category's own fit.
//
// extra are the -energy models' all-games fits: each gets the same pair of
// rows, its all-games fit and its own fit on the category.
func reportCategories(byCat map[gamecat.Category][]game, overall []float64, extra []fitted, l2 float64) {
	current := insights.WinModel.Coef[:]
	fmt.Printf("\n== per category (log loss / accuracy on the category's own games; own fit is in-sample) ==\n")
	for _, c := range append(append([]gamecat.Category{}, gamecat.All...), unknown) {
		gs := byCat[c]
		if len(gs) == 0 {
			continue
		}
		var ss []sample
		for _, g := range gs {
			ss = append(ss, g.ss...)
		}
		fmt.Printf("\n%s: %d games\n", c, len(gs))
		rows := []row{{"current", metalModel, current}, {"all-games fit", metalModel, overall}}
		if len(gs) < minGames {
			fmt.Printf("  too few for a fit of its own\n")
			table(append(rows, fitRows(extra, " all")...), ss)
			continue
		}
		rows = append(rows, row{"own fit", metalModel, newton(metalModel, ss, l2)})
		for _, e := range extra {
			rows = append(rows, row{e.m.name + " all", e.m, e.c}, row{e.m.name + " own", e.m, newton(e.m, ss, l2)})
		}
		table(rows, ss)
	}
}

type fitted struct {
	m model
	c []float64
}

func fitRows(fs []fitted, suffix string) []row {
	var out []row
	for _, f := range fs {
		out = append(out, row{f.m.name + suffix, f.m, f.c})
	}
	return out
}

type row struct {
	name string
	m    model
	c    []float64
}

func table(rows []row, ss []sample) {
	// The coefficient column is as wide as the longest model's.
	cw, label := 20, "coef "+rows[0].m.label
	for _, r := range rows {
		if r.m.label != rows[0].m.label {
			label = "coefficients"
		}
		cw = max(cw, 5*len(r.c)+2)
	}
	fmt.Printf("  %-18s %-*s %-14s %-14s %-14s %-14s %s\n", "", cw, label, "all steps", "at 25%", "at 50%", "at 75%", "at 90%")
	for _, r := range rows {
		m := measure(r.m, r.c, ss)
		cs := make([]string, len(r.c))
		for i, c := range r.c {
			cs[i] = fmt.Sprintf("%.2f", c)
		}
		fmt.Printf("  %-18s %-*s", r.name, cw, strings.Join(cs, " "))
		for _, a := range append([]acc{m.all}, m.at...) {
			if a.w == 0 {
				fmt.Printf(" %-14s", "-")
				continue
			}
			fmt.Printf(" %-14s", fmt.Sprintf("%.3f %.1f%%", a.loss/a.w, 100*a.right/a.w))
		}
		fmt.Println()
	}
}

// A phase is a slice of every game's steps.
type phase struct {
	name string
	in   func(sample) bool
}

// thirds splits each game by how far through it a step is, so every game
// adds to every phase whatever its length.
var thirds = []phase{
	{"early", func(s sample) bool { return s.frac <= 1.0/3 }},
	{"mid", func(s sample) bool { return s.frac > 1.0/3 && s.frac <= 2.0/3 }},
	{"late", func(s sample) bool { return s.frac > 2.0/3 }},
}

// byClock splits by game time, which is what a player means by the early
// game: a short game has no late phase here, a long one a long late phase.
var byClock = []phase{
	{"0-10 min", func(s sample) bool { return s.sec <= 600 }},
	{"10-25 min", func(s sample) bool { return s.sec > 600 && s.sec <= 1500 }},
	{"25+ min", func(s sample) bool { return s.sec > 1500 }},
}

// phaseReport fits every model on each phase's steps alone and scores it
// there, so the coefficients say what each resource is worth at that point
// of a game. Each step keeps its game weight, so within a phase a game counts
// in proportion to the share of its steps that fall in it.
func phaseReport(title string, phases []phase, models []model, ss []sample, l2 float64) {
	fmt.Printf("\n== by phase (%s): each model fitted on that phase's steps only (in-sample) ==\n", title)
	for _, ph := range phases {
		var in []sample
		for _, s := range ss {
			if ph.in(s) {
				in = append(in, s)
			}
		}
		fmt.Printf("\n%s: %d steps\n", ph.name, len(in)/2)
		if len(in) == 0 {
			continue
		}
		cw := 0
		for _, m := range models {
			cw = max(cw, 5*len(m.feats)+2)
		}
		fmt.Printf("  %-14s %-24s %-*s %s\n", "", "features", cw, "coefficients", "log loss / accuracy")
		for _, m := range models {
			c := newton(m, in, l2)
			a := measure(m, c, in).all
			cs := make([]string, len(c))
			for i, v := range c {
				cs[i] = fmt.Sprintf("%.2f", v)
			}
			fmt.Printf("  %-14s %-24s %-*s %.3f %.1f%%\n", m.name, m.label, cw, strings.Join(cs, " "), a.loss/a.w, 100*a.right/a.w)
		}
	}
}

// load reads one insights file into mirrored, game-weighted samples, and
// the game's id.
func load(path string) (string, []sample, bool, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", nil, false, err
	}
	var ins insights.Insights
	if err := json.Unmarshal(b, &ins); err != nil {
		return "", nil, false, err
	}
	if ins.Version != insights.Version || ins.Swing == nil || ins.Winner < 0 || ins.Winner > 1 {
		return "", nil, false, nil
	}
	feats := insights.SwingFeatures(ins.Series)
	if len(feats) < 4 {
		return "", nil, false, nil
	}
	// Energy income is in every insights file the model reads; one with no
	// energy series reads as even on energy rather than being dropped, so
	// the metal and energy models always see the same games.
	energy := insights.IncomeFeatures(ins.Series.EnergyIncome, len(feats), energyIncK, energyCumK)
	y := 0.0
	if ins.Winner == 0 {
		y = 1
	}
	w := 1 / float64(len(feats))
	out := make([]sample, 0, 2*len(feats))
	for i, mf := range feats {
		frac := float64(i+1) / float64(len(feats))
		var f [nAll]float64
		f[fArmy], f[fMetalInc], f[fMetalCum] = mf[0], mf[1], mf[2]
		if energy != nil {
			f[fEnergyInc], f[fEnergyCum] = energy[i][0], energy[i][1]
		}
		var m [nAll]float64
		for k := range f {
			m[k] = -f[k]
		}
		sec := float64((i + 1) * insights.StepSec)
		out = append(out, sample{f, y, w, frac, sec}, sample{m, 1 - y, w, frac, sec})
	}
	return ins.GameID, out, true, nil
}

// prob is P(side 0 wins) under model m with coefficients c — the same
// sigmoid as insights.WinProb, over whichever features m picks.
func prob(m model, c []float64, f [nAll]float64) float64 {
	z := 0.0
	for k, fi := range m.feats {
		z += c[k] * f[fi]
	}
	return 1 / (1 + math.Exp(-z))
}

// newton minimises sum w*logloss + l2/2*|c|^2 for model m.
func newton(m model, ss []sample, l2 float64) []float64 {
	n := len(m.feats)
	c := make([]float64, n)
	x := make([]float64, n)
	for iter := 0; iter < 50; iter++ {
		g := make([]float64, n)
		hm := make([][]float64, n)
		for k := range hm {
			hm[k] = make([]float64, n)
			g[k] = l2 * c[k]
			hm[k][k] = l2
		}
		for _, s := range ss {
			p := prob(m, c, s.f)
			for a, fa := range m.feats {
				x[a] = s.f[fa]
			}
			for a := 0; a < n; a++ {
				g[a] += s.w * (p - s.y) * x[a]
				for b := 0; b < n; b++ {
					hm[a][b] += s.w * p * (1 - p) * x[a] * x[b]
				}
			}
		}
		step := solve(hm, g)
		moved := 0.0
		for k := range c {
			c[k] -= step[k]
			moved += math.Abs(step[k])
		}
		if moved < 1e-9 {
			break
		}
	}
	return c
}

// solve does Gaussian elimination with partial pivoting on a tiny system,
// in place.
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

type acc struct{ loss, right, w float64 }

var points = []float64{0.25, 0.5, 0.75, 0.9}

type metrics struct {
	all acc
	at  []acc // at points
}

// measure is the log loss and accuracy of c over ss, overall (game-weighted)
// and near fixed points of a game.
func measure(md model, c []float64, ss []sample) metrics {
	m := metrics{at: make([]acc, len(points))}
	for _, s := range ss {
		p := math.Min(math.Max(prob(md, c, s.f), 1e-9), 1-1e-9)
		loss := -(s.y*math.Log(p) + (1-s.y)*math.Log(1-p))
		right := 0.0
		if (p > 0.5) == (s.y == 1) {
			right = 1
		}
		m.all.loss += s.w * loss
		m.all.right += s.w * right
		m.all.w += s.w
		for i, pt := range points {
			if math.Abs(s.frac-pt) <= 0.025 {
				m.at[i].loss += loss
				m.at[i].right += right
				m.at[i].w++
			}
		}
	}
	return m
}

// report prints log loss and accuracy overall and near fixed points of a game.
func report(name string, md model, c []float64, ss []sample) {
	fmt.Printf("\n%s coefficients %.3f %.3f %.3f\n", name, c[0], c[1], c[2])
	m := measure(md, c, ss)
	fmt.Printf("  all steps: log loss %.3f, accuracy %.1f%%\n", m.all.loss/m.all.w, 100*m.all.right/m.all.w)
	for i, pt := range points {
		if m.at[i].w > 0 {
			fmt.Printf("  at %3.0f%%:   log loss %.3f, accuracy %.1f%%\n", 100*pt, m.at[i].loss/m.at[i].w, 100*m.at[i].right/m.at[i].w)
		}
	}
}
