// Command p4conflict estimates how often a pipelined weapon target search
// (P4: AutoTarget's scan run on a worker while the main thread goes on with
// the next units' slow updates) would have to be waited for because the
// next unit's own slow update writes a unit the search may read.
//
// It reads unit positions from a .brp, shuffles each sample's units into a
// slow-update order (activeUnits is in random insertion order), cuts the
// slice the engine updates per frame, and for each unit asks whether it
// stands inside the scan circle of any of the last k searches launched.
//
//	go run ./experiments/p4conflict -from 63780 -to 64230 file.brp
package main

import (
	"flag"
	"fmt"
	"math"
	"math/rand"
	"os"

	"github.com/mabn/barreplay/snapshot"
)

func main() {
	from := flag.Int("from", 63780, "first sim frame")
	to := flag.Int("to", 64230, "last sim frame")
	quad := flag.Float64("quad", 128, "quad size in elmos")
	rate := flag.Int("rate", 16, "UNIT_SLOWUPDATE_RATE")
	flag.Parse()
	f, err := os.Open(flag.Arg(0))
	if err != nil {
		panic(err)
	}
	bf, err := snapshot.ParseBRP(f)
	if err != nil {
		panic(err)
	}
	ally := map[int32]int32{}
	for _, t := range bf.Meta.Teams {
		ally[t.TeamID] = t.AllyTeam
	}
	defs := bf.Meta.UnitDefs
	rng := rand.New(rand.NewSource(1))
	depths := []int{2, 4, 6, 12}
	type tally struct{ items, anyTeam, enemy, enemyDamaged int }
	res := make([]tally, len(depths))
	samples := 0
	for ci, c := range bf.Chunks {
		if int(c.Frame) > *to || (ci+1 < len(bf.Chunks) && int(bf.Chunks[ci+1].Frame) < *from) {
			continue
		}
		frames, err := bf.DecodeChunk(ci)
		if err != nil {
			panic(err)
		}
		for _, fr := range frames {
			if int(fr.Frame) < *from || int(fr.Frame) > *to {
				continue
			}
			samples++
			units := fr.Units
			perm := rng.Perm(len(units))
			n := len(units)/(*rate) + 1
			for di, k := range depths {
				// several slices per sample, as the slow update walks the list
				for s := 0; s+n <= len(perm); s += n {
					type scan struct {
						x, z, r float64
						ally    int32
					}
					var inflight []scan
					for _, pi := range perm[s : s+n] {
						u := units[pi]
						d := defs[u.DefID]
						ux, uz := float64(u.Pos.X), float64(u.Pos.Z)
						res[di].items++
						hitAny, hitEnemy := false, false
						for _, a := range inflight {
							dx, dz := ux-a.x, uz-a.z
							rr := a.r + *quad*0.71
							if dx*dx+dz*dz <= rr*rr {
								hitAny = true
								if ally[u.Team] != a.ally {
									hitEnemy = true
								}
							}
						}
						if hitAny {
							res[di].anyTeam++
						}
						if hitEnemy {
							res[di].enemy++
							if u.Health < u.MaxHealth {
								res[di].enemyDamaged++
							}
						}
						for w := 0; w < int(d.WeaponCount) && d.MaxWeaponRange > 0; w++ {
							inflight = append(inflight, scan{ux, uz, float64(d.MaxWeaponRange) * 1.1, ally[u.Team]})
						}
						if len(inflight) > k {
							inflight = inflight[len(inflight)-k:]
						}
					}
				}
			}
		}
	}
	fmt.Printf("%d samples, frames %d-%d, quad %.0f\n", samples, *from, *to, *quad)
	fmt.Println("searches in flight | slow updates that must wait: any team | enemy only | enemy and damaged")
	for di, k := range depths {
		t := res[di]
		p := func(v int) string { return fmt.Sprintf("%.1f%%", 100*float64(v)/math.Max(1, float64(t.items))) }
		fmt.Printf("%d | %s | %s | %s\n", k, p(t.anyTeam), p(t.enemy), p(t.enemyDamaged))
	}
}
