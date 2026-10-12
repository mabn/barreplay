package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/mabn/barreplay/internal/viz"
	"github.com/mabn/barreplay/snapshot"
)

// A replay published as split pieces (before .brp files were kept) is read
// from its head and keyframes only: one keyframe a minute is enough for
// standing metal, and the delta chunks are nine tenths of the bytes. The
// chunks are stood in for by zeros of the right length (a HEAD request) and
// dropped before decoding, so each chunk decodes to its keyframe alone.

const dataOrigin = "https://cdn-bar.fogofwar.dev/"

var chunkKey = regexp.MustCompile(`/c\d+$`)

func pieceFetcher(cache string) viz.PieceFetcher {
	return func(ctx context.Context, key string) ([]byte, error) {
		if strings.HasSuffix(key, ".resources") {
			return nil, viz.ErrNotFound
		}
		if chunkKey.MatchString(key) {
			req, _ := http.NewRequestWithContext(ctx, http.MethodHead, dataOrigin+key, nil)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return nil, err
			}
			resp.Body.Close()
			n, err := strconv.Atoi(resp.Header.Get("content-length"))
			if err != nil || resp.StatusCode != 200 {
				return nil, fmt.Errorf("%s: HEAD %d", key, resp.StatusCode)
			}
			return make([]byte, n), nil
		}
		p := filepath.Join(cache, filepath.FromSlash(key))
		if b, err := os.ReadFile(p); err == nil {
			return b, nil
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, dataOrigin+key, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode == 404 {
			return nil, viz.ErrNotFound
		}
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("%s: %d", key, resp.StatusCode)
		}
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, err
		}
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, b, 0o644)
		return b, nil
	}
}

// legacyFile rebuilds the replay's keyframes-only file, with each def's
// category and cost filled in by name from the table the .brp files gave.
func legacyFile(rid, cache string, cats map[string]string, costs map[string]float64) (*snapshot.BRPFile, error) {
	f, _, err := viz.ReadStaticBundle(context.Background(), pieceFetcher(cache), rid)
	if err != nil {
		return nil, err
	}
	for i := range f.Chunks {
		f.Chunks[i].FLen = 0
		f.Chunks[i].Count = 1
	}
	for k, d := range f.Meta.UnitDefs {
		if c, ok := costs[d.Name]; ok {
			d.MetalCost = float32(c)
			f.Meta.UnitDefs[k] = d
		}
	}
	legacyCats = cats
	return f, nil
}

var legacyCats map[string]string

func loadTables(dir string) (map[string]string, map[string]float64) {
	var cats map[string]string
	var costs map[string]float64
	b, err := os.ReadFile(filepath.Join(dir, "defcat.json"))
	if err != nil {
		panic(err)
	}
	json.Unmarshal(b, &cats)
	b, err = os.ReadFile(filepath.Join(dir, "defcost.json"))
	if err != nil {
		panic(err)
	}
	json.Unmarshal(b, &costs)
	return cats, costs
}

func runLegacy(ridsFile, tables, cache, out string) {
	cats, costs := loadTables(tables)
	legacyCats = cats
	b, err := os.ReadFile(ridsFile)
	if err != nil {
		panic(err)
	}
	os.MkdirAll(out, 0o755)
	rids := strings.Fields(string(b))
	sem := make(chan struct{}, 6)
	done := make(chan struct{})
	for _, rid := range rids {
		go func() {
			sem <- struct{}{}
			defer func() { <-sem; done <- struct{}{} }()
			f, err := legacyFile(rid, cache, cats, costs)
			if err != nil {
				fmt.Fprintln(os.Stderr, rid, err)
				return
			}
			g, _, err := extractFile(f)
			if err != nil {
				fmt.Fprintln(os.Stderr, rid, err)
				return
			}
			b, _ := json.Marshal(g)
			os.WriteFile(filepath.Join(out, g.GameID+".json"), b, 0o644)
		}()
	}
	for range rids {
		<-done
	}
}
