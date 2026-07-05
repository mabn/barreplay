package viz

import (
	"bytes"
	"compress/gzip"
	"encoding/json"

	"github.com/mabn/barreplay/snapshot"
)

// The browser payload is binary, not JSON — a real capture holds millions of
// unit records. /api/replay returns a small "BRW1" container (same section
// framing as .brp, see snapshot/brp.go):
//
//	J  head JSON (this file's wireHead): meta, teams, icons, footprints,
//	   bounds, and the CHUNK INDEX
//	E  events — the .brp file's E section byte-for-byte
//
// The frame data itself is NOT in this payload: the browser fetches chunks
// individually via /api/replay/chunk as the user plays/seeks/skims, and the
// server slices each chunk's bytes straight out of the stored file (they are
// independently gzipped exactly so that no re-encoding is ever needed). The
// decoder lives in web/app.js and must mirror snapshot/brp.go's column layout
// exactly — evolve them together.

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
	// FrameCount is the total number of sampled frames; Chunks indexes the
	// fetchable chunks in order (chunk i covers frames
	// [sum(count[:i]), sum(count[:i+1])) of the global timeline).
	FrameCount int         `json:"frameCount"`
	Chunks     []wireChunk `json:"chunks"`
}

// wireChunk describes one fetchable chunk to the browser. keyLen is where the
// keyframe gzip stream ends within the chunk's bytes, so the client can split
// a fetched chunk into its two gzip streams (and so it knows what a
// keyframe-only response contains).
type wireChunk struct {
	Frame  int32 `json:"frame"` // sim frame of the chunk's first sample
	Count  int   `json:"count"` // samples in this chunk
	KeyLen int64 `json:"keyLen"`
	Len    int64 `json:"len"`
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

// brpWirePayload builds the /api/replay response for a parsed .brp: the head
// (with the chunk index) plus the stored E section byte-for-byte. Bounds and
// teams come from the file's meta record, precomputed at capture time — the
// server never decodes a frame.
func brpWirePayload(f *snapshot.BRPFile) ([]byte, error) {
	b := defaultBounds()
	if f.Bounds != nil {
		b = wireBounds{MinX: f.Bounds.MinX, MaxX: f.Bounds.MaxX, MinZ: f.Bounds.MinZ, MaxZ: f.Bounds.MaxZ}
	}
	head := buildHead(f.Meta, b, f.FrameTeams)
	head.FrameCount = f.FrameCount
	head.Chunks = make([]wireChunk, len(f.Chunks))
	for i, c := range f.Chunks {
		head.Chunks[i] = wireChunk{Frame: c.Frame, Count: c.Count, KeyLen: c.FKeyLen, Len: c.FLen}
	}

	headJSON, err := json.Marshal(head)
	if err != nil {
		return nil, err
	}
	sections := []snapshot.Section{{Tag: snapshot.SecHead, Payload: gzipBytes(headJSON)}}
	if e, ok := f.Sections[snapshot.SecEvents]; ok {
		sections = append(sections, snapshot.Section{Tag: snapshot.SecEvents, Payload: e})
	}
	var buf bytes.Buffer
	if err := snapshot.WriteContainer(&buf, snapshot.BRWMagic, snapshot.BRPVersion, sections); err != nil {
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

func defaultBounds() wireBounds { return wireBounds{MinX: 0, MaxX: 1024, MinZ: 0, MaxZ: 1024} }
