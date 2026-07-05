package viz

import (
	"math"
	"sort"

	"github.com/mabn/barreplay/snapshot"
)

// unitStride is the number of ints packed per unit in a wireFrame.U slice:
// [id, def, team, x, z, hp, maxHp]. Positions/health are rounded to integers —
// engine "elmo" precision is far finer than a top-down map view needs, and
// integer JSON encodes much smaller than float. The front-end reads this stride.
const unitStride = 7

// wireReplay is the JSON payload sent to the browser. Frames use a flat integer
// array per frame instead of an array of objects: a real replay can hold ~600
// units/frame over thousands of frames, so dropping JSON key overhead (and the
// unused Y/height axis) keeps the payload an order of magnitude smaller.
type wireReplay struct {
	GameID        string           `json:"gameId"`
	EngineVersion string           `json:"engineVersion,omitempty"`
	GameVersion   string           `json:"gameVersion,omitempty"`
	MapName       string           `json:"mapName,omitempty"`
	SampleEvery   int32            `json:"sampleEvery"`
	Bounds        wireBounds       `json:"bounds"`
	Teams         []wireTeam       `json:"teams"`
	UnitDefs      map[int32]string `json:"unitDefs"`
	// UnitIcons maps a unit's internal name to its icon (served path + BAR size
	// multiplier), limited to the def names present in this replay. The browser
	// looks a unit up by name (via UnitDefs) and requests "/" + path.
	UnitIcons map[string]wireIcon `json:"unitIcons"`
	// Footprints maps a building's internal name to its build-footprint size in
	// elmos. Only immobile structures are included (presence == it's a building),
	// so the front-end draws a footprint rectangle only for buildings.
	Footprints map[string]wireFootprint `json:"footprints"`
	Frames     []wireFrame              `json:"frames"`
	Events     []wireEvent              `json:"events"`
}

// wireIcon is one unit type's icon in the payload: p = served bitmap path
// ("icons/foo.png"), s = per-type size multiplier (icons are drawn at a constant
// screen size of base*s px, independent of zoom, like BAR's own minimap icons).
type wireIcon struct {
	Path string  `json:"p"`
	Size float64 `json:"s"`
}

// wireFootprint is a building's build footprint in elmos (w = x extent, h = z
// extent). The unit's sampled position is the footprint centre, so the front-end
// draws the rectangle centred on it.
type wireFootprint struct {
	W int32 `json:"w"`
	H int32 `json:"h"`
}

// wireBounds is the world-space extent of all sampled unit positions (x/z
// ground plane), used by the front-end to fit the map into the viewport.
type wireBounds struct {
	MinX float64 `json:"minX"`
	MaxX float64 `json:"maxX"`
	MinZ float64 `json:"minZ"`
	MaxZ float64 `json:"maxZ"`
}

type wireTeam struct {
	TeamID   int32  `json:"team"`
	AllyTeam int32  `json:"ally"`
	Side     string `json:"side,omitempty"`
	Player   string `json:"player,omitempty"`
	Color    string `json:"color,omitempty"`
}

type wireFrame struct {
	Frame int32   `json:"f"`
	Time  float32 `json:"t"`
	N     int     `json:"n"` // unit count (U has N*unitStride entries)
	U     []int32 `json:"u"`
}

type wireEvent struct {
	Frame int32  `json:"f"`
	Kind  string `json:"k"`
	Unit  int32  `json:"id"`
	Def   int32  `json:"def"`
	Team  int32  `json:"team"`
}

// toWire builds the browser payload from a loaded Replay.
func (rep *Replay) toWire() wireReplay {
	w := wireReplay{
		GameID:        rep.Meta.GameID,
		EngineVersion: rep.Meta.EngineVersion,
		GameVersion:   rep.Meta.GameVersion,
		MapName:       rep.Meta.MapName,
		SampleEvery:   rep.Meta.SampleEvery,
		Bounds:        bounds(rep.Frames),
	}
	// The browser only needs id->name for icon lookup and tooltips; the full unit
	// defs live in the .jsonl. Derive the compact name map from them.
	w.UnitDefs = make(map[int32]string, len(rep.Meta.UnitDefs))
	for id, d := range rep.Meta.UnitDefs {
		w.UnitDefs[id] = d.Name
	}

	// Teams come from Meta when present; otherwise synthesize from the team ids
	// seen across frames/events so the front-end can still colour by team.
	w.Teams = teams(rep)

	// Icons for the unit types present in this replay (missing icons are simply
	// omitted; the front-end falls back to a coloured dot).
	// Resolve each def's icon by its icontype key (falling back to its name), so a
	// unit whose iconType differs from its name still gets an icon. Keyed by name,
	// which is how the front-end looks it up (via unitDefs[def]).
	w.UnitIcons = map[string]wireIcon{}
	for _, d := range rep.Meta.UnitDefs {
		if path, size, ok := unitIconFor(d.IconType, d.Name); ok {
			w.UnitIcons[d.Name] = wireIcon{Path: path, Size: size}
		}
	}

	// Build footprints for immobile structures only. XSize/ZSize are in 8-elmo
	// squares (engine SQUARE_SIZE), so multiply by 8 for world elmos.
	const squareSize = 8
	w.Footprints = map[string]wireFootprint{}
	for _, d := range rep.Meta.UnitDefs {
		if d.IsBuilding && d.XSize > 0 {
			w.Footprints[d.Name] = wireFootprint{W: d.XSize * squareSize, H: d.ZSize * squareSize}
		}
	}

	w.Frames = make([]wireFrame, len(rep.Frames))
	for i, fr := range rep.Frames {
		u := make([]int32, 0, len(fr.Units)*unitStride)
		for _, us := range fr.Units {
			u = append(u,
				us.UnitID, us.DefID, us.Team,
				round(us.Pos.X), round(us.Pos.Z),
				round(us.Health), round(us.MaxHealth),
			)
		}
		w.Frames[i] = wireFrame{Frame: fr.Frame, Time: fr.TimeSec, N: len(fr.Units), U: u}
	}

	w.Events = make([]wireEvent, len(rep.Events))
	for i, e := range rep.Events {
		w.Events[i] = wireEvent{Frame: e.Frame, Kind: string(e.Kind), Unit: e.UnitID, Def: e.DefID, Team: e.Team}
	}
	return w
}

// bounds returns the min/max x/z over every unit in every frame. When there are
// no units it returns a small default box so the front-end has a valid extent.
func bounds(frames []snapshot.Frame) wireBounds {
	b := wireBounds{MinX: math.Inf(1), MaxX: math.Inf(-1), MinZ: math.Inf(1), MaxZ: math.Inf(-1)}
	any := false
	for _, fr := range frames {
		for _, u := range fr.Units {
			any = true
			x, z := float64(u.Pos.X), float64(u.Pos.Z)
			b.MinX, b.MaxX = math.Min(b.MinX, x), math.Max(b.MaxX, x)
			b.MinZ, b.MaxZ = math.Min(b.MinZ, z), math.Max(b.MaxZ, z)
		}
	}
	if !any {
		return wireBounds{MinX: 0, MaxX: 1024, MinZ: 0, MaxZ: 1024}
	}
	return b
}

// teams returns the team roster. Meta.Teams is authoritative; any team id that
// appears in the frames/events but not in Meta is appended so nothing renders
// without a colour.
func teams(rep *Replay) []wireTeam {
	out := make([]wireTeam, 0, len(rep.Meta.Teams))
	seen := map[int32]bool{}
	for _, t := range rep.Meta.Teams {
		out = append(out, wireTeam{TeamID: t.TeamID, AllyTeam: t.AllyTeam, Side: t.Side, Player: t.PlayerName, Color: t.Color})
		seen[t.TeamID] = true
	}
	extra := map[int32]bool{}
	for _, fr := range rep.Frames {
		for _, u := range fr.Units {
			if !seen[u.Team] {
				extra[u.Team] = true
			}
		}
	}
	for _, e := range rep.Events {
		if !seen[e.Team] {
			extra[e.Team] = true
		}
	}
	ids := make([]int32, 0, len(extra))
	for id := range extra {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		out = append(out, wireTeam{TeamID: id, AllyTeam: id})
	}
	return out
}

func round(f float32) int32 { return int32(math.Round(float64(f))) }
