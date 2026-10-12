package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/mabn/barreplay/internal/gamecat"
)

// The three groups the map question splits games into, disjoint: a lava
// game (lavabalance's own definition) is "lava" whether or not it was
// ranked, and the two ranked groups are 8v8s that are not lava games.
const (
	groupLava     = "lava"
	groupIsthmus  = "isthmus-ranked"
	groupOtherMap = "other-ranked"
	groupRest     = "rest"
)

var isthmusRE = regexp.MustCompile(`(?i)supreme[ _]isthmus`)

// runGroups sorts the games behind a directory of insights files into the
// groups and writes "<gameId>\t<group>\t<gamecat>\t<map>" lines to out,
// fetching each game's api.bar-rts.com detail into detailDir (the same
// layout cmd/winfit -categories caches, so the two share it).
func runGroups(insDir, detailDir, out string) {
	paths, _ := filepath.Glob(filepath.Join(insDir, "*.json"))
	type row struct{ id, group, cat, mapName string }
	rows := make([]row, len(paths))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	client := &http.Client{Timeout: 30 * time.Second}
	for i, p := range paths {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			var ins struct {
				GameID  string `json:"gameId"`
				MapName string `json:"mapName"`
			}
			b, err := os.ReadFile(p)
			if err != nil || json.Unmarshal(b, &ins) != nil || ins.GameID == "" {
				fmt.Fprintln(os.Stderr, p, "unreadable")
				return
			}
			d, err := detail(client, detailDir, ins.GameID)
			if err != nil {
				fmt.Fprintln(os.Stderr, ins.GameID, err)
				rows[i] = row{ins.GameID, "unknown", "unknown", ins.MapName}
				return
			}
			c := gamecat.Classify(d)
			rows[i] = row{ins.GameID, group(d, c, ins.MapName), string(c), ins.MapName}
		}()
	}
	wg.Wait()
	var sb strings.Builder
	n := map[string]int{}
	for _, r := range rows {
		if r.id == "" {
			continue
		}
		n[r.group]++
		fmt.Fprintf(&sb, "%s\t%s\t%s\t%s\n", r.id, r.group, r.cat, r.mapName)
	}
	if err := os.WriteFile(out, []byte(sb.String()), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(n)
}

func group(d *gamecat.Detail, c gamecat.Category, mapName string) string {
	if c == gamecat.Lava {
		return groupLava
	}
	if s, _ := d.GameSettings["ranked_game"].(string); s != "1" {
		return groupRest
	}
	var sizes []int
	for _, t := range d.AllyTeams {
		if len(t.Players) > 0 || len(t.AIs) > 0 {
			sizes = append(sizes, len(t.Players)+len(t.AIs))
		}
	}
	if len(sizes) != 2 || sizes[0] != 8 || sizes[1] != 8 {
		return groupRest
	}
	if isthmusRE.MatchString(mapName) {
		return groupIsthmus
	}
	return groupOtherMap
}

func detail(client *http.Client, dir, id string) (*gamecat.Detail, error) {
	p := filepath.Join(dir, id+".json")
	b, err := os.ReadFile(p)
	if err != nil {
		resp, err := client.Get("https://api.bar-rts.com/replays/" + id)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("GET replays/%s: %s", id, resp.Status)
		}
		if b, err = io.ReadAll(resp.Body); err != nil {
			return nil, err
		}
		if os.MkdirAll(dir, 0o755) == nil && os.WriteFile(p+".tmp", b, 0o644) == nil {
			os.Rename(p+".tmp", p)
		}
	}
	var d gamecat.Detail
	if err := json.Unmarshal(b, &d); err != nil {
		return nil, err
	}
	if len(d.AllyTeams) == 0 {
		return nil, fmt.Errorf("detail has no teams")
	}
	return &d, nil
}
