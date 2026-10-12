// Command buildingworth reads published .brp files and writes, per game,
// each side's standing metal by unit category every 15 s — at full price
// (weighted by build progress, like the summary's army) and weighted by
// health as well — plus a def-name -> category table the insights-based
// experiments use to sort deaths.
//
//	go run ./experiments/buildingworth -out ./bw ./brp/*.brp
//	go run ./experiments/buildingworth -legacy rids.txt -tables ./bw -out ./bwl
//	go run ./experiments/buildingworth -groups groups.tsv ./ins
//
// It fed the "should buildings count for more than units?" study:
// experiments/winmodel -bw ./bw -defcat ./bw/defcat.json then compares
// building weights on the win line.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/mabn/barreplay/snapshot"
)

const stepSec = 15

// Game is one replay's standing metal: Cost[ally][cat][step] at full price,
// HP[...] the same weighted by each unit's health share.
type Game struct {
	GameID  string                         `json:"gameId"`
	Winners []int32                        `json:"winners"`
	T       []float64                      `json:"t"`
	Cost    map[int32]map[string][]float64 `json:"cost"`
	HP      map[int32]map[string][]float64 `json:"hp"`
}

func main() {
	out := flag.String("out", "bw", "output directory")
	flag.StringVar(&insOut, "insout", "", "also compute each replay's summary (current insights code) into this directory")
	flag.StringVar(&oldIns, "oldins", "", "published summaries (<rid with / as _>.json), for the winner when the .brp has none")
	legacy := flag.String("legacy", "", "file of revision ids published as split pieces: read their heads and keyframes instead of .brp files")
	tables := flag.String("tables", "", "with -legacy: directory holding defcat.json and defcost.json from a .brp run")
	cache := flag.String("cache", "pieces", "with -legacy: where downloaded pieces are kept")
	groups := flag.String("groups", "", "sort the games behind the insights directory given as the argument into the map groups, writing a TSV here")
	details := flag.String("details", "details", "with -groups: where api.bar-rts.com replay details are kept")
	flag.Parse()
	if *groups != "" {
		runGroups(flag.Arg(0), *details, *groups)
		return
	}
	if *legacy != "" {
		runLegacy(*legacy, *tables, *cache, *out)
		return
	}
	os.MkdirAll(*out, 0o755)
	defCat := map[string]string{}
	defCost := map[string]float64{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, p := range flag.Args() {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			if insOut != "" {
				if err := summarize(p); err != nil {
					fmt.Fprintln(os.Stderr, p, "insights:", err)
				}
			}
			g, defs, err := extract(p)
			if err != nil {
				fmt.Fprintln(os.Stderr, p, err)
				return
			}
			mu.Lock()
			for n, c := range defs {
				defCat[n] = c.cat
				defCost[n] = c.cost
			}
			mu.Unlock()
			b, _ := json.Marshal(g)
			os.WriteFile(filepath.Join(*out, g.GameID+".json"), b, 0o644)
		}()
	}
	wg.Wait()
	b, _ := json.MarshalIndent(defCat, "", " ")
	os.WriteFile(filepath.Join(*out, "defcost.json"), must(json.MarshalIndent(defCost, "", " ")), 0o644)
	os.WriteFile(filepath.Join(*out, "defcat.json"), b, 0o644)
	fmt.Println(len(defCat), "defs")
}

type defInfo struct {
	cat  string
	cost float64
}

func must(b []byte, err error) []byte {
	if err != nil {
		panic(err)
	}
	return b
}

func extract(path string) (*Game, map[string]defInfo, error) {
	fh, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer fh.Close()
	f, err := snapshot.ParseBRP(bufio.NewReader(fh))
	if err != nil {
		return nil, nil, err
	}
	return extractFile(f)
}

func extractFile(f *snapshot.BRPFile) (*Game, map[string]defInfo, error) {
	m := f.Meta
	defs := map[int32]snapshot.UnitDef{}
	names := map[string]string{}
	infos := map[string]defInfo{}
	for _, d := range m.UnitDefs {
		defs[d.DefID] = d
		names[d.Name] = category(d)
		if c, ok := legacyCats[d.Name]; ok {
			names[d.Name] = c
		}
		infos[d.Name] = defInfo{names[d.Name], float64(d.MetalCost)}
	}
	ally := map[int32]int32{}
	for _, t := range m.Teams {
		ally[t.TeamID] = t.AllyTeam
	}
	g := &Game{GameID: m.GameID, Winners: m.Winners, Cost: map[int32]map[string][]float64{}, HP: map[int32]map[string][]float64{}}
	add := func(dst map[int32]map[string][]float64, a int32, c string, st int, v float64) {
		if dst[a] == nil {
			dst[a] = map[string][]float64{}
		}
		s := dst[a][c]
		for len(s) <= st {
			s = append(s, 0)
		}
		s[st] += v
		dst[a][c] = s
	}
	last := -1
	var sampled []int
	for i := range f.Chunks {
		frames, err := f.DecodeChunk(i)
		if err != nil {
			return nil, nil, err
		}
		for k, fr := range frames {
			st := int(fr.Frame) / (stepSec * 30)
			// the step's last sample: the next frame is in a later step
			if k+1 < len(frames) && int(frames[k+1].Frame)/(stepSec*30) == st {
				continue
			}
			if st <= last {
				continue
			}
			last = st
			sampled = append(sampled, st)
			for len(g.T) <= st {
				g.T = append(g.T, float64(len(g.T)*stepSec+stepSec))
			}
			for _, u := range fr.Units {
				d, ok := defs[u.DefID]
				a, ok2 := ally[u.Team]
				if !ok || !ok2 || d.MetalCost <= 0 {
					continue
				}
				c := names[d.Name]
				b := float64(u.BuildProgress)
				v := float64(d.MetalCost) * b
				add(g.Cost, a, c, st, v)
				h := 1.0
				if u.MaxHealth > 0 && b >= 1 {
					h = float64(u.Health) / float64(u.MaxHealth)
					if h < 0 {
						h = 0
					}
					if h > 1 {
						h = 1
					}
				}
				add(g.HP, a, c, st, v*h)
			}
		}
	}
	if len(sampled) > 1 && len(sampled) < len(g.T)/2 {
		fill(g.Cost, sampled, len(g.T))
		fill(g.HP, sampled, len(g.T))
	}
	return g, infos, nil
}

// fill holds each sampled step's value until the next sample (a
// keyframes-only replay samples one step a minute). It must not interpolate:
// that would hand a step the NEXT minute's value, which the win model would
// happily read as foresight.
func fill(m map[int32]map[string][]float64, sampled []int, n int) {
	for _, byCat := range m {
		for c, xs := range byCat {
			ys := make([]float64, n)
			copy(ys, xs)
			for k := 0; k+1 < len(sampled); k++ {
				a, b := sampled[k], sampled[k+1]
				for j := a + 1; j < b; j++ {
					ys[j] = at(ys, a)
				}
			}
			for j := sampled[len(sampled)-1] + 1; j < n; j++ {
				ys[j] = ys[sampled[len(sampled)-1]]
			}
			byCat[c] = ys
		}
	}
}

func at(xs []float64, i int) float64 {
	if i < len(xs) {
		return xs[i]
	}
	return 0
}
