// Command barreplay-static packs .brp captures into a directory of plain static
// files for hosting the viewer with no server on the playback path (e.g. a
// Cloudflare R2 bucket served by the worker/ project). See internal/viz/static.go
// for the layout. Typical use: keep a local mirror of the bucket, pack new
// captures into it, then sync the whole directory up to R2.
//
//	barreplay-static -out ./static ./snapshots/*.brp
//	# then: wrangler r2 object put / rclone sync ./static -> the bucket
package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/mabn/barreplay/internal/viz"
)

func main() {
	out := flag.String("out", "./static", "output bundle directory (a mirror of the R2 bucket)")
	flag.Parse()
	if flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: barreplay-static -out <dir> <capture.brp> [more.brp ...]")
		os.Exit(2)
	}
	if err := os.MkdirAll(*out, 0o755); err != nil {
		log.Fatal(err)
	}
	for _, p := range flag.Args() {
		id, err := viz.WriteStaticBundle(p, *out)
		if err != nil {
			log.Fatalf("packing %s: %v", p, err)
		}
		fmt.Printf("packed %s\n", id)
	}
	n, err := viz.WriteIndex(*out)
	if err != nil {
		log.Fatalf("writing index.json: %v", err)
	}
	fmt.Printf("wrote %s/index.json (%d replays)\n", *out, n)
}
