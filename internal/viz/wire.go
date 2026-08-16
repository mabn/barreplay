package viz

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"math"

	"github.com/mabn/barreplay/snapshot"
)

// The browser payload is binary, not JSON — a real capture holds millions of
// unit records. /replays/<id>.brw is a small "BRW1" container (same section
// framing as .brp, see snapshot/brp.go):
//
//	J  head JSON (this file's wireHead): meta, teams, icons, footprints,
//	   bounds, and the CHUNK INDEX
//	E  events — the .brp file's E section byte-for-byte
//	C  chat + map drawings — the .brp file's C section byte-for-byte (absent
//	   when the capture recorded none)
//
// The frame data itself is NOT in this payload: the browser streams
// /replays/<id>.keys (every keyframe, one gzip stream — the whole timeline
// becomes scrubbable while it downloads) and fetches each chunk's delta file
// /replays/<id>/c<n> as the user plays/seeks. The server slices all of these
// straight out of the stored file (they are independently gzipped exactly so
// that no re-encoding is ever needed). The decoder lives in
// worker/public/app.js and must mirror snapshot/brp.go's layout exactly —
// evolve them together.

// resourceStride is the number of ints packed per team in a resource record
// (see /api/replay/resources): [team, metal, energy, metalStore, energyStore,
// metalIncome, energyIncome]. Income is per game-second; values are rounded to
// integers (a resource UI needs no sub-unit precision). The front-end reads this
// stride.
const resourceStride = 7

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
	// UnitNames maps a def id to its HUMAN-READABLE name ("Construction Bot"),
	// which is what the viewer labels units with; UnitDefs' internal name
	// ("armck") stays the lookup key for icons/footprints and the tooltip's
	// secondary line. Only defs whose capture recorded a human name that differs
	// from the internal one get an entry, so a capture predating the full DEF
	// dump simply has none and the front-end falls back to the internal name.
	UnitNames map[int32]string `json:"unitNames,omitempty"`
	// UnitIcons maps a unit's internal name to its icon (served path + BAR size
	// multiplier), limited to the def names present in this replay. The browser
	// looks a unit up by name (via UnitDefs) and requests "/" + path.
	UnitIcons map[string]wireIcon `json:"unitIcons"`
	// Footprints maps a structure's internal name to its build-footprint size in
	// elmos. Only immobile units are included (presence == it doesn't move), so the
	// front-end draws a footprint rectangle only for buildings/turrets/etc.
	Footprints map[string]wireFootprint `json:"footprints"`
	// Players is the human/AI roster the sidebar player list renders (country
	// flag, rank, OpenSkill "OS"), tied to a team. Small, so it rides the head.
	Players []wirePlayer `json:"players"`
	// FrameCount is the total number of sampled frames; Chunks indexes the
	// fetchable chunks in order (chunk i covers frames
	// [sum(count[:i]), sum(count[:i+1])) of the global timeline).
	FrameCount int         `json:"frameCount"`
	Chunks     []wireChunk `json:"chunks"`
}

// wirePlayer is one player in the roster. Only the fields the player list needs
// are sent; richer demo metadata (account id, uncertainty, boss) stays in the
// capture file. Zero-valued optional fields are omitted so a fallback roster (a
// raw .brsnap with only name/team/spectator) stays compact.
type wirePlayer struct {
	ID        int32   `json:"id"`
	Name      string  `json:"name"`
	Team      int32   `json:"team"`
	Spectator bool    `json:"spec,omitempty"`
	Country   string  `json:"country,omitempty"` // ISO code -> flag
	Rank      int32   `json:"rank,omitempty"`
	Skill     float32 `json:"skill,omitempty"` // OpenSkill "OS" rating
}

// wireChunk describes one fetchable chunk to the browser. kLen is the RAW
// (decompressed) byte length of this chunk's keyframe inside the .keys
// stream — the cumulative kLen values are the boundaries the client uses to
// consume the keys download progressively. len is the byte size of the
// chunk's delta file (0 when the chunk is a single frame: nothing to fetch).
type wireChunk struct {
	Frame int32 `json:"frame"` // sim frame of the chunk's first sample
	Count int   `json:"count"` // samples in this chunk
	KLen  int64 `json:"kLen"`
	Len   int64 `json:"len"`
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
	h.UnitNames = map[int32]string{}
	for id, d := range meta.UnitDefs {
		h.UnitDefs[id] = d.Name
		if d.HumanName != "" && d.HumanName != d.Name {
			h.UnitNames[id] = d.HumanName
		}
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

	// Player roster (drives the sidebar player list). Passed through verbatim from
	// Meta; the front-end maps each player to its team's per-frame economy (fetched
	// separately via /api/replay/resources).
	h.Players = make([]wirePlayer, 0, len(meta.Players))
	for _, p := range meta.Players {
		h.Players = append(h.Players, wirePlayer{
			ID:        p.PlayerID,
			Name:      p.Name,
			Team:      p.Team,
			Spectator: p.Spectator,
			Country:   p.CountryCode,
			Rank:      p.Rank,
			Skill:     p.Skill,
		})
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
		head.Chunks[i] = wireChunk{Frame: c.Frame, Count: c.Count, KLen: c.KLen, Len: c.FLen}
	}

	headJSON, err := json.Marshal(head)
	if err != nil {
		return nil, err
	}
	sections := []snapshot.Section{{Tag: snapshot.SecHead, Payload: gzipBytes(headJSON)}}
	if e, ok := f.Sections[snapshot.SecEvents]; ok {
		sections = append(sections, snapshot.Section{Tag: snapshot.SecEvents, Payload: e})
	}
	if c, ok := f.Sections[snapshot.SecComms]; ok {
		sections = append(sections, snapshot.Section{Tag: snapshot.SecComms, Payload: c})
	}
	var buf bytes.Buffer
	if err := snapshot.WriteContainer(&buf, snapshot.BRWMagic, snapshot.BRPVersion, sections); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// wireResFrame is one sampled frame's per-team economy for the player list:
// the sim frame plus a flat int slice of stride resourceStride.
type wireResFrame struct {
	F int32   `json:"f"`
	R []int32 `json:"r"`
}

// brpResourcesPayload builds the /api/replay/resources response: a gzipped JSON
// array of {f, r} for every sampled frame that carries team economy. The viewer
// fetches this once (lazily, after the head) to drive the player list's metal/
// energy bars — resources are stored in the .brp X stream, which the frame
// chunk-streaming path never fetches, so we decode them here instead. Decoding
// chunk-by-chunk keeps peak memory bounded (frames are discarded after their
// resources are copied out).
func brpResourcesPayload(f *snapshot.BRPFile) ([]byte, error) {
	js, err := brpResourcesJSON(f)
	if err != nil {
		return nil, err
	}
	return gzipBytes(js), nil
}

// brpResourcesJSON is the uncompressed resources body (the JSON array before
// gzip). The static bundler stores this verbatim so the platform can apply its
// own transport compression — storing a pre-gzipped body and declaring
// Content-Encoding: gzip double-compresses on Cloudflare (workerd re-encodes it).
func brpResourcesJSON(f *snapshot.BRPFile) ([]byte, error) {
	out := make([]wireResFrame, 0, f.FrameCount)
	for i := range f.Chunks {
		frames, err := f.DecodeChunk(i)
		if err != nil {
			return nil, err
		}
		for _, fr := range frames {
			if len(fr.Resources) == 0 {
				continue
			}
			r := make([]int32, 0, len(fr.Resources)*resourceStride)
			for _, rs := range fr.Resources {
				r = append(r,
					rs.Team,
					round(rs.Metal), round(rs.Energy),
					round(rs.MetalStorage), round(rs.EnergyStorage),
					round(rs.MetalIncome), round(rs.EnergyIncome),
				)
			}
			out = append(out, wireResFrame{F: fr.Frame, R: r})
		}
	}
	return json.Marshal(out)
}

func round(f float32) int32 { return int32(math.Round(float64(f))) }

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
