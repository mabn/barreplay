// Command winfit fits the summary's win-probability models
// (insights.WinModels) to games with a known winner, and prints the
// coefficients to commit in internal/insights/swing.go.
//
// Its input is insights files, the same ones the viewer reads: a game is used
// when it names a winner and has a swing line (two sides, full view). Collect
// them with the insights CLI in compute-only mode, which saves already
// published files as they are:
//
//	go run ./cmd/insights -upload= -all -out ./ins
//	go run ./cmd/winfit -model lava ./ins
//	go run ./cmd/winfit -model ranked8v8 ./ins
//
// -model fits one of the two models on the games it is for, as their
// coefficients were first fitted (experiments/winmodel, 2026-10-12): "lava"
// on the lava games lavabalance stores, "ranked8v8" on ranked games between
// two teams of eight that are not lava games — sorted by each game's BAR API
// detail (internal/gamecat), fetched and cached as -categories does. Without
// -model every game is fitted together, against the ranked 8v8 model.
//
// Every step of every game is a sample (features at that step, label = did
// side 0 win), weighted so each game counts once however long it ran, and
// mirrored (sides swapped) so the fit has no side bias to learn. The fit is
// Newton's method on the L2-regularised log loss, which for five
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

var zeroModel insights.WinModelFit

const nf = len(zeroModel.Coef)

type sample struct {
	f    [nf]float64
	y    float64
	w    float64
	frac float64 // how far through its game, 0..1
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
	cacheDir := flag.String("cache", "auto", "where -categories and -model keep fetched details (auto = the user cache dir; empty = no cache)")
	model := flag.String("model", "", "fit one model on the games it is for: lava or ranked8v8 (empty: every game, compared against the ranked 8v8 model)")
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
	fmt.Printf("%d games (%d files skipped: no winner, no swing line, or older than Version %d)\n", games, skipped, minVersion)
	if broken > 0 {
		fmt.Printf("%d files unreadable (delete them and fetch again)\n", broken)
	}
	dir := *cacheDir
	if dir == "auto" {
		dir = ""
		if d, err := os.UserCacheDir(); err == nil {
			dir = filepath.Join(d, "barreplay", "api.bar-rts.com", "replays")
		}
	}
	f := &detailFetcher{base: strings.TrimRight(*apiBase, "/"), dir: dir, http: &http.Client{Timeout: 30 * time.Second}}
	current, ok := insights.WinModels[insights.ModelRanked]
	switch *model {
	case "":
	case insights.ModelLava, insights.ModelRanked:
		current = insights.WinModels[*model]
		all = modelGames(all, f, *model)
		samples = nil
		for _, g := range all {
			samples = append(samples, g.ss...)
		}
		games = len(all)
		fmt.Printf("%d of them are %s games\n", games, *model)
	default:
		fmt.Fprintf(os.Stderr, "winfit: -model %q: want %s or %s\n", *model, insights.ModelLava, insights.ModelRanked)
		os.Exit(2)
	}
	if !ok {
		panic("winfit: no ranked 8v8 model")
	}
	if games < minGames {
		fmt.Fprintln(os.Stderr, "winfit: fewer than 20 games; a fit would describe these games, not BAR")
		os.Exit(1)
	}
	fit := newton(samples, *l2)
	report("current", current.Coef, samples)
	report("fitted", fit, samples)
	name := *model
	if name == "" {
		name = insights.ModelRanked
	}
	fmt.Printf("\n// Paste into WinModels in internal/insights/swing.go:\n")
	fmt.Printf("\t%s: {Coef: [swingFeatures]float64{%s}, Fitted: true, Games: %d},\n", modelConst(name), coefs(fit, "%.3f", ", "), games)
	if *cats {
		byCat := categorize(all, f)
		reportCategories(byCat, current.Coef, fit, *l2)
	}
}

func modelConst(name string) string {
	if name == insights.ModelLava {
		return "ModelLava"
	}
	return "ModelRanked"
}

// modelGames keeps the games a model is fitted on, by their BAR API detail
// (a game whose detail cannot be had is dropped).
func modelGames(gs []game, f *detailFetcher, model string) []game {
	keep := make([]bool, len(gs))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, g := range gs {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			d, err := f.detail(g.id)
			if err != nil {
				fmt.Fprintf(os.Stderr, "winfit: %s: %v\n", g.id, err)
				return
			}
			if model == insights.ModelLava {
				keep[i] = gamecat.Classify(d) == gamecat.Lava
			} else {
				keep[i] = gamecat.IsRanked8v8(d)
			}
		}()
	}
	wg.Wait()
	var out []game
	for i, g := range gs {
		if keep[i] {
			out = append(out, g)
		}
	}
	return out
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
func reportCategories(byCat map[gamecat.Category][]game, current, overall [nf]float64, l2 float64) {
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
		if len(gs) < minGames {
			fmt.Printf("  too few for a fit of its own\n")
			table([]row{{"current", current}, {"all-games fit", overall}}, ss)
			continue
		}
		own := newton(ss, l2)
		table([]row{{"current", current}, {"all-games fit", overall}, {"own fit", own}}, ss)
	}
}

type row struct {
	name string
	c    [nf]float64
}

func table(rows []row, ss []sample) {
	fmt.Printf("  %-14s %-24s %-14s %-14s %-14s %-14s %s\n", "", "coef army/inc/cum/kill/bld", "all steps", "at 25%", "at 50%", "at 75%", "at 90%")
	for _, r := range rows {
		m := measure(r.c, ss)
		fmt.Printf("  %-14s %-24s", r.name, coefs(r.c, "%.2f", " "))
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
	if ins.Version < minVersion || ins.Swing == nil || ins.Winner < 0 || ins.Winner > 1 {
		return "", nil, false, nil
	}
	feats := insights.SwingFeatures(ins.Series, insights.Killed(&ins))
	if len(feats) < 4 {
		return "", nil, false, nil
	}
	y := 0.0
	if ins.Winner == 0 {
		y = 1
	}
	w := 1 / float64(len(feats))
	out := make([]sample, 0, 2*len(feats))
	for i, f := range feats {
		frac := float64(i+1) / float64(len(feats))
		var m [nf]float64
		for k := range f {
			m[k] = -f[k]
		}
		out = append(out, sample{f, y, w, frac}, sample{m, 1 - y, w, frac})
	}
	return ins.GameID, out, true, nil
}

// minVersion is the oldest insights file a fit reads: Version 10 is the
// first to carry standing buildings (and which deaths were buildings), which
// two of the features read. Older files would fit those two at zero.
const minVersion = 10

func coefs(c [nf]float64, f, sep string) string {
	s := make([]string, nf)
	for k, x := range c {
		s[k] = fmt.Sprintf(f, x)
	}
	return strings.Join(s, sep)
}

func prob(c [nf]float64, f [nf]float64) float64 { return insights.WinProb(c, f) }

// newton minimises sum w*logloss + l2/2*|c|^2.
func newton(ss []sample, l2 float64) [nf]float64 {
	var c [nf]float64
	for iter := 0; iter < 50; iter++ {
		var g [nf]float64
		var hm [nf][nf]float64
		for k := 0; k < nf; k++ {
			g[k] = l2 * c[k]
			hm[k][k] = l2
		}
		for _, s := range ss {
			p := prob(c, s.f)
			for a := 0; a < nf; a++ {
				g[a] += s.w * (p - s.y) * s.f[a]
				for b := 0; b < nf; b++ {
					hm[a][b] += s.w * p * (1 - p) * s.f[a] * s.f[b]
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

// solve does Gaussian elimination with partial pivoting on a tiny system.
func solve(a [nf][nf]float64, b [nf]float64) [nf]float64 {
	for i := 0; i < nf; i++ {
		p := i
		for r := i + 1; r < nf; r++ {
			if math.Abs(a[r][i]) > math.Abs(a[p][i]) {
				p = r
			}
		}
		a[i], a[p] = a[p], a[i]
		b[i], b[p] = b[p], b[i]
		if a[i][i] == 0 {
			continue
		}
		for r := i + 1; r < nf; r++ {
			f := a[r][i] / a[i][i]
			for k := i; k < nf; k++ {
				a[r][k] -= f * a[i][k]
			}
			b[r] -= f * b[i]
		}
	}
	var x [nf]float64
	for i := nf - 1; i >= 0; i-- {
		if a[i][i] == 0 {
			continue
		}
		s := b[i]
		for k := i + 1; k < nf; k++ {
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
func measure(c [nf]float64, ss []sample) metrics {
	m := metrics{at: make([]acc, len(points))}
	for _, s := range ss {
		p := math.Min(math.Max(prob(c, s.f), 1e-9), 1-1e-9)
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
func report(name string, c [nf]float64, ss []sample) {
	fmt.Printf("\n%s coefficients %s\n", name, coefs(c, "%.3f", " "))
	m := measure(c, ss)
	fmt.Printf("  all steps: log loss %.3f, accuracy %.1f%%\n", m.all.loss/m.all.w, 100*m.all.right/m.all.w)
	for i, pt := range points {
		if m.at[i].w > 0 {
			fmt.Printf("  at %3.0f%%:   log loss %.3f, accuracy %.1f%%\n", 100*pt, m.at[i].loss/m.at[i].w, 100*m.at[i].right/m.at[i].w)
		}
	}
}
