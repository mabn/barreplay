// Command barreplay-viz serves an interactive browser playback of recorded
// barreplay snapshots. It reads the .brp files a capture run wrote (convert
// raw .brsnap/.brepstream streams once with pack) and renders unit
// positions, teams, and health over time on a top-down map with a timeline
// scrubber. Frame data streams to the browser chunk by chunk, so playback
// starts immediately and seeking anywhere is cheap.
//
// Usage:
//
//	barreplay-viz [flags]
//	barreplay-viz -snapshots ./snapshots -addr :8080
//
// It is a read-only tool: it never launches the engine and only reads finished
// snapshot files from the snapshots directory.
package main

import (
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"

	"github.com/mabn/barreplay/internal/viz"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "barreplay-viz: "+err.Error())
		os.Exit(1)
	}
}

func run() error {
	var (
		dir  = flag.String("snapshots", "./snapshots", "directory of .brp snapshot files to browse")
		addr = flag.String("addr", "127.0.0.1:8080", "address to listen on")
	)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: barreplay-viz [flags]\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	if fi, err := os.Stat(*dir); err != nil || !fi.IsDir() {
		return fmt.Errorf("snapshots directory %q not found (pass -snapshots)", *dir)
	}

	srv := &viz.Server{Dir: *dir}

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	fmt.Printf("barreplay-viz: serving %s at http://%s\n", *dir, ln.Addr())
	return http.Serve(ln, srv.Handler())
}
