package viz

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"math"
	"sort"

	"github.com/mabn/barreplay/snapshot"
)

// The browser payload is a binary "BRW1" container (see snapshot/brp.go for
// the framing), not JSON: a real capture holds millions of unit records, and
// the flat-JSON encoding used previously was ~150 MB where the binary sections
// are ~10 MB. Sections:
//
//	J  head JSON (this file's wireHead): meta, teams, icons, footprints, bounds
//	F  core frame columns — for a .brp capture this is the file's F section
//	   byte-for-byte (no server-side re-encoding); legacy .jsonl/.brsnap
//	   captures are encoded through the same snapshot codec on the fly
//	E  events — same pass-through rule
//
// The decoder lives in web/app.js (decodeReplay) and must mirror
// snapshot/brp.go's column layout exactly — evolve them together.

// wireHead is the J-section JSON: everything the viewer needs besides the
// frame/event columns.
type wireHead struct {
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
	// Footprints maps a structure's internal name to its build-footprint size in
	// elmos. Only immobile units are included (presence == it doesn't move), so the
	// front-end draws a footprint rectangle only for buildings/turrets/etc.
	Footprints map[string]wireFootprint `json:"footprints"`
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

// buildHead assembles the J-section head from capture metadata. extraTeams
// lists team ids seen in frames/events but absent from Meta.Teams, so nothing
// renders colourless.
func buildHead(meta snapshot.Meta, b wireBounds, extraTeams []int32) wireHead {
	h := wireHead{
		GameID:        meta.GameID,
		EngineVersion: meta.EngineVersion,
		GameVersion:   meta.GameVersion,
		MapName:       meta.MapName,
		SampleEvery:   meta.SampleEvery,
		Bounds:        b,
	}
	// The browser only needs id->name for icon lookup and tooltips; the full unit
	// defs stay in the capture file.
	h.UnitDefs = make(map[int32]string, len(meta.UnitDefs))
	for id, d := range meta.UnitDefs {
		h.UnitDefs[id] = d.Name
	}

	seen := map[int32]bool{}
	for _, t := range meta.Teams {
		h.Teams = append(h.Teams, wireTeam{TeamID: t.TeamID, AllyTeam: t.AllyTeam, Side: t.Side, Player: t.PlayerName, Color: t.Color})
		seen[t.TeamID] = true
	}
	for _, id := range extraTeams {
		if !seen[id] {
			seen[id] = true
			h.Teams = append(h.Teams, wireTeam{TeamID: id, AllyTeam: id})
		}
	}

	// Icons for the unit types present in this replay (missing icons are simply
	// omitted; the front-end falls back to a coloured dot).
	// Resolve each def's icon by its icontype key (falling back to its name), so a
	// unit whose iconType differs from its name still gets an icon. Keyed by name,
	// which is how the front-end looks it up (via unitDefs[def]).
	h.UnitIcons = map[string]wireIcon{}
	for _, d := range meta.UnitDefs {
		if path, size, ok := unitIconFor(d.IconType, d.Name); ok {
			h.UnitIcons[d.Name] = wireIcon{Path: path, Size: size}
		}
	}

	// Build footprints for structures only, via !CanMove OR IsBuilding. Neither
	// flag alone suffices: nano/build turrets are immobile but tagged builders (not
	// buildings), while some factories report CanMove — so the union catches both
	// and still excludes genuinely mobile units. XSize/ZSize are in 8-elmo squares
	// (engine SQUARE_SIZE), so multiply by 8.
	const squareSize = 8
	h.Footprints = map[string]wireFootprint{}
	for _, d := range meta.UnitDefs {
		if (!d.CanMove || d.IsBuilding) && d.XSize > 0 {
			h.Footprints[d.Name] = wireFootprint{W: d.XSize * squareSize, H: d.ZSize * squareSize}
		}
	}
	return h
}

// assembleWire builds the BRW1 response from a head and the (already gzipped)
// F/E section payloads.
func assembleWire(head wireHead, framesSec, eventsSec []byte) ([]byte, error) {
	headJSON, err := json.Marshal(head)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	err = snapshot.WriteContainer(&buf, snapshot.BRWMagic, 1, []snapshot.Section{
		{Tag: snapshot.SecHead, Payload: gzipBytes(headJSON)},
		{Tag: snapshot.SecFrames, Payload: framesSec},
		{Tag: snapshot.SecEvents, Payload: eventsSec},
	})
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// gzipBytes compresses b as a standalone gzip stream, matching how the
// snapshot section encoders compress theirs.
func gzipBytes(b []byte) []byte {
	var buf bytes.Buffer
	gz, _ := gzip.NewWriterLevel(&buf, gzip.DefaultCompression)
	gz.Write(b)
	gz.Close()
	return buf.Bytes()
}

// wirePayload encodes a fully-loaded legacy capture (.jsonl/.brsnap) into the
// wire container, running the frames/events through the same snapshot codec
// that .brp files store.
func (rep *Replay) wirePayload() ([]byte, error) {
	head := buildHead(rep.Meta, bounds(rep.Frames), frameTeams(rep))
	return assembleWire(head,
		snapshot.EncodeFramesSection(rep.Frames, rep.Meta.SampleEvery),
		snapshot.EncodeEventsSection(rep.Events))
}

// brpWirePayload builds the wire container for a parsed .brp: the stored F/E
// sections are forwarded byte-for-byte, and bounds/teams come from the file's
// meta record (precomputed at capture time), so nothing is re-encoded.
func brpWirePayload(f *snapshot.BRPFile) ([]byte, error) {
	b := defaultBounds()
	if f.Bounds != nil {
		b = wireBounds{MinX: f.Bounds.MinX, MaxX: f.Bounds.MaxX, MinZ: f.Bounds.MinZ, MaxZ: f.Bounds.MaxZ}
	}
	head := buildHead(f.Meta, b, f.FrameTeams)
	framesSec := f.Sections[snapshot.SecFrames]
	if framesSec == nil {
		framesSec = snapshot.EncodeFramesSection(nil, f.Meta.SampleEvery)
	}
	eventsSec := f.Sections[snapshot.SecEvents]
	if eventsSec == nil {
		eventsSec = snapshot.EncodeEventsSection(nil)
	}
	return assembleWire(head, framesSec, eventsSec)
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
		return defaultBounds()
	}
	return b
}

func defaultBounds() wireBounds { return wireBounds{MinX: 0, MaxX: 1024, MinZ: 0, MaxZ: 1024} }

// frameTeams returns the sorted team ids that appear in frames/events but not
// in Meta.Teams.
func frameTeams(rep *Replay) []int32 {
	seen := map[int32]bool{}
	for _, t := range rep.Meta.Teams {
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
	return ids
}
