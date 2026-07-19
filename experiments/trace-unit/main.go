// trace-unit: print one unit's raw vs air-idle-transformed track.
package main

import (
	"fmt"
	"os"
	"strconv"

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

func main() {
	id64, _ := strconv.Atoi(os.Args[2])
	lo, _ := strconv.Atoi(os.Args[3])
	hi, _ := strconv.Atoi(os.Args[4])
	id := int32(id64)

	f, _ := os.Open(os.Args[1])
	defer f.Close()
	raw := &sink{}
	if err := capture.ConsumeBrep(f, snapshot.Meta{}, raw); err != nil {
		panic(err)
	}
	opt := &sink{}
	w := snapshot.NewAirIdleWriter(opt, snapshot.AirIdleOptions{})
	w.WriteMeta(raw.meta)
	for _, fr := range raw.frames {
		w.WriteFrame(fr)
	}
	find := func(fr snapshot.Frame) *snapshot.UnitState {
		for i := range fr.Units {
			if fr.Units[i].UnitID == id {
				return &fr.Units[i]
			}
		}
		return nil
	}
	cmd := func(fr snapshot.Frame) string {
		for _, c := range fr.Commands {
			if c.UnitID == id {
				return fmt.Sprintf("cmd=%d tgt=%d t=(%d,%d) bt=%d", c.Cmd, c.TargetID, c.TX, c.TZ, c.Buildee)
			}
		}
		return "idle"
	}
	if u0 := find(raw.frames[lo]); u0 != nil {
		d := raw.meta.UnitDefs[u0.DefID]
		fmt.Printf("unit %d: def %d %s (%s) speed=%.0f canFly=%v\n\n", id, u0.DefID, d.Name, d.HumanName, d.Speed, d.CanFly)
	}
	fmt.Printf("%5s %8s | %18s %14s | %18s %8s | %s\n", "smpl", "frame", "raw pos", "raw vel", "emitted pos", "step", "command")
	var px, pz float32
	for i := lo; i <= hi && i < len(raw.frames); i++ {
		r, o := find(raw.frames[i]), find(opt.frames[i])
		if r == nil || o == nil {
			fmt.Printf("%5d: absent\n", i)
			continue
		}
		step := float32(0)
		if i > lo {
			dx, dz := o.Pos.X-px, o.Pos.Z-pz
			step = dx*dx + dz*dz
		}
		px, pz = o.Pos.X, o.Pos.Z
		mark := ""
		if o.Pos != r.Pos {
			mark = " *"
		}
		fmt.Printf("%5d %8d | (%7.1f,%7.1f) (%5.2f,%5.2f) | (%7.1f,%7.1f)%s %8.0f | %s\n",
			i, raw.frames[i].Frame, r.Pos.X, r.Pos.Z, r.VelX, r.VelZ, o.Pos.X, o.Pos.Z, mark, sqrt(step), cmd(raw.frames[i]))
	}
}

func sqrt(v float32) float64 {
	if v <= 0 {
		return 0
	}
	x := float64(v)
	for i := 0; i < 30; i++ {
		x = (x + float64(v)/x) / 2
	}
	return x
}
