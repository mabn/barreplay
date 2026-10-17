// airdag: how much of the aircraft move-type loop could run side by side
// while staying EXACTLY sequential. Each aircraft's update reads the positions
// of the units in the quad-field cells around it (the collision checks), so two
// aircraft whose neighbourhoods overlap must run in their loop order; a
// crashing aircraft can kill and explode, so it is a barrier. The critical
// path of that DAG bounds the speed-up of a dependency-aware parallel loop.
//
//	go run ./experiments/airdag <file.brp> <frame> [quad size] [reach]
package main

import (
	"fmt"
	"math/rand"
	"os"
	"sort"
	"strconv"

	"github.com/mabn/barreplay/snapshot"
)

func main() {
	f, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	defer f.Close()
	want, _ := strconv.Atoi(os.Args[2])
	quad := 128.0
	if len(os.Args) > 3 {
		quad, _ = strconv.ParseFloat(os.Args[3], 64)
	}
	_ = quad
	meta, frames, _, err := snapshot.ReadBRP(f)
	if err != nil {
		panic(err)
	}
	for _, w := range []int{want - 9000, want - 3000, want, want + 3000} {
		var fr *snapshot.Frame
		for i := range frames {
			if int(frames[i].Frame) >= w {
				fr = &frames[i]
				break
			}
		}
		if fr == nil {
			continue
		}
		type ac = struct {
			cx, cz int
			crash  bool
		}
		var air []ac
		crash := 0
		for _, u := range fr.Units {
			d := meta.UnitDefs[u.DefID]
			if !d.CanFly {
				continue
			}
			c := u.MaxHealth > 0 && u.Health <= 0
			if c {
				crash++
			}
			air = append(air, struct {
			cx, cz int
			crash  bool
		}{int(float64(u.Pos.X)), int(float64(u.Pos.Z)), c})
		}
		fmt.Printf("frame %d: %d aircraft, %d crashing\n", fr.Frame, len(air), crash)
		for _, cfg := range [][2]float64{{1024, 1}, {512, 2}, {342, 3}, {256, 4}, {768, 1}} {
			reach, r := cfg[0], int(cfg[1])
			for _, barriers := range []bool{false, true} {
				var cps []int
				for trial := 0; trial < 5; trial++ {
					order := rand.New(rand.NewSource(int64(trial))).Perm(len(air))
					// grid of the max level seen so far per cell
					lv := map[[2]int]int{}
					floor := 0 // level every node must exceed (after a barrier)
					maxL := 0
					for _, k := range order {
						a := air[k]
						cx, cz := int(float64(a.cx)/reach), int(float64(a.cz)/reach)
						if barriers && a.crash {
							floor = maxL + 1
							if floor > maxL {
								maxL = floor
							}
							continue
						}
						m := floor
						for dx := -r; dx <= r; dx++ {
							for dz := -r; dz <= r; dz++ {
								if v := lv[[2]int{cx + dx, cz + dz}]; v > m {
									m = v
								}
							}
						}
						l := m + 1
						key := [2]int{cx, cz}
						if l > lv[key] {
							lv[key] = l
						}
						if l > maxL {
							maxL = l
						}
					}
					cps = append(cps, maxL)
				}
				sort.Ints(cps)
				cp := cps[len(cps)/2]
				if barriers {
					for _, inOrder := range []bool{false, true} {
						ms := schedule(air, reach, r, 4, inOrder, 0)
						fmt.Printf("    4 threads, in-order start=%v: makespan %d of %d -> %.2fx\n", inOrder, ms, len(air), float64(len(air))/float64(ms))
					}
				}
				fmt.Printf("  cell %4.0f ±%d barriers=%-5v critical path %5d  -> max parallelism %.1fx\n", reach, r, barriers, cp, float64(len(air))/float64(cp))
			}
		}
	}
}

// schedule: list-schedule unit-time items on nThreads in a random order (seed);
// an item starts when its spatial predecessors (last item in each cell within
// r) and the previous barrier have finished; with inOrder, also not before the
// previous item started. Returns the makespan.
func schedule(air []struct {
	cx, cz int
	crash  bool
}, cell float64, r, nThreads int, inOrder bool, seed int64) int {
	order := rand.New(rand.NewSource(seed)).Perm(len(air))
	lastIn := map[[2]int]int{} // cell -> finish time of the last item there
	threadFree := make([]int, nThreads)
	barrierEnd := 0
	lastStart := 0
	makespan := 0
	maxFinish := 0
	for _, k := range order {
		a := air[k]
		cx, cz := int(float64(a.cx)/cell), int(float64(a.cz)/cell)
		ready := barrierEnd
		if a.crash {
			ready = maxFinish // a barrier waits for everything before it
		} else {
			for dx := -r; dx <= r; dx++ {
				for dz := -r; dz <= r; dz++ {
					if v := lastIn[[2]int{cx + dx, cz + dz}]; v > ready {
						ready = v
					}
				}
			}
		}
		if inOrder && lastStart > ready {
			ready = lastStart
		}
		// earliest free thread
		ti := 0
		for i := range threadFree {
			if threadFree[i] < threadFree[ti] {
				ti = i
			}
		}
		start := ready
		if threadFree[ti] > start {
			start = threadFree[ti]
		}
		finish := start + 1
		threadFree[ti] = finish
		lastStart = start
		if finish > maxFinish {
			maxFinish = finish
		}
		if a.crash {
			barrierEnd = finish
			for i := range threadFree {
				if threadFree[i] < finish {
					threadFree[i] = finish
				}
			}
		} else {
			key := [2]int{cx, cz}
			if finish > lastIn[key] {
				lastIn[key] = finish
			}
		}
		if finish > makespan {
			makespan = finish
		}
	}
	return makespan
}
