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
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/mabn/barreplay/internal/insights"
)

const nf = 3 // len(insights.WinModel.Coef)

type sample struct {
	f    [nf]float64
	y    float64
	w    float64
	frac float64 // how far through its game, 0..1
}

func main() {
	l2 := flag.Float64("l2", 1e-3, "L2 regularisation strength")
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
	games, skipped := 0, 0
	for _, root := range flag.Args() {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".json") || !strings.Contains(filepath.Base(path), ".insights") {
				return nil
			}
			ss, ok, err := load(path)
			if err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			if !ok {
				skipped++
				return nil
			}
			games++
			samples = append(samples, ss...)
			return nil
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "winfit: %v\n", err)
			os.Exit(1)
		}
	}
	fmt.Printf("%d games (%d files skipped: no winner, no swing line, or another version)\n", games, skipped)
	if games < 20 {
		fmt.Fprintln(os.Stderr, "winfit: fewer than 20 games; a fit would describe these games, not BAR")
		os.Exit(1)
	}
	fit := newton(samples, *l2)
	report("current", insights.WinModel.Coef, samples)
	report("fitted", fit, samples)
	fmt.Printf("\n// Paste into internal/insights/swing.go:\n")
	fmt.Printf("\tCoef:   [swingFeatures]float64{%.3f, %.3f, %.3f},\n\tFitted: true,\n\tGames:  %d,\n", fit[0], fit[1], fit[2], games)
}

// load reads one insights file into mirrored, game-weighted samples.
func load(path string) ([]sample, bool, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false, err
	}
	var ins insights.Insights
	if err := json.Unmarshal(b, &ins); err != nil {
		return nil, false, err
	}
	if ins.Version != insights.Version || ins.Swing == nil || ins.Winner < 0 || ins.Winner > 1 {
		return nil, false, nil
	}
	feats := insights.SwingFeatures(ins.Series)
	if len(feats) < 4 {
		return nil, false, nil
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
	return out, true, nil
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

// report prints log loss and accuracy overall and near fixed points of a game.
func report(name string, c [nf]float64, ss []sample) {
	fmt.Printf("\n%s coefficients %.3f %.3f %.3f\n", name, c[0], c[1], c[2])
	type acc struct{ loss, right, w float64 }
	var all acc
	points := []float64{0.25, 0.5, 0.75, 0.9}
	at := make([]acc, len(points))
	for _, s := range ss {
		p := math.Min(math.Max(prob(c, s.f), 1e-9), 1-1e-9)
		loss := -(s.y*math.Log(p) + (1-s.y)*math.Log(1-p))
		right := 0.0
		if (p > 0.5) == (s.y == 1) {
			right = 1
		}
		all.loss += s.w * loss
		all.right += s.w * right
		all.w += s.w
		for i, pt := range points {
			if math.Abs(s.frac-pt) <= 0.025 {
				at[i].loss += loss
				at[i].right += right
				at[i].w++
			}
		}
	}
	fmt.Printf("  all steps: log loss %.3f, accuracy %.1f%%\n", all.loss/all.w, 100*all.right/all.w)
	for i, pt := range points {
		if at[i].w > 0 {
			fmt.Printf("  at %3.0f%%:   log loss %.3f, accuracy %.1f%%\n", 100*pt, at[i].loss/at[i].w, 100*at[i].right/at[i].w)
		}
	}
}
