package capture

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

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
		// A live capture records one client's point of view; remember whose.
		// (mode "replay" is the re-sim widget, which sees the whole game and
		// carries no player identity.) An appended segment repeats GAME —
		// keep the first identity.
		if g.Mode == "live" && base.Recorder == nil {
			base.Recorder = &snapshot.RecorderInfo{
				PlayerID:  g.PlayerID,
				AllyTeam:  g.AllyTeam,
				Spectator: g.Spectator,
			}
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

// commRecord is the widget's COMM payload: one thing a player wrote or drew.
// JSON rather than positional fields because chat text and marker labels are
// free-form (spaces, quotes, UTF-8 — the same reason DEF and GAME are JSON).
// PlayerID is a pointer so a record missing it decodes as "unknown" (-1)
// rather than as player 0.
type commRecord struct {
	Frame    int32   `json:"f"`
	Kind     string  `json:"k"`
	PlayerID *int32  `json:"p"`
	Name     string  `json:"n"`
	Dest     string  `json:"d"`
	Text     string  `json:"t"`
	X        float32 `json:"x"`
	Z        float32 `json:"z"`
	X2       float32 `json:"x2"`
	Z2       float32 `json:"z2"`
}

// maxCommText caps a recorded message/label. The text comes from arbitrary
// players and is displayed verbatim in the viewer; the engine itself caps chat
// well below this, so the limit only ever bites on a malformed stream.
const maxCommText = 512

// parseComm decodes one COMM payload into a snapshot.Comm. An unparseable
// record, or one whose kind the model does not define, is dropped with a
// warning — a capture is worth keeping even when one line of it is junk.
func parseComm(payload string) (snapshot.Comm, bool) {
	var r commRecord
	if err := json.Unmarshal([]byte(payload), &r); err != nil {
		fmt.Fprintf(os.Stderr, "capture: bad COMM record %q: %v\n", payload, err)
		return snapshot.Comm{}, false
	}
	kind := snapshot.CommKind(r.Kind)
	switch kind {
	case snapshot.CommChat, snapshot.CommPoint, snapshot.CommLine, snapshot.CommErase:
	default:
		fmt.Fprintf(os.Stderr, "capture: unknown COMM kind %q; dropping\n", r.Kind)
		return snapshot.Comm{}, false
	}
	id := int32(-1)
	if r.PlayerID != nil {
		id = *r.PlayerID
	}
	return snapshot.Comm{
		Frame:    r.Frame,
		Kind:     kind,
		PlayerID: id,
		Name:     sanitizeCommText(r.Name),
		Dest:     r.Dest,
		Text:     sanitizeCommText(r.Text),
		X:        r.X,
		Z:        r.Z,
		X2:       r.X2,
		Z2:       r.Z2,
	}, true
}

// sanitizeCommText makes player-authored text safe to store and display: it
// drops Spring's inline colour codes (a 0xFF byte followed by three RGB bytes,
// and the 0x08 reset), flattens any remaining control characters to spaces,
// replaces invalid UTF-8, and truncates to maxCommText.
//
// Colour codes are stripped by the WIDGETS, before the text ever reaches the
// stream — they have to be, since a raw 0xFF byte cannot survive the JSON hop
// (json.Unmarshal turns invalid UTF-8 into U+FFFD, so this pass would never
// see the marker). What it does catch on the stream path is escaped control
// characters, stray whitespace and length; the colour-code branch keeps the
// function correct for text handed to it directly.
func sanitizeCommText(s string) string {
	if s == "" {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == 0xFF: // colour code: 0xFF <r> <g> <b>
			i += 4
		case c < 0x20 || c == 0x7F:
			b.WriteByte(' ')
			i++
		case c < utf8.RuneSelf:
			b.WriteByte(c)
			i++
		default:
			r, n := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && n <= 1 {
				b.WriteRune(utf8.RuneError)
				i++
			} else {
				b.WriteString(s[i : i+n])
				i += n
			}
		}
	}
	out := strings.TrimSpace(b.String())
	if len(out) > maxCommText {
		// Trim back to a rune boundary so the result stays valid UTF-8.
		out = out[:maxCommText]
		for len(out) > 0 && !utf8.ValidString(out) {
			out = out[:len(out)-1]
		}
	}
	return out
}

// repairIncome fixes the resource-income scale of legacy streams. The engine's
// GetTeamResources income return is already per game-second (accumulated over
// TEAM_SLOWUPDATE_RATE = 30 sim frames = 1 game-second), but every widget
// before stream protocol 3 multiplied it by gameSpeed on the assumption it was
// per sim frame, baking in a 30x-too-high rate. A GAME line with protocol >= 3
// marks a stream whose income is written as the engine reports it; anything
// older (protocol <= 2, or a .brsnap with no GAME line at all) gets the bogus
// factor divided back out.
func repairIncome(v float32, protocol int, gameSpeed int32) float32 {
	if protocol >= 3 || gameSpeed <= 0 {
		return v
	}
	return v / float32(gameSpeed)
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
