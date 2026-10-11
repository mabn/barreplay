// Package gamecat sorts finished BAR games into the categories the win model
// is compared across, from the BAR API's replay detail
// (api.bar-rts.com/replays/<id>): the lava games lavabalance rates, large
// ranked team games, other ranked games, and everything else.
//
// The lava rule is a port of lavabalance's own (mabn/claudebar,
// lavabalance/src/lavaos/lava.ts: isLavaGame + eligibilityReason), because
// "a lava game" there means the Supreme LAVA lobby's tweak stack, not the
// map_waterislava modoption — plenty of lava-map games run without it. Keep
// the two in step when lavabalance changes what it stores.
package gamecat

import (
	"encoding/json"
	"strings"
)

// Category is one bucket of games.
type Category string

const (
	// Lava is a game lavabalance stores: the LAVA lobby's tweaks, 8v8, two
	// teams, no bots, one winner, ended normally, at least six minutes.
	Lava Category = "lava"
	// LargeRanked is a ranked game between two teams of at least
	// LargeTeamPlayers players between them (BAR's "large team", mostly 8v8).
	LargeRanked Category = "large-ranked"
	// Ranked is every other ranked game.
	Ranked Category = "ranked"
	// Unranked is everything else, including a game whose detail does not
	// say whether it was ranked.
	Unranked Category = "unranked"
)

// All lists the categories in report order.
var All = []Category{Lava, LargeRanked, Ranked, Unranked}

// LargeTeamPlayers is the fewest players a two-team ranked game needs to be
// LargeRanked.
const LargeTeamPlayers = 10

// Detail is the part of a BAR API replay detail the categories read.
type Detail struct {
	DurationMs        int64          `json:"durationMs"`
	HasBots           bool           `json:"hasBots"`
	GameEndedNormally bool           `json:"gameEndedNormally"`
	GameSettings      map[string]any `json:"gameSettings"`
	AllyTeams         []struct {
		WinningTeam bool              `json:"winningTeam"`
		Players     []json.RawMessage `json:"Players"`
		AIs         []json.RawMessage `json:"AIs"`
	} `json:"AllyTeams"`
}

// Classify puts one game in its category.
func Classify(d *Detail) Category {
	if IsLavaGame(d) && lavaEligible(d) {
		return Lava
	}
	if s, _ := d.GameSettings["ranked_game"].(string); s != "1" {
		return Unranked
	}
	teams, players := 0, 0
	for _, t := range d.AllyTeams {
		if len(t.Players) > 0 || len(t.AIs) > 0 {
			teams++
		}
		players += len(t.Players)
	}
	if teams == 2 && players >= LargeTeamPlayers {
		return LargeRanked
	}
	return Ranked
}

var (
	coreSignatures  = []string{"lavapack", "lava qol", "lava sky ops"}
	extraSignatures = []string{"onebignuke", "riot titan", "roomba", "tacmissilenerf", "legendary converter"}
)

// IsLavaGame is lavabalance's isLavaGame: the decoded tweakdefs/tweakunits
// carry at least one core LAVA signature and two signatures in all.
func IsLavaGame(d *Detail) bool {
	text := decodedTweaks(d)
	if text == "" {
		return false
	}
	core, extra := 0, 0
	for _, s := range coreSignatures {
		if strings.Contains(text, s) {
			core++
		}
	}
	for _, s := range extraSignatures {
		if strings.Contains(text, s) {
			extra++
		}
	}
	return core >= 1 && core+extra >= 2
}

// lavaEligible is lavabalance's eligibilityReason == null: the games it
// stores, rated or not (the map rule only decides which of them are rated).
func lavaEligible(d *Detail) bool {
	teams := 0
	winners := 0
	for _, t := range d.AllyTeams {
		if len(t.Players) == 0 && len(t.AIs) == 0 {
			continue
		}
		teams++
		if len(t.AIs) > 0 || len(t.Players) != 8 {
			return false
		}
		if t.WinningTeam {
			winners++
		}
	}
	return teams == 2 && !d.HasBots && winners == 1 && d.GameEndedNormally && d.DurationMs >= 6*60_000
}

// decodedTweaks is the lowercased text of every non-empty tweak slot.
func decodedTweaks(d *Detail) string {
	var parts []string
	for k, v := range d.GameSettings {
		if !strings.Contains(k, "tweakdefs") && !strings.Contains(k, "tweakunits") {
			continue
		}
		s, _ := v.(string)
		if s == "" || s == "0" {
			continue
		}
		parts = append(parts, b64ToText(s))
	}
	return strings.ToLower(strings.Join(parts, "\n"))
}

const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// b64ToText is lavabalance's lenient base64 decoder: it skips anything
// outside the alphabet and emits whatever whole bytes accumulate, because
// some API values carry corrupted padding a strict decoder rejects.
func b64ToText(v string) string {
	var out []byte
	buf, bits := 0, 0
	for i := 0; i < len(v); i++ {
		x := strings.IndexByte(b64, v[i])
		if x < 0 {
			continue
		}
		buf = (buf<<6 | x) & 0xffffff
		bits += 6
		if bits >= 8 {
			bits -= 8
			out = append(out, byte(buf>>bits))
		}
	}
	return string(out)
}
