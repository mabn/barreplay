package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/mabn/barreplay/internal/insights"
	"github.com/mabn/barreplay/snapshot"
)

var insOut, oldIns string

// summarize computes a replay's summary with the current insights code,
// straight from its .brp: full costs, which the published summaries of
// replays rebuilt from old pieces lack (they price armed mobile units
// only). Self-destruct orders are not fetched from the demo.
func summarize(path string) error {
	base := strings.TrimSuffix(filepath.Base(path), ".brp")
	out := filepath.Join(insOut, base+".json")
	if _, err := os.Stat(out); err == nil {
		return nil
	}
	fh, err := os.Open(path)
	if err != nil {
		return err
	}
	defer fh.Close()
	f, err := snapshot.ParseBRP(bufio.NewReader(fh))
	if err != nil {
		return err
	}
	in, err := insights.FromBRP(f)
	if err != nil {
		return err
	}
	if len(in.Meta.Winners) == 0 && oldIns != "" {
		var old struct {
			Winner int `json:"winner"`
			Sides  []struct {
				Ally int32 `json:"ally"`
			} `json:"sides"`
		}
		if b, err := os.ReadFile(filepath.Join(oldIns, base+".json")); err == nil && json.Unmarshal(b, &old) == nil {
			if old.Winner >= 0 && old.Winner < len(old.Sides) {
				in.Meta.Winners = []int32{old.Sides[old.Winner].Ally}
			}
		}
	}
	ins, err := insights.Compute(in)
	if err != nil {
		return err
	}
	b, err := json.Marshal(ins)
	if err != nil {
		return err
	}
	return os.WriteFile(out, b, 0o644)
}
