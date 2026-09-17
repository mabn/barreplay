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
// -upload` via PUT /api/replays/<id>, whose body BuildCatalogEntry produces
// from the packed .brp's meta.

// CatalogEntry is one replay's row in GET /api/replays (and the body of
// PUT /api/replays/<id>). Stats are best-effort: a field the capture doesn't
// carry is null, never a guessed zero — the JSON shape (nullable fields,
// camelCase keys) must stay in lockstep with worker/src/worker/replayentry.ts.
type CatalogEntry struct {
	ID string `json:"id"`
	// Rid is the revision the replay's pieces are actually served under
	// (`<gameId>-<rev>`, rev = first 8 hex of the source stream's SHA-256).
	// Revisioned publishes are append-only — a re-upload lands under a fresh
	// rid and the row moves — so the front-end fetches pieces at `rid ?? id`.
	// Set by the publisher, not here: BuildCatalogEntry leaves it nil.
	Rid         *string `json:"rid,omitempty"`
	StartUnix   *int64  `json:"startUnix"`
	DurationSec *int64  `json:"durationSec"`
	Map         *string `json:"map"`
	GameSize    *string `json:"gameSize"`
	SizeBytes   *int64  `json:"sizeBytes"`
	// Settings are the notable game-settings flags derived from the demo
	// startscript's modoptions (SettingsFlags) — only true/non-default entries,
	// so a vanilla game carries just {"ranked": true}. Modoptions are NOT
	// persisted in the .brp, so this is set only by pack's demo-fetch path
	// (uploaded via PUT); BuildCatalogEntry itself omits it.
	Settings map[string]any `json:"settings,omitempty"`
	// Players is the roster the landing list shows AND the list's player
	// filter matches against: one group per ally team (ascending ally id),
	// each holding the ally's players by OpenSkill rating, capped at
	// catalogPlayersPerAlly (Count keeps the full size).
	Players []CatalogTeam `json:"players,omitempty"`
	// UploaderAlly is the ally team whose client recorded the capture behind
	// the current revision (Meta.Recorder) — which side's point of view the
	// replay shows. Nil for engine re-sim captures and spectator recordings,
	// which see the whole game.
	UploaderAlly *int32 `json:"uploaderAlly,omitempty"`
	// View states whose point of view the capture is from when it is known:
	// "full" (a spectator or a re-sim — every team visible), "ally" (one side,
	// named by UploaderAlly), or "unknown". UploaderAlly alone cannot express
	// this, since nil there is ambiguous between "full", "unknown" and a row
	// predating the recorder fields. In the worker it is a HAND-SET marking
	// (POST /api/replays/<id>/view from the viewer's header control) which
	// upserts deliberately preserve; BuildCatalogEntry derives it from the
	// capture's own Meta.Recorder and leaves it empty when there is none.
	View string `json:"view,omitempty"`
	// WidgetVersion/WidgetSha/WidgetDate identify the uploader-widget build
	// that produced the capture behind the current revision (snapshot.Meta's
	// Widget, from the stream's GAME line): which release, which exact bytes
	// (the git SHA stamped into the published copy — absent when a player
	// installed the widget straight from the repo), and when that release was
	// cut. All nil for re-sim captures and for streams predating the fields.
	WidgetVersion *string `json:"widgetVersion,omitempty"`
	WidgetSha     *string `json:"widgetSha,omitempty"`
	WidgetDate    *string `json:"widgetDate,omitempty"`
	// Uploads lists every revision ever published for this game with the side
	// that recorded it, oldest first. Accumulated PUT-by-PUT in the worker's
	// catalog (revisions are append-only, so every entry keeps playing at
	// ?replay=<rid>); server-owned, so BuildCatalogEntry leaves this nil.
	Uploads []CatalogUpload `json:"uploads,omitempty"`
}

// CatalogTeam is one ally team's roster slice in a catalog row.
type CatalogTeam struct {
	Ally    int32           `json:"ally"`
	Count   int             `json:"count"` // total players on the ally team
	Players []CatalogPlayer `json:"players"`
}

// CatalogPlayer is one player in a CatalogTeam, best first.
type CatalogPlayer struct {
	Name string `json:"name"`
	// Skill is the OpenSkill rating ("OS") from the demo startscript;
	// 0 (omitted) when the capture has no startscript behind it.
	Skill float32 `json:"os,omitempty"`
	// Rank is BAR's chevron level 0..7 at the time of THIS game — the lobby
	// server's coarse experience badge, which under BAR's "Role" rank method
	// buckets in-game hours (0: <5h, 1: 5h, 2: 15h, 3: 100h, 4: 250h,
	// 5: 1000h) with 6/7 reserved for contributors and tournament winners.
	// A POINTER because 0 is a real rank (a brand-new account) and so cannot
	// double as "unknown": the .brp meta stores PlayerInfo.Rank as an int32
	// with omitempty, making a recorded 0 and an absent field identical on
	// the way back in, and a capture with no startscript behind it knows no
	// ranks at all. catalogPlayers therefore sets it only for players the
	// startscript named (see startscriptRank).
	Rank *int32 `json:"rank,omitempty"`
}

// CatalogUpload is one published revision of a game: its rid and the ally
// team of the recorder (nil for a spectator or unknown point of view).
type CatalogUpload struct {
	Rid  string `json:"rid"`
	Ally *int32 `json:"ally"`
}

// catalogPlayersPerAlly caps each ally team's roster slice in the catalog. It
// is a FILTER limit, not a display one: the landing list filters by "was this
// player in the game", which can only match names the row stores, so anyone
// trimmed here is unfindable. It was 5 — enough for the three names the list
// prints per side — which left every 8v8 storing 5 of its 8 players a side.
// Its twin is CATALOG_PLAYERS_PER_ALLY in worker/src/worker/replayentry.ts and
// the two must stay in lockstep.
const catalogPlayersPerAlly = 32

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
	e.Players = catalogPlayers(bf.Meta)
	if w := bf.Meta.Widget; w != nil {
		// Each field is sent only when the capture actually carries it: an
		// unstamped widget has no SHA, and a pre-1.7.0 stream has no date.
		// The row keeps whatever a publisher does not state, so sending an
		// empty string would overwrite a known value with a blank one.
		if w.Version != "" {
			v := w.Version
			e.WidgetVersion = &v
		}
		if w.Sha != "" {
			v := w.Sha
			e.WidgetSha = &v
		}
		if w.Date != "" {
			v := w.Date
			e.WidgetDate = &v
		}
	}
	if r := bf.Meta.Recorder; r != nil {
		if r.Spectator {
			// A spectator saw every team; that is a fact about the capture, so
			// state it rather than leaving it to be inferred from a nil ally.
			e.View = "full"
		} else {
			for _, t := range bf.Meta.Teams {
				// Trust the recorded ally only if it exists in the team table.
				if t.AllyTeam == r.AllyTeam {
					v := r.AllyTeam
					e.UploaderAlly = &v
					e.View = "ally"
					break
				}
			}
		}
	}
	return e
}

// catalogPlayers distills the capture's roster into the catalog's players
// column: non-spectator players grouped by ally team (ascending ally id),
// each group sorted best-OS-first and capped at catalogPlayersPerAlly with
// Count keeping the ally's true size. Nil when the capture names no players.
func catalogPlayers(meta snapshot.Meta) []CatalogTeam {
	teamAlly := map[int32]int32{}
	for _, t := range meta.Teams {
		teamAlly[t.TeamID] = t.AllyTeam
	}
	perAlly := map[int32][]CatalogPlayer{}
	for _, p := range meta.Players {
		if p.Spectator || p.Name == "" {
			continue
		}
		ally, ok := teamAlly[p.Team]
		if !ok {
			continue
		}
		perAlly[ally] = append(perAlly[ally], CatalogPlayer{Name: p.Name, Skill: p.Skill, Rank: startscriptRank(p)})
	}
	if len(perAlly) == 0 {
		return nil
	}
	allies := make([]int32, 0, len(perAlly))
	for a := range perAlly {
		allies = append(allies, a)
	}
	sort.Slice(allies, func(i, j int) bool { return allies[i] < allies[j] })
	out := make([]CatalogTeam, 0, len(allies))
	for _, a := range allies {
		ps := perAlly[a]
		sort.SliceStable(ps, func(i, j int) bool { return ps[i].Skill > ps[j].Skill })
		n := len(ps)
		if len(ps) > catalogPlayersPerAlly {
			ps = ps[:catalogPlayersPerAlly]
		}
		out = append(out, CatalogTeam{Ally: a, Count: n, Players: ps})
	}
	return out
}

// startscriptRank returns the player's chevron rank when the roster behind it
// came from the demo startscript, and nil when it did not. The distinction
// cannot be read off Rank alone: rank 0 is a genuine level (an account with
// under five hours) and snapshot.PlayerInfo.Rank is a plain int32 that the
// meta JSON omits when zero, so a startscript-less capture — the widget's own
// P-line fallback, which carries name/team/spectator and nothing else —
// decodes to exactly the same 0. Any of the three startscript-only fields
// being set proves the player was seeded from one, and a 0 there is then the
// real rank rather than a missing one.
func startscriptRank(p snapshot.PlayerInfo) *int32 {
	if p.Rank == 0 && p.Skill == 0 && p.AccountID == "" {
		return nil
	}
	r := p.Rank
	return &r
}

// SettingsFlags distills a demo startscript's raw [modoptions] map into the
// catalog's settings object. Only true / non-default values are emitted so the
// common case stays tiny ({"ranked": true} for a vanilla ranked game) and the
// UI renders a badge per present key. tweakdefs*/tweakunits* values are
// base64-encoded Lua blobs — only their presence is recorded (`mods`), never
// the content. Returns nil when nothing notable is set (or mo is nil), which
// json-omits the field entirely. The worker's admin settings-refresh route
// runs the TypeScript twin of this function (settingsFlags in
// worker/src/worker/replayentry.ts) over the BAR API's gameSettings — the two
// MUST stay in lockstep.
func SettingsFlags(mo map[string]string) map[string]any {
	if len(mo) == 0 {
		return nil
	}
	out := map[string]any{}
	on := func(key, name string) {
		if mo[key] == "1" {
			out[name] = true
		}
	}
	on("ranked_game", "ranked")
	// The one "off is the news" flag: an explicitly unranked lobby gets its
	// own badge (absent key = unknown, e.g. no demo behind the capture).
	if mo["ranked_game"] == "0" {
		out["unranked"] = true
	}
	on("map_waterislava", "lava")
	on("scavunitsforplayers", "scavUnits")
	on("experimentalextraunits", "extraUnits")
	on("unit_restrictions_nonukes", "noNukes")
	on("unit_restrictions_noendgamelrpc", "noEndgameLrpc")
	on("unit_restrictions_nolrpc", "noLrpc")
	on("unit_restrictions_noair", "noAir")

	// Any tweak slot set at all means the game ran modded unit/def tables.
	for _, base := range []string{"tweakdefs", "tweakunits"} {
		for i := 0; i <= 9 && out["mods"] == nil; i++ {
			key := base
			if i > 0 {
				key += fmt.Sprint(i)
			}
			if mo[key] != "" {
				out["mods"] = true
			}
		}
	}

	// Enum-valued options: notable unless off/default.
	if v := mo["quick_start"]; v != "" && v != "default" && v != "disabled" {
		out["quickStart"] = v
	}
	if v := mo["commanderbuildersenabled"]; v != "" && v != "disabled" {
		out["comBuilders"] = v
	}
	// zombies defaults to "disabled"; "normal" is the plain on-state (badge
	// alone), the harder tiers (hard/nightmare/akumu) keep their name.
	if v := mo["zombies"]; v != "" && v != "disabled" {
		if v == "normal" {
			out["zombies"] = true
		} else {
			out["zombies"] = v
		}
	}
	// ruins defaults to "scav_only" (present only in Scavengers games, which
	// this catalog can't detect), so only an explicit "enabled" is notable.
	if v := mo["ruins"]; v == "enabled" {
		out["ruins"] = true
	}

	if len(out) == 0 {
		return nil
	}
	return out
}

// GameSizeSpec renders a team roster as BAR's usual size spec: team counts
// per ally team, largest first, joined with "v" — "8v8", "1v1", "2v2v2".
// Every TeamInfo is one playing slot (spectators are players, not teams).
//
// The engine always appends a neutral Gaia team (critters, map wildlife) to
// the team list, alone in its own ally team — it is not a playing slot and
// must not surface as a phantom extra "v1". There is no explicit marker in
// the capture, but Gaia is the only team with no side and no controlling
// player, so an ally team consisting solely of such teams is dropped.
func GameSizeSpec(teams []snapshot.TeamInfo) string {
	perAlly := map[int32]int{}
	neutral := map[int32]int{}
	for _, t := range teams {
		perAlly[t.AllyTeam]++
		if t.Side == "" && t.PlayerName == "" {
			neutral[t.AllyTeam]++
		}
	}
	for ally, n := range neutral {
		if n == perAlly[ally] {
			delete(perAlly, ally)
		}
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
