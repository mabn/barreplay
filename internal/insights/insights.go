// Package insights reduces a replay to the facts its game summary shows: how
// each side's army and economy moved, where things died, who reached which
// tech first, what was said. It is computed once per published revision and
// stored beside it as replays/<rid>.insights<Version>.json, so the summary
// page loads a few dozen kilobytes instead of the whole replay.
//
// Everything here reads data every published replay already has; nothing
// needs a new capture. Where a replay carries less (unit costs for armed
// mobile units only, no build progress in a v4 bundle, one side's view of
// the game) the output says so rather than guessing.
package insights

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"

	"github.com/mabn/barreplay/snapshot"
)

// Version names the file: replays/<rid>.insights<Version>.json. Pieces are
// immutable, so any change to what is computed or how is a new version,
// written beside the old one; the viewer asks for the one it understands.
const Version = 4

// FileName is the published piece's name for a revision id.
func FileName(rid string) string { return fmt.Sprintf("%s.insights%d.json", rid, Version) }

// StepSec is the spacing of every time series.
const StepSec = 15

const simFPS = 30

// maxChat caps the chat lines carried, so one spammer cannot balloon the file.
const maxChat = 3000

// maxChatText caps one line's length.
const maxChatText = 300

// Insights is the summary file.
type Insights struct {
	Version      int     `json:"version"`
	GameID       string  `json:"gameId"`
	MapName      string  `json:"mapName,omitempty"`
	DurationSec  float64 `json:"durationSec"`
	StepSec      int     `json:"stepSec"`
	CostCoverage string  `json:"costCoverage"`
	POV          string  `json:"pov"`
	// Bounds is the world extent the map views fit, in elmos.
	Bounds Bounds `json:"bounds"`
	// Sides are the ally teams with at least one player, in ally order.
	// Comparative sections need exactly two.
	Sides []Side `json:"sides"`
	Teams []Team `json:"teams"`
	// Defs describes every unit def the file refers to.
	Defs       map[int32]Def `json:"defs"`
	Series     Series        `json:"series"`
	Deaths     Deaths        `json:"deaths"`
	Milestones []Milestone   `json:"milestones"`
	// Battles are the most intense fights, in time order.
	Battles []Battle `json:"battles"`
	// Eliminated is every team that was knocked out of the game, in time
	// order. A team's deaths from that frame on are its units going down
	// with it, not fighting, so no battle or award counts them.
	Eliminated []Elimination `json:"eliminated"`
	Awards     []Award       `json:"awards"`
	// Winner is the index into Sides of the side that won, -1 when the
	// replay does not say (Meta.Winners, from the demo or the BAR API).
	Winner int `json:"winner"`
	// Swing is the win-probability line, for two-sided full-view games.
	Swing *Swing `json:"swing,omitempty"`
	// Players is the per-player report, one per team a player controlled.
	Players []Player   `json:"players"`
	Chat    []ChatLine `json:"chat"`
	// Marks counts map points per side per step (the pings).
	Marks [][]int `json:"marks"`
}

type Bounds struct {
	MinX float64 `json:"minX"`
	MaxX float64 `json:"maxX"`
	MinZ float64 `json:"minZ"`
	MaxZ float64 `json:"maxZ"`
}

type Side struct {
	Ally    int32    `json:"ally"`
	Teams   []int32  `json:"teams"`
	Players []string `json:"players"`
	Color   string   `json:"color,omitempty"`
}

type Team struct {
	Team   int32  `json:"team"`
	Side   int    `json:"side"` // index into Sides, -1 for teams no player controls (Gaia, scavengers)
	Player string `json:"player,omitempty"`
	Color  string `json:"color,omitempty"`
}

type Def struct {
	Name  string  `json:"name"`
	Human string  `json:"human,omitempty"`
	Cost  float64 `json:"cost,omitempty"` // metal; absent when the replay does not record it
	// Icon is the def's icontypes key (the viewer's /icons/icontypes.json),
	// when the capture records one; the def's name is the fallback key.
	Icon string `json:"icon,omitempty"`
}

// Series holds one value per side per step; T[i] is step i's time in seconds.
type Series struct {
	T []float64 `json:"t"`
	// Army is the metal value of each side's army: armed, mobile, priced,
	// not a commander, weighted by build progress.
	Army [][]float64 `json:"army"`
	// Value is the metal value of EVERYTHING each side owns — units and
	// buildings, commanders included, weighted by build progress — at the
	// step's last sample: what a loss is measured against, since metal lost
	// early and late differ by orders of magnitude. Version 4 and later, and
	// only when every def is priced (CostCoverage full).
	Value [][]float64 `json:"value,omitempty"`
	// MetalIncome and EnergyIncome are per game-second, averaged over the step.
	MetalIncome  [][]float64 `json:"metalIncome"`
	EnergyIncome [][]float64 `json:"energyIncome"`
	// ArmyByCat splits Army: [side][category][step], categories in ArmyCats.
	ArmyCats  []string      `json:"armyCats"`
	ArmyByCat [][][]float64 `json:"armyByCat"`
	// Front is each side's army centre per step, [side][step] = [x, z] (the
	// cost-weighted mean position of its army), null while it has none.
	Front [][][]int32 `json:"front"`
}

// Deaths is every destroyed unit, columnar: the i-th entry of each slice
// describes the same death. X/Z are the unit's last sampled position (up to
// one sample before it died); Cost is 0 when the replay does not price it.
type Deaths struct {
	F          []int32   `json:"f"`
	X          []int32   `json:"x"`
	Z          []int32   `json:"z"`
	Def        []int32   `json:"def"`
	Team       []int32   `json:"team"`
	Cost       []float64 `json:"cost"`
	Unfinished []int8    `json:"unfinished"` // 1 when it died before it was finished
}

// Elimination is a team leaving the game with its units: the frame its
// remaining units started dying with it.
type Elimination struct {
	F    int32 `json:"f"`
	Team int32 `json:"team"`
	// Recorded is true when the capture recorded the elimination (a v6
	// teamdied fact), false when it was inferred from a burst of deaths.
	Recorded bool `json:"recorded"`
}

// Milestone is the first time a side finished a unit of a milestone class.
type Milestone struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Side  int    `json:"side"`
	Team  int32  `json:"team"`
	Def   int32  `json:"def"`
	F     int32  `json:"f"`
	// The unit that reached it, and where it was last sampled before it
	// finished (absent when it never was): its clip zooms there and
	// follows it.
	Unit int32     `json:"unit,omitempty"`
	Pos  *[2]int32 `json:"pos,omitempty"`
}

type ChatLine struct {
	F    int32  `json:"f"`
	Name string `json:"name"`
	Side int    `json:"side"` // -1: spectator, relay or unknown
	Dest string `json:"dest,omitempty"`
	Text string `json:"text"`
}

// Marshal encodes the file. The output is deterministic: map keys sort, and
// every slice is built in a fixed order.
func Marshal(ins *Insights) ([]byte, error) { return json.Marshal(ins) }

// roster resolves teams to sides.
type roster struct {
	sides      []Side
	teamSide   map[int32]int
	teamIndex  map[int32]int // team id -> index into Insights.Teams
	teams      []Team
	playerTeam map[int32]int32
	playerName map[int32]string
}

func buildRoster(m snapshot.Meta) roster {
	r := roster{teamSide: map[int32]int{}, teamIndex: map[int32]int{}, playerTeam: map[int32]int32{}, playerName: map[int32]string{}}
	teamAlly := map[int32]int32{}
	teamColor := map[int32]string{}
	for _, t := range m.Teams {
		teamAlly[t.TeamID] = t.AllyTeam
		teamColor[t.TeamID] = t.Color
	}
	teamPlayers := map[int32][]string{}
	for _, p := range m.Players {
		r.playerTeam[p.PlayerID] = p.Team
		r.playerName[p.PlayerID] = p.Name
		if p.Spectator {
			continue
		}
		teamPlayers[p.Team] = append(teamPlayers[p.Team], p.Name)
	}
	allies := map[int32]bool{}
	for team := range teamPlayers {
		if a, ok := teamAlly[team]; ok {
			allies[a] = true
		}
	}
	allyIDs := make([]int32, 0, len(allies))
	for a := range allies {
		allyIDs = append(allyIDs, a)
	}
	sort.Slice(allyIDs, func(i, j int) bool { return allyIDs[i] < allyIDs[j] })
	allySide := map[int32]int{}
	for i, a := range allyIDs {
		allySide[a] = i
		r.sides = append(r.sides, Side{Ally: a, Teams: []int32{}, Players: []string{}})
	}
	teamIDs := make([]int32, 0, len(m.Teams))
	for _, t := range m.Teams {
		teamIDs = append(teamIDs, t.TeamID)
	}
	sort.Slice(teamIDs, func(i, j int) bool { return teamIDs[i] < teamIDs[j] })
	for _, id := range teamIDs {
		side := -1
		if len(teamPlayers[id]) > 0 {
			side = allySide[teamAlly[id]]
			s := &r.sides[side]
			s.Teams = append(s.Teams, id)
			s.Players = append(s.Players, teamPlayers[id]...)
			if s.Color == "" {
				s.Color = teamColor[id]
			}
		}
		r.teamSide[id] = side
		r.teamIndex[id] = len(r.teams)
		player := ""
		if ps := teamPlayers[id]; len(ps) > 0 {
			player = ps[0]
		}
		r.teams = append(r.teams, Team{Team: id, Side: side, Player: player, Color: teamColor[id]})
	}
	return r
}

// side returns a team's side index, -1 for none or an unknown team.
func (r roster) side(team int32) int {
	if s, ok := r.teamSide[team]; ok {
		return s
	}
	return -1
}

// Compute reduces the input to its summary.
func Compute(in Input) (*Insights, error) {
	if in.Frames == nil {
		return nil, fmt.Errorf("insights: no frames")
	}
	ro := buildRoster(in.Meta)
	// The summary ends where the game was decided (gameend.go). A capture
	// that recorded its eliminations says where up front; otherwise they are
	// inferred from a first pass over the whole game, and the summary is
	// computed again up to that point.
	died := in.TeamDied
	if died == nil {
		whole, err := run(in, ro)
		if err != nil {
			return nil, err
		}
		died = map[int32]int32{}
		for _, e := range whole.Eliminated {
			died[e.Team] = e.F
		}
		if gameEnd(died, ro) < 0 {
			return whole, nil
		}
	}
	end := gameEnd(died, ro)
	if end < 0 {
		return run(in, ro)
	}
	out, err := run(in.until(end), ro)
	if err != nil || in.TeamDied != nil {
		return out, err
	}
	// Inferred eliminations come from the deaths, and the cut input no
	// longer holds the bursts that ended the game: keep the first pass's.
	out.Eliminated = out.Eliminated[:0]
	for t, f := range died {
		if f <= end {
			out.Eliminated = append(out.Eliminated, Elimination{F: f, Team: t})
		}
	}
	sort.Slice(out.Eliminated, func(i, j int) bool {
		a, b := out.Eliminated[i], out.Eliminated[j]
		if a.F != b.F {
			return a.F < b.F
		}
		return a.Team < b.Team
	})
	return out, nil
}

// run is one pass over the input.
func run(in Input, ro roster) (*Insights, error) {
	p := newPass(in, ro)
	if err := in.Frames(p.frame); err != nil {
		return nil, err
	}
	p.finish()
	if p.out.CostCoverage != CostFull {
		// Only armed mobile defs are priced: a "value" of those alone is
		// the army again, not what the side owns.
		p.out.Series.Value = nil
	}
	return p.out, nil
}

// round1 keeps one decimal, which is all a chart can show and roughly halves
// the file.
func round1(v float64) float64 { return math.Round(v*10) / 10 }

func round1All(xs []float64) {
	for i, v := range xs {
		xs[i] = round1(v)
	}
}
