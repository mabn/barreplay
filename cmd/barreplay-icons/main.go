// Command barreplay-icons prints the unit-icon table as JSON (name -> {p,s}) to
// stdout. The worker's browser-side viewer reads a .brp directly and resolves
// unit icons itself, so it needs this table as a static asset. Regenerate with:
//
//	go run ./cmd/barreplay-icons > worker/public/icontypes.json
package main

import (
	"fmt"
	"os"

	"github.com/mabn/barreplay/internal/viz"
)

func main() {
	b, err := viz.IconTableJSON()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Stdout.Write(b)
	os.Stdout.Write([]byte{'\n'})
}
