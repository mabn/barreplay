// brepsize: estimate a .brepstream's size if the WIDGET froze idle aircraft.
// Decodes the real stream, then re-runs the widget's exact encoder logic
// (quantize, keyframe every 64, omit fully-predicted units, columnar record
// bytes) over the frames — once raw, once through snapshot.NewAirIdleWriter.
package main

import (
	"fmt"
	"os"

	"github.com/mabn/barreplay/internal/capture"
	"github.com/mabn/barreplay/snapshot"
)

const keyframeEvery = 64

type q struct{ def, team, x, z, hp, max, dvx, dvz, b int64 }

// encSim mirrors assets/lua/replay_uploader.lua's delta emitter and counts
// the bytes each F record would occupy (tag+len framing + header + columns).
type encSim struct {
	meta    snapshot.Meta
	prev    map[int32]q
	sample  int
	bytes   int64
	frames  int
	restate int64
	total   int64
}

func rq(f float32) int64 { return int64(float64(f) + 0.5) }

func (e *encSim) WriteMeta(m snapshot.Meta) error { e.meta = m; return nil }
func (e *encSim) WriteEvent(ev snapshot.Event) error {
	e.bytes += 5 + 30 // E record framing + typical text payload
	return nil
}
func (e *encSim) Close() error { return nil }

func (e *encSim) WriteFrame(fr snapshot.Frame) error {
	se := e.meta.SampleEvery
	if se <= 0 {
		se = 30
	}
	keyframe := e.sample%keyframeEvery == 0
	e.sample++
	e.frames++
	if keyframe {
		e.prev = map[int32]q{}
	}
	live := make(map[int32]bool, len(fr.Units))
	n := 0
	for _, u := range fr.Units {
		live[u.UnitID] = true
		cur := q{
			def: int64(u.DefID), team: int64(u.Team),
			x: rq(u.Pos.X), z: rq(u.Pos.Z),
			hp: rq(u.Health), max: rq(u.MaxHealth),
			dvx: rq(u.VelX * float32(se)), dvz: rq(u.VelZ * float32(se)),
			b: int64(u.BuildProgress*255 + 0.5),
		}
		p, ok := e.prev[u.UnitID]
		if ok && !keyframe &&
			p.dvx == cur.dvx && p.dvz == cur.dvz &&
			p.x+p.dvx == cur.x && p.z+p.dvz == cur.z &&
			p.hp == cur.hp && p.max == cur.max && p.b == cur.b &&
			p.def == cur.def && p.team == cur.team {
			p.x, p.z = cur.x, cur.z
			e.prev[u.UnitID] = p
		} else {
			n++
			e.prev[u.UnitID] = cur
		}
	}
	e.total += int64(len(fr.Units))
	e.restate += int64(n)
	dead := 0
	if !keyframe {
		for id := range e.prev {
			if !live[id] {
				dead++
				delete(e.prev, id)
			}
		}
	}
	// tag+len(5) + header(10) + 22B per restated unit + 2B per dead id + 25B per resource row
	e.bytes += 5 + 10 + int64(n)*22 + int64(dead)*2 + int64(len(fr.Resources))*25
	return nil
}

func run(path string, freeze bool) *encSim {
	f, err := os.Open(path)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	sim := &encSim{prev: map[int32]q{}}
	var w snapshot.Writer = sim
	if freeze {
		w = snapshot.NewAirIdleWriter(sim, snapshot.AirIdleOptions{Radius: 700, IdleSamples: 3})
	}
	if err := capture.ConsumeBrep(f, snapshot.Meta{}, w); err != nil {
		panic(err)
	}
	return sim
}

func main() {
	path := os.Args[1]
	st, _ := os.Stat(path)
	base := run(path, false)
	frozen := run(path, true)
	preamble := st.Size() - base.bytes // actual file minus modelled records ≈ preamble
	fmt.Printf("file: %.1f MB (modelled records %.1f MB + preamble/etc %.1f MB)\n",
		mb(st.Size()), mb(base.bytes), mb(preamble))
	fmt.Printf("baseline: %d/%d unit records restated (%.0f%%)\n",
		base.restate, base.total, 100*float64(base.restate)/float64(base.total))
	fmt.Printf("frozen:   %d/%d unit records restated (%.0f%%)\n",
		frozen.restate, frozen.total, 100*float64(frozen.restate)/float64(frozen.total))
	fmt.Printf("estimated stream with widget-side freeze: %.1f MB (%.0f%% smaller)\n",
		mb(frozen.bytes+preamble), 100*(1-float64(frozen.bytes+preamble)/float64(st.Size())))
}

func mb(n int64) float64 { return float64(n) / (1024 * 1024) }
