// unitmix: the unit population of a .brp at one frame — how many units, how
// many fly / move / stand, and the commonest defs of each — to size where a
// late game's per-unit engine work goes (docs/worklog-engine-speed.md).
//
//	go run ./experiments/unitmix <file.brp> <frame>
package main

import (
	"fmt"
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
	meta, frames, _, err := snapshot.ReadBRP(f)
	if err != nil {
		panic(err)
	}
	var fr *snapshot.Frame
	for i := range frames {
		if int(frames[i].Frame) >= want {
			fr = &frames[i]
			break
		}
	}
	if fr == nil {
		panic("no such frame")
	}
	kind := func(d snapshot.UnitDef) string {
		switch {
		case d.CanFly:
			return "air"
		case d.CanMove && !d.IsBuilding:
			return "ground/sea mobile"
		default:
			return "structure"
		}
	}
	n := map[string]int{}
	byDef := map[string]map[string]int{}
	moving := map[string]int{}
	for _, u := range fr.Units {
		d := meta.UnitDefs[u.DefID]
		k := kind(d)
		n[k]++
		if byDef[k] == nil {
			byDef[k] = map[string]int{}
		}
		byDef[k][d.Name]++
		if u.VelX != 0 || u.VelZ != 0 {
			moving[k]++
		}
	}
	fmt.Printf("frame %d: %d units\n", fr.Frame, len(fr.Units))
	for _, k := range []string{"air", "ground/sea mobile", "structure"} {
		fmt.Printf("%-18s %5d  (moving %d)\n", k, n[k], moving[k])
		type kv struct {
			k string
			v int
		}
		var l []kv
		for d, c := range byDef[k] {
			l = append(l, kv{d, c})
		}
		sort.Slice(l, func(i, j int) bool { return l[i].v > l[j].v })
		for i := 0; i < len(l) && i < 6; i++ {
			fmt.Printf("    %5d %s\n", l[i].v, l[i].k)
		}
	}
}
