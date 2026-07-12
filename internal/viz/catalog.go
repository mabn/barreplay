package viz

import (
	"fmt"
	"sort"
	"strings"

	"github.com/mabn/barreplay/snapshot"
)

// The replay catalog: the per-replay stats the picker/landing list shows
// (when the game started, how long it ran, which map, the team-size spec).
// In the Cloudflare deployment these rows live in the worker's SQLite-backed
// Durable Object (worker/src/worker/replayindex.ts), upserted by `pack
// -upload` via PUT /api/replays/<id>; the Go viz server computes the same
// shape live from its .brp files, so GET /api/replays answers identically
// against either backend and the shared front-end needs no URL swapping.

// CatalogEntry is one replay's row in GET /api/replays (and the body of
// PUT /api/replays/<id>). Stats are best-effort: a field the capture doesn't
// carry is null, never a guessed zero — the JSON shape (nullable fields,
// camelCase keys) must stay in lockstep with worker/src/worker/replayentry.ts.
type CatalogEntry struct {
	ID          string  `json:"id"`
	StartUnix   *int64  `json:"startUnix"`
	DurationSec *int64  `json:"durationSec"`
	Map         *string `json:"map"`
	GameSize    *string `json:"gameSize"`
	SizeBytes   *int64  `json:"sizeBytes"`
}

// BuildCatalogEntry derives one replay's catalog row from its parsed .brp.
// sizeBytes is supplied by the caller because it depends on the hosting shape
// (the .brp file locally, the static bundle's download footprint on R2).
func BuildCatalogEntry(id string, bf *snapshot.BRPFile, sizeBytes int64) CatalogEntry {
	e := CatalogEntry{ID: id, SizeBytes: &sizeBytes}
	if bf.Meta.StartUnix > 0 {
		v := bf.Meta.StartUnix
		e.StartUnix = &v
	}
	if bf.Meta.MapName != "" {
		v := bf.Meta.MapName
		e.Map = &v
	}
	if v := GameSizeSpec(bf.Meta.Teams); v != "" {
		e.GameSize = &v
	}
	if v, ok := captureDurationSec(bf); ok {
		e.DurationSec = &v
	}
	return e
}

// GameSizeSpec renders a team roster as BAR's usual size spec: team counts
// per ally team, largest first, joined with "v" — "8v8", "1v1", "2v2v2".
// Every TeamInfo is one playing slot (spectators are players, not teams).
func GameSizeSpec(teams []snapshot.TeamInfo) string {
	perAlly := map[int32]int{}
	for _, t := range teams {
		perAlly[t.AllyTeam]++
	}
	if len(perAlly) == 0 {
		return ""
	}
	counts := make([]int, 0, len(perAlly))
	for _, n := range perAlly {
		counts = append(counts, n)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(counts)))
	parts := make([]string, len(counts))
	for i, n := range counts {
		parts[i] = fmt.Sprint(n)
	}
	return strings.Join(parts, "v")
}

// captureDurationSec is the game length implied by the sampled range: the
// last sampled sim frame at the engine's 30 frames/game-second. Derived from
// the chunk index alone (no frame decode).
func captureDurationSec(bf *snapshot.BRPFile) (int64, bool) {
	if len(bf.Chunks) == 0 {
		return 0, false
	}
	last := bf.Chunks[len(bf.Chunks)-1]
	lastFrame := int64(last.Frame) + int64(last.Count-1)*int64(bf.Meta.SampleEvery)
	if lastFrame <= 0 {
		return 0, false
	}
	return lastFrame / 30, true
}
