// air-idle-continuity: verify the air-idle transform never introduces a
// positional discontinuity. Measures per-sample aircraft displacement in a
// raw .brepstream and in its air-idle-transformed frames, and cross-checks
// that every transformed step above the glide cap coincides with a raw-data
// jump (ghost re-spots) at the same unit+frame — i.e. the transform only
// preserves the capture's own discontinuities, never creates one.
package main

import (
	"fmt"
	"os"
	"sort"

	"github.com/mabn/barreplay/internal/capture"
	"github.com/mabn/barreplay/snapshot"
)

type sink struct {
	meta   snapshot.Meta
	frames []snapshot.Frame
}

func (s *sink) WriteMeta(m snapshot.Meta) error   { s.meta = m; return nil }
func (s *sink) WriteFrame(f snapshot.Frame) error { s.frames = append(s.frames, f); return nil }
func (s *sink) WriteEvent(e snapshot.Event) error { return nil }
func (s *sink) Close() error                      { return nil }

func analyze(name string, meta snapshot.Meta, frames []snapshot.Frame) map[[2]int32]bool {
	fly := map[int32]bool{}
	speed := map[int32]float32{}
	for id, d := range meta.UnitDefs {
		if d.CanFly {
			fly[id] = true
			speed[id] = d.Speed
		}
	}
	prev := map[int32][2]float32{}
	var steps []float64
	over := 0
	overSet := map[[2]int32]bool{}
	var maxStep, maxSpeed float64
	for _, fr := range frames {
		cur := map[int32][2]float32{}
		for _, u := range fr.Units {
			if !fly[u.DefID] {
				continue
			}
			cur[u.UnitID] = [2]float32{u.Pos.X, u.Pos.Z}
			if p, ok := prev[u.UnitID]; ok {
				dx, dz := float64(u.Pos.X-p[0]), float64(u.Pos.Z-p[1])
				d := sqrt(dx*dx + dz*dz)
				steps = append(steps, d)
				sp := float64(speed[u.DefID]) // elmos/sec; 1 sample = 1 sec
				if sp > 0 && d > 2.05*sp {    // above the glide cap = a genuine discontinuity
					over++
					overSet[[2]int32{u.UnitID, fr.Frame}] = true
					if d > maxStep {
						maxStep, maxSpeed = d, sp
					}
				}
			}
		}
		prev = cur
	}
	sort.Float64s(steps)
	q := func(p float64) float64 { return steps[int(p*float64(len(steps)-1))] }
	fmt.Printf("%-22s %8d steps  p50 %5.0f  p99 %6.0f  max %6.0f  | steps above glide cap (2.05x speed): %d (worst %.0f vs speed %.0f)\n",
		name, len(steps), q(0.5), q(0.99), steps[len(steps)-1], over, maxStep, maxSpeed)
	return overSet
}

func main() {
	f, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	defer f.Close()
	raw := &sink{}
	if err := capture.ConsumeBrep(f, snapshot.Meta{}, raw); err != nil {
		panic(err)
	}
	rawOver := analyze("raw stream", raw.meta, raw.frames)

	opt := &sink{}
	w := snapshot.NewAirIdleWriter(opt, snapshot.AirIdleOptions{})
	w.WriteMeta(raw.meta)
	for _, fr := range raw.frames {
		w.WriteFrame(fr)
	}
	w.Close()
	optOver := analyze("air-idle transformed", opt.meta, opt.frames)
	introduced := 0
	for k := range optOver {
		if !rawOver[k] {
			introduced++
			if introduced <= 5 {
				fmt.Printf("INTRODUCED discontinuity: unit %d frame %d\n", k[0], k[1])
			}
		}
	}
	fmt.Printf("discontinuities introduced by the transform: %d\n", introduced)
}

func sqrt(v float64) float64 {
	if v <= 0 {
		return 0
	}
	x := v
	for i := 0; i < 40; i++ {
		x = (x + v/x) / 2
	}
	return x
}
