package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

// maxReplays is how many finished replays the output folder keeps, the same
// count as the history: every one is uploaded, so the site has them all, and
// at ~8 MB each an unbounded folder only grows.
const maxReplays = maxHistory

// replayName is a file this app wrote: <gameId>.brp. The output folder can be
// any folder the user picked, so nothing else in it is ever touched.
var replayName = regexp.MustCompile(`^[0-9a-f]{32}\.brp$`)

// pruneReplays deletes the oldest replays in dir past the newest keep, and
// returns the names removed.
func pruneReplays(dir string, keep int) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	type replay struct {
		name string
		mod  time.Time
	}
	var all []replay
	for _, e := range entries {
		if e.IsDir() || !replayName.MatchString(e.Name()) {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		all = append(all, replay{e.Name(), fi.ModTime()})
	}
	if len(all) <= keep {
		return nil
	}
	sort.Slice(all, func(i, j int) bool { return all[i].mod.After(all[j].mod) })
	var removed []string
	for _, r := range all[keep:] {
		if os.Remove(filepath.Join(dir, r.name)) == nil {
			removed = append(removed, r.name)
		}
	}
	return removed
}
