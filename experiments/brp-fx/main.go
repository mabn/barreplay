// brp-fx summarizes a .brp's projectile tracks (R) and blasts (W): tracks by
// class and how they ended, beams recorded without a projectile id, blasts by
// kind. Written to compare re-sims of one game recorded through different
// explosion sources (the Explosion callin, BAR's VisibleExplosionBatch, the
// patched engine's event log):
//
//	go run ./experiments/brp-fx a.brp [b.brp ...]
package main

import (
	"fmt"
	"os"
	"sort"

	"github.com/mabn/barreplay/snapshot"
)

var classNames = map[uint8]string{1: "nuke", 2: "antinuke", 3: "emp", 4: "tactical", 5: "juno",
	6: "artillery", 7: "rocket", 8: "beam", 9: "aa"}

var endNames = map[uint8]string{0: "open", 1: "exploded", 2: "vanished"}

func main() {
	for _, path := range os.Args[1:] {
		if err := run(path); err != nil {
			fmt.Fprintln(os.Stderr, "brp-fx:", err)
			os.Exit(1)
		}
	}
}

func run(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := snapshot.ParseBRP(f)
	if err != nil {
		return err
	}
	ps, err := b.Projectiles()
	if err != nil {
		return err
	}
	bs, err := b.Blasts()
	if err != nil {
		return err
	}
	fmt.Printf("== %s: %d tracks, %d blasts\n", path, len(ps), len(bs))
	type key struct{ cls, end uint8 }
	counts := map[key]int{}
	noID := 0
	for _, p := range ps {
		counts[key{p.Class, p.EndKind}]++
		if p.ID < 0 {
			noID++
		}
	}
	keys := make([]key, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].cls != keys[j].cls {
			return keys[i].cls < keys[j].cls
		}
		return keys[i].end < keys[j].end
	})
	for _, k := range keys {
		fmt.Printf("  %-10s %-9s %6d\n", classNames[k.cls], endNames[k.end], counts[k])
	}
	fmt.Printf("  tracks without a projectile id: %d\n", noID)
	kinds := map[uint8]int{}
	for _, x := range bs {
		kinds[x.Kind]++
	}
	fmt.Printf("  blasts: %d unit explosions, %d trackless projectiles\n", kinds[1], kinds[2])
	return nil
}
