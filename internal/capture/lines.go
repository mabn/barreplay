package capture

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/mabn/barreplay/snapshot"
)

// gameLine is the widget's "BRSNAP GAME <json>" preamble record: capture
// context a live game knows about itself (the resim pipeline gets the same
// facts from the demo file instead). Fields the seed metadata already carries
// win; GAME only fills blanks.
type gameLine struct {
	Protocol      int    `json:"protocol"`
	WidgetVersion string `json:"widgetVersion"`
	Mode          string `json:"mode"`
	Map           string `json:"map"`
	GameVersion   string `json:"gameVersion"`
	EngineVersion string `json:"engineVersion"`
	SampleEvery   int32  `json:"sampleEvery"`
	GameSpeed     int32  `json:"gameSpeed"`
	RecordEnemies bool   `json:"recordEnemies"`
	PlayerID      int32  `json:"playerID"`
	AllyTeam      int32  `json:"allyTeam"`
	Spectator     bool   `json:"spectator"`
}

// applyPreambleLine handles the preamble record types shared by the text
// (.brsnap) and binary (.brepstream) streams: GID, GAME, D, DEF, T and P.
// fields is the whitespace-split content after the BRSNAP tag; content is the
// unsplit form (JSON payloads may contain spaces). Returns the parsed GAME
// line when this record was one (nil otherwise) and whether the record type
// was recognized here.
func applyPreambleLine(fields []string, content string, base *snapshot.Meta) (*gameLine, bool) {
	switch fields[0] {
	case "GID": // GID <32-hex gameId>
		if len(fields) >= 2 && base.GameID == "" {
			base.GameID = fields[1]
		}
	case "GAME": // GAME <json>
		var g gameLine
		payload := strings.TrimSpace(content[len(fields[0]):])
		if err := json.Unmarshal([]byte(payload), &g); err != nil {
			fmt.Fprintf(os.Stderr, "capture: bad GAME record %q: %v\n", payload, err)
			return nil, true
		}
		if base.MapName == "" {
			base.MapName = g.Map
		}
		if base.GameVersion == "" {
			base.GameVersion = g.GameVersion
		}
		if base.EngineVersion == "" {
			base.EngineVersion = g.EngineVersion
		}
		if base.SampleEvery == 0 {
			base.SampleEvery = g.SampleEvery
		}
		return &g, true
	case "D": // D <defID> <name> (legacy: id->name only)
		if len(fields) >= 3 {
			id := atoi32(fields[1])
			def := base.UnitDefs[id]
			def.DefID, def.Name = id, fields[2]
			base.UnitDefs[id] = def
		}
	case "DEF": // DEF <json> (full unit def; humanName may contain spaces, so JSON)
		var def snapshot.UnitDef
		payload := strings.TrimSpace(content[len(fields[0]):])
		if err := json.Unmarshal([]byte(payload), &def); err != nil {
			fmt.Fprintf(os.Stderr, "capture: bad DEF record %q: %v\n", payload, err)
		} else {
			base.UnitDefs[def.DefID] = def
		}
	case "P": // P <playerID> <team> <spectator> <name...> (name last, may contain spaces)
		if len(fields) >= 5 {
			id := atoi32(fields[1])
			// The startscript-seeded roster (base.Players) is richer than the
			// widget's live P line (it carries flag/rank/OpenSkill), so only add
			// a player the seed didn't already provide — e.g. when re-parsing a
			// raw stream with no startscript behind it.
			seen := false
			for _, p := range base.Players {
				if p.PlayerID == id {
					seen = true
					break
				}
			}
			if !seen {
				base.Players = append(base.Players, snapshot.PlayerInfo{
					PlayerID:  id,
					Team:      atoi32(fields[2]),
					Spectator: fields[3] == "1",
					Name:      strings.Join(fields[4:], " "),
				})
			}
		}
	case "T": // T <teamID> <allyTeam> <side> <color> (side "_" = none; color optional)
		if len(fields) >= 3 {
			ti := snapshot.TeamInfo{TeamID: atoi32(fields[1]), AllyTeam: atoi32(fields[2])}
			if len(fields) >= 4 && fields[3] != "_" {
				ti.Side = fields[3]
			}
			if len(fields) >= 5 && fields[4] != "-" {
				ti.Color = fields[4]
			}
			// An appended stream segment (widget re-enabled mid-game) repeats
			// the team table; keep the first entry per team id.
			for _, have := range base.Teams {
				if have.TeamID == ti.TeamID {
					return nil, true
				}
			}
			base.Teams = append(base.Teams, ti)
		}
	default:
		return nil, false
	}
	return nil, true
}

// graveyard remembers the unit ids a stream reported destroyed, so a capture
// can be decoded into a world without dead units standing in it even when the
// recorder kept sampling them. Both stream parsers consult it.
//
// This is a repair pass for captures already in the wild: the uploader widget
// before 1.2.0 could mistake the engine's still-undeleted killed unit for a
// new unit reusing the id, un-tombstone it, and freeze it into every later
// frame as a 0 hp ghost (a real 8v8 capture ended with 57 of them, one
// standing 6 minutes past its own recorded death). Widget >= 1.2.0 never
// emits those records, and then this pass finds nothing to drop.
type graveyard map[int32]struct{}

// note applies a lifecycle event: a death buries the id, a creation frees it
// (the engine recycles unit ids, so the same id can legitimately come back).
func (g graveyard) note(kind snapshot.EventKind, id int32) {
	switch kind {
	case snapshot.EventDestroyed:
		g[id] = struct{}{}
	case snapshot.EventCreated:
		delete(g, id)
	}
}

// drop reports whether a sampled unit record belongs to a unit the stream
// already buried. A record restated with POSITIVE health is the one proof of
// a new unit reusing the id — the same test the widget itself applies — and
// frees the grave; a carried-forward or 0 hp record is the dead one.
func (g graveyard) drop(id int32, health float64, restated bool) bool {
	if _, dead := g[id]; !dead {
		return false
	}
	if restated && health > 0 {
		delete(g, id)
		return false
	}
	return true
}

// staleGhostTTLSecs is how long a stale enemy ghost survives in DECODED
// output. The uploader widget records enemies as the player perceived them: a
// unit that leaves visibility stays in the stream frozen at its last-known
// state, forever ("the capture shows what this player knew"). For buildings
// that matches BAR's own ghost-building convention, but a MOBILE unit frozen
// mid-field for minutes is almost always a unit that died unseen — the game
// itself shows no such ghost — and a long game accumulates hundreds of them
// (the reported 8v8 ended with ~120 stale mobile ghosts and unidentified
// blips standing). So decoding applies a policy the stream itself does not
// carry: an enemy unit whose sampled state has not changed at all for this
// long is hidden until something about it changes again. The raw stream keeps
// full fidelity (nothing is lost for the future multi-stream merge; re-pack
// to re-apply a different policy).
const staleGhostTTLSecs = 60

// ghostSig is the part of a unit's sampled state whose complete stillness
// marks a stale ghost. Values are quantized by both stream formats, so exact
// float comparison is sound.
type ghostSig struct {
	def, team              int32
	x, z, hp, maxHp, build float32
}

// ghostExpiry hides stale enemy ghosts from decoded frames (see
// staleGhostTTLSecs). Liveness is "anything changed": real movement, radar
// wobble (the engine wobbles only a live radar return, so jitter IS
// confirmation), damage, identification. Building defs are exempt — their
// ghosts legitimately persist — as is everything on the recording player's
// ally team (fully visible; a parked own unit is not a ghost). A nil
// *ghostExpiry filters nothing: the policy only applies to live-game enemy
// captures (GAME line with recordEnemies and not spectating) — a resim or
// full-view capture has no ghosts to expire.
type ghostExpiry struct {
	ttlFrames int32
	myAlly    int32
	allyOf    map[int32]int32
	exempt    map[int32]bool // building unit defs (ghosts persist)
	streaks   map[int32]*ghostStreak
}

// ghostStreak tracks one unit's current run of identical samples.
type ghostStreak struct {
	sig   ghostSig
	since int32 // frame the run started
}

func newGhostExpiry(base *snapshot.Meta, g *gameLine) *ghostExpiry {
	if g == nil || !g.RecordEnemies || g.Spectator {
		return nil
	}
	gs := g.GameSpeed
	if gs <= 0 {
		gs = 30
	}
	e := &ghostExpiry{
		ttlFrames: staleGhostTTLSecs * gs,
		myAlly:    g.AllyTeam,
		allyOf:    make(map[int32]int32, len(base.Teams)),
		exempt:    map[int32]bool{},
		streaks:   map[int32]*ghostStreak{},
	}
	for _, t := range base.Teams {
		e.allyOf[t.TeamID] = t.AllyTeam
	}
	// Same structure-vs-mobile rule as the viewer's footprint map: neither
	// flag alone is enough (nano turrets are immobile builders, some
	// factories report CanMove).
	for id, d := range base.UnitDefs {
		if !d.CanMove || d.IsBuilding {
			e.exempt[id] = true
		}
	}
	return e
}

// filter drops the stale ghosts from one decoded frame, in place.
func (e *ghostExpiry) filter(fr *snapshot.Frame) {
	if e == nil {
		return
	}
	kept := fr.Units[:0]
	for _, u := range fr.Units {
		if !e.stale(fr.Frame, u) {
			kept = append(kept, u)
		}
	}
	fr.Units = kept
}

func (e *ghostExpiry) stale(frame int32, u snapshot.UnitState) bool {
	if ally, ok := e.allyOf[u.Team]; ok && ally == e.myAlly {
		return false // own ally team: fully visible, never a ghost
	}
	if e.exempt[u.DefID] {
		return false // building ghosts persist (an unknown def 0 does not)
	}
	if u.VelX != 0 || u.VelZ != 0 {
		delete(e.streaks, u.UnitID) // moving: alive by definition
		return false
	}
	sig := ghostSig{u.DefID, u.Team, u.Pos.X, u.Pos.Z, u.Health, u.MaxHealth, u.BuildProgress}
	st := e.streaks[u.UnitID]
	if st == nil || st.sig != sig {
		e.streaks[u.UnitID] = &ghostStreak{sig: sig, since: frame}
		return false
	}
	return frame-st.since > e.ttlFrames
}

// backfillTeamPlayers fills each team's display player from the roster (first
// non-spectator player controlling the team) so consumers that key on TeamInfo
// alone still get a name.
func backfillTeamPlayers(base *snapshot.Meta) {
	for i := range base.Teams {
		if base.Teams[i].PlayerName != "" {
			continue
		}
		for _, p := range base.Players {
			if !p.Spectator && p.Team == base.Teams[i].TeamID {
				base.Teams[i].PlayerName = p.Name
				break
			}
		}
	}
}
