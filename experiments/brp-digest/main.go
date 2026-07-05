// brp-digest prints a stable FNV-64a digest of a capture's decoded content,
// excluding y/dvy (dropped in .brp v3), for cross-version equivalence checks:
// run it on a v2 file with pre-v3 code and on the v3 re-pack with current
// code — matching digests prove the format change lost nothing else.
package main

import (
	"fmt"
	"hash/fnv"
	"math"
	"os"

	"github.com/mabn/barreplay/snapshot"
)

func main() {
	f, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	defer f.Close()
	meta, frames, events, err := snapshot.ReadBRP(f)
	if err != nil {
		panic(err)
	}
	se := float32(meta.SampleEvery)
	if se <= 0 {
		se = 30
	}
	h := fnv.New64a()
	wr := func(vs ...int64) {
		for _, v := range vs {
			var b [8]byte
			for i := 0; i < 8; i++ {
				b[i] = byte(v >> (8 * i))
			}
			h.Write(b[:])
		}
	}
	r := func(f float32) int64 { return int64(math.Round(float64(f))) }
	var units int64
	for _, fr := range frames {
		wr(int64(fr.Frame), int64(len(fr.Units)), int64(len(fr.Resources)))
		for _, u := range fr.Units {
			units++
			wr(int64(u.UnitID), int64(u.DefID), int64(u.Team),
				r(u.Pos.X), r(u.Pos.Z), r(u.Health), r(u.MaxHealth),
				r(u.VelX*se), r(u.VelZ*se), r(u.BuildProgress*255))
		}
		for _, rs := range fr.Resources {
			wr(int64(rs.Team), r(rs.Metal*10), r(rs.Energy*10), r(rs.MetalStorage*10),
				r(rs.EnergyStorage*10), r(rs.MetalIncome*10), r(rs.EnergyIncome*10))
		}
	}
	for _, e := range events {
		wr(int64(e.Frame), int64(len(e.Kind)), int64(e.UnitID), int64(e.DefID), int64(e.Team))
	}
	fmt.Printf("frames=%d units=%d events=%d digest=%x\n", len(frames), units, len(events), h.Sum64())
}
