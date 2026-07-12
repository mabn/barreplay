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
