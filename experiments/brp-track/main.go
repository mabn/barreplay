// brp-track: print one unit's track as decoded from a packed .brp file.
package main

import (
	"fmt"
	"math"
	"os"
	"strconv"

	"github.com/mabn/barreplay/snapshot"
)

func main() {
	id64, _ := strconv.Atoi(os.Args[2])
	lo, _ := strconv.Atoi(os.Args[3])
	hi, _ := strconv.Atoi(os.Args[4])
	id := int32(id64)
	f, _ := os.Open(os.Args[1])
	defer f.Close()
	_, frames, _, err := snapshot.ReadBRP(f)
	if err != nil {
		panic(err)
	}
	var px, pz float32
	have := false
	for i := lo; i <= hi && i < len(frames); i++ {
		for _, u := range frames[i].Units {
			if u.UnitID != id {
				continue
			}
			step := 0.0
			if have {
				dx, dz := float64(u.Pos.X-px), float64(u.Pos.Z-pz)
				step = math.Sqrt(dx*dx + dz*dz)
			}
			px, pz, have = u.Pos.X, u.Pos.Z, true
			fmt.Printf("sample %3d  sim frame %4d  pos (%7.1f,%7.1f)  dv (%5.1f,%6.1f)  step %5.0f  build %.2f\n",
				i, frames[i].Frame, u.Pos.X, u.Pos.Z, u.VelX*30, u.VelZ*30, step, u.BuildProgress)
		}
	}
}
