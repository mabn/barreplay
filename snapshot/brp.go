package snapshot

// The on-disk format: ".brp", a compact binary capture. It replaced the
// retired v1 JSONL, which stored a real game in ~500 MB vs ~8 MB of .brp — unit
// state changes very little between 1 Hz samples, so per-unit temporal deltas
// (with the unit's own velocity as the position predictor) shrink to near-zero
// varints, delta frames skip unchanged units entirely, and gzip flattens what
// remains.
//
// Layout: a magic + version header, then tagged sections:
//
//	"BRP1" <version u8 = 5> then per section: <tag u8> <len u32le> <payload>
//
//	M  meta JSON: {"meta": <Meta>, "bounds", "frameTeams", "chunks" index,
//	   counts, "sections" layout} — always the FIRST section
//	E  lifecycle events
//	C  chat + map drawings (optional)
//	K  ALL core keyframes, one gzip stream (keys-first streaming + skimming)
//	F  core delta frames, chunked: id def team x z hp maxHp dvx dvz build target
//	X  extra: team resources (keyframe+delta per chunk)
//
// The file is published as-is and the browser reads it with HTTP Range
// requests (see worker/public/app.js): the meta's "sections" layout gives
// every section's position, and M, E and C come first so that one read of
// the head of the file usually holds everything needed to start drawing.
//
// The M, K, E and C payloads are single gzip streams. The F and X payloads are a
// concatenation of CHUNKS — the random-access unit (the video-codec model):
// frames are grouped into runs of chunkFrames samples (64 ≈ 1 min at 1 Hz) and
// the codec's prediction state is RESET at every chunk boundary, so a chunk's
// first frame encodes with the "new id / absolute" path — a keyframe.
//
// KEYFRAMES LIVE OUTSIDE THE CHUNKS (v4): every chunk's core keyframe is
// concatenated (in chunk order) into the K section and gzipped as ONE stream.
// A viewer downloads K first — one request, streamed through
// DecompressionStream — and can render/scrub ANY minute of the game before
// any chunk arrives; keyframe i's raw byte range inside the decompressed K is
// in the chunk index (kOff/kLen), so the stream is consumed progressively
// with no trial parsing. The F section holds only each chunk's DELTA frames
// (one standalone gzip stream per chunk; absent when the chunk has a single
// frame), so no byte is ever fetched twice. Decoding a chunk therefore needs
// its keyframe first: decode K[kOff:kOff+kLen] with fresh codec state, then
// the chunk's delta bytes with that state (BRPFile.DecodeChunk does). Merging
// the keyframes into one stream also compresses ~12% better than per-chunk
// keyframe streams (adjacent keyframes are near-duplicates). The X section
// (the economy timeline the viewer fetches whole) keeps its keyframe+delta
// split per chunk.
//
// The M record's "chunks" array indexes everything: first sim frame, sample
// count, the keyframe's raw range in K, and the delta byte ranges (offsets
// RELATIVE to the owning section's payload start; a section's absolute file
// offset is reported by ReadContainer, so range-based consumers can add the
// two).
//
// Chunks are separately gzipped ON PURPOSE: the published file
// (internal/viz/static.go) hands individual chunk byte ranges, the K payload,
// and the E payload to the browser byte-for-byte with no re-encoding, and the
// browser gunzips them with its native DecompressionStream — that is what
// makes instant start, seeking and skimming cheap. Unknown tags are skipped
// on read, so sections can be added compatibly.
//
// Values are quantized once at write time: positions/health to whole
// elmos/points, velocities to whole elmos *per sample interval* (dv =
// round(vel*sampleEvery) — exactly the displacement the viewer interpolates
// with), build progress to 1/255, resources to 1/10. Frame time is not stored
// (t = frame/30 by the engine's fixed sim rate). Units within a frame are
// sorted by id. The unit's elevation (Pos.Y/VelY) is NOT stored (v3): the
// viewer renders the x/z plane only, and ground units' y is terrain-following
// noise that cost ~28% of all column changes; decoded frames return y=0.
//
// Frame encoding (all zigzag varints; every frame uses the same layout —
// a keyframe is just a frame encoded against empty prior state):
//
//	sv frameDelta
//	uv nDead      ids in the previous sampled frame but absent now
//	  sv idDelta…   (ascending, delta-coded from 0)
//	uv nChanged   new ids + ids with ≥1 non-zero column delta
//	  sv idDelta…   (ascending, delta-coded from 0)
//	10 core columns × nChanged   def team x z hp maxHp dvx dvz build target
//	(X stream) team resources
//
// A unit absent from BOTH lists is implicitly unchanged: the decoder keeps it
// alive and advances its position by its velocity displacement (x += dvx,
// z += dvz — the same prediction the encoder used to decide "unchanged", so
// the reconstruction is exact). This is what makes idle units — ~2/3 of all
// unit records in a real game — cost zero bytes in delta frames.
//
// Column values are deltas against the SAME unit in the previous sampled
// frame (absolute if the id is new); x/z additionally add the previous
// frame's dvx/dvz to the prediction, so constant-velocity movement encodes
// as zero. "Changed" is judged across all stored columns, so a build-progress
// or build-target change alone restates the unit. build (1/255) and target
// (the unit id being constructed/assisted, 0 = none) moved from X into the
// core columns in v5 so the browser gets them: the viewer draws construction
// progress bars and builder->target lines. Decoders must mirror this exactly;
// the JS decoder lives in worker/public/app.js — evolve them together.

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
)

// Container framing shared by .brp files ("BRP1") and the viz wire payload
// ("BRW1"). A .brp starts with M; the writer then puts E, C, K, F, X (the
// layout in the meta record says so), then v6's optional analysis sections
// G, D, S, V (see analysis.go). Readers accept any order after M and skip
// unknown tags.
const (
	BRPMagic = "BRP1"
	BRWMagic = "BRW1"

	// BRPVersion is the version written. v6 added the analysis sections
	// (G, D, S, V — see analysis.go) and the events' cause columns; a v5
	// file reads exactly as before, with none of them. v1 (unchunked), v2
	// (every live unit re-encoded per frame, y/dvy columns), v3 (keyframes
	// inside the chunks) and v4 (build in X, no target column) are not
	// supported — regenerate a .brp from its source .brepstream with pack.
	// (The JS decoder still plays published v4 bundles.)
	BRPVersion byte = 6
	// BRPMinVersion is the oldest version the Go reader accepts. A capture
	// cannot be re-simulated for free, so a version bump ADDS data and every
	// older file stays readable, merely without the newer features.
	BRPMinVersion byte = 5

	SecMeta      byte = 'M' // .brp: meta JSON
	SecKeyframes byte = 'K' // all core keyframes, one gzip stream
	SecFrames    byte = 'F' // core delta frames, chunked
	SecExtra     byte = 'X' // extra frame columns: team economy
	SecEvents    byte = 'E' // lifecycle events
	SecComms     byte = 'C' // player chat + map drawings
	SecHead      byte = 'J' // wire payload: head JSON (viz-specific)
)

// defaultChunkFrames is the random-access granularity: samples per chunk.
// 64 at the default 1 Hz sampling ≈ one minute of game per seek unit. Smaller
// chunks seek finer but repeat keyframes more often (~+5% size at 64).
const defaultChunkFrames = 64

// simFPS is the engine's fixed simulation rate; frame time is derived from it.
const simFPS = 30

// buildScale quantizes BuildProgress (0..1) for storage.
const buildScale = 255

// resScale quantizes resource values (metal/energy/storage/income) to tenths.
const resScale = 10

// Section is one tagged payload of a container.
type Section struct {
	Tag     byte
	Payload []byte // still compressed / raw section bytes
	// Offset is the payload's absolute byte offset in the container stream
	// (filled by ReadContainer). Adding a chunk's section-relative offset to it
	// yields the chunk's absolute file range — e.g. for HTTP Range serving.
	Offset int64
}

// WriteContainer writes magic + version + the sections in order.
func WriteContainer(w io.Writer, magic string, version byte, sections []Section) error {
	if _, err := io.WriteString(w, magic); err != nil {
		return err
	}
	if _, err := w.Write([]byte{version}); err != nil {
		return err
	}
	var hdr [5]byte
	for _, s := range sections {
		hdr[0] = s.Tag
		binary.LittleEndian.PutUint32(hdr[1:], uint32(len(s.Payload)))
		if _, err := w.Write(hdr[:]); err != nil {
			return err
		}
		if _, err := w.Write(s.Payload); err != nil {
			return err
		}
	}
	return nil
}

// ReadContainer parses a container written by WriteContainer, returning its
// version byte and sections (with absolute payload offsets filled in).
func ReadContainer(r io.Reader, magic string) (byte, []Section, error) {
	head := make([]byte, len(magic)+1)
	if _, err := io.ReadFull(r, head); err != nil {
		return 0, nil, fmt.Errorf("snapshot: reading container header: %w", err)
	}
	if string(head[:len(magic)]) != magic {
		return 0, nil, fmt.Errorf("snapshot: bad magic %q (want %q)", head[:len(magic)], magic)
	}
	version := head[len(magic)]
	pos := int64(len(head))
	var sections []Section
	var hdr [5]byte
	for {
		if _, err := io.ReadFull(r, hdr[:]); err == io.EOF {
			return version, sections, nil
		} else if err != nil {
			return 0, nil, fmt.Errorf("snapshot: reading section header: %w", err)
		}
		pos += int64(len(hdr))
		n := binary.LittleEndian.Uint32(hdr[1:])
		payload := make([]byte, n)
		if _, err := io.ReadFull(r, payload); err != nil {
			return 0, nil, fmt.Errorf("snapshot: reading section %q: %w", hdr[0], err)
		}
		sections = append(sections, Section{Tag: hdr[0], Payload: payload, Offset: pos})
		pos += int64(n)
	}
}

// BRPBounds is the world-space extent of all sampled unit positions, computed
// at write time so readers don't have to decode every frame to fit a viewport.
type BRPBounds struct {
	MinX float64 `json:"minX"`
	MaxX float64 `json:"maxX"`
	MinZ float64 `json:"minZ"`
	MaxZ float64 `json:"maxZ"`
}

// BRPChunk locates one random-access chunk's pieces.
//
//   - KOff/KLen: the chunk's core keyframe as a RAW (decompressed) byte range
//     inside the gunzipped K section — the boundaries a streaming consumer
//     needs, and Go's random-access entry into K.
//   - FOff/FLen: the chunk's core DELTA frames, one standalone gzip stream in
//     the F section payload (FLen == 0 when Count == 1: no delta frames).
//   - XOff/XKeyLen/XLen: the extra columns keep the pre-v4 two-stream shape —
//     keyframe gzip [XOff, XOff+XKeyLen) then delta gzip up to XOff+XLen —
//     since no browser ever fetches X.
//
// F/X offsets are compressed-byte offsets relative to the owning section's
// payload start; K offsets are decompressed-byte offsets.
type BRPChunk struct {
	Frame   int32 `json:"frame"` // sim frame of the chunk's first sample
	Count   int   `json:"count"` // samples in this chunk
	KOff    int64 `json:"kOff"`
	KLen    int64 `json:"kLen"`
	FOff    int64 `json:"fOff"`
	FLen    int64 `json:"fLen"`
	XOff    int64 `json:"xOff"`
	XKeyLen int64 `json:"xKeyLen"`
	XLen    int64 `json:"xLen"`
}

// brpMetaRecord is the JSON stored in the M section: the capture Meta plus
// aggregates a consumer would otherwise need a full frame scan for.
type brpMetaRecord struct {
	Meta Meta `json:"meta"`
	// Bounds of all sampled positions; nil when the capture has no units.
	Bounds *BRPBounds `json:"bounds,omitempty"`
	// FrameTeams lists every team id that appears in frames or events, so a
	// consumer can colour teams missing from Meta.Teams without scanning.
	FrameTeams []int32 `json:"frameTeams,omitempty"`
	Frames     int     `json:"frames"`
	Events     int     `json:"events"`
	Comms      int     `json:"comms,omitempty"`
	// Analysis record counts (v6; zero/absent when not recorded).
	Facts         int        `json:"facts,omitempty"`
	DamageWindows int        `json:"damageWindows,omitempty"`
	Lives         int        `json:"lives,omitempty"`
	Visibility    int        `json:"visibility,omitempty"`
	UnitRecords   int64      `json:"unitRecords"`
	ChunkFrames   int        `json:"chunkFrames"` // samples per chunk (last may be short)
	Chunks        []BRPChunk `json:"chunks,omitempty"`
	// Sections is the file's LAYOUT: every section after M, in file order,
	// with its payload length. The meta is always the first section, so its
	// end is known from the 10 bytes in front of it, and from there this
	// list places every other section — which is what lets a browser holding
	// only the head of the file Range-read any section without walking the
	// headers one round trip at a time. Absent from files written before it
	// existed; IndexBRP adds it.
	Sections []BRPSectionLen `json:"sections,omitempty"`
}

// BRPSectionLen is one entry of the meta record's section layout.
type BRPSectionLen struct {
	Tag string `json:"tag"` // the one-byte section tag, as a string ("K")
	Len int64  `json:"len"` // payload bytes (the 5-byte header is not counted)
}

// sectionLayout lists sections as the meta record's layout.
func sectionLayout(secs []Section) []BRPSectionLen {
	out := make([]BRPSectionLen, len(secs))
	for i, s := range secs {
		out[i] = BRPSectionLen{Tag: string(rune(s.Tag)), Len: int64(len(s.Payload))}
	}
	return out
}

// BRPFile is a parsed .brp container: the decoded meta plus the raw
// (still-compressed) sections, so consumers can slice chunks / forward E
// without re-encoding.
type BRPFile struct {
	Version     byte // container version (BRPMinVersion..BRPVersion)
	Meta        Meta
	Bounds      *BRPBounds
	FrameTeams  []int32
	FrameCount  int
	EventCount  int
	CommCount   int
	UnitRecords int64
	ChunkFrames int
	Chunks      []BRPChunk
	Sections    map[byte][]byte // tag -> raw section payload
	// SectionOffsets is each section payload's absolute byte offset in the
	// file (Section.Offset), so a section-relative range — the K section, a
	// chunk's FOff — can be turned into an HTTP Range over the file itself.
	SectionOffsets map[byte]int64

	keysRaw []byte // gunzipped K section, cached on first DecodeChunk
}

// ---------------------------------------------------------------------------
// varint helpers

func zigzag(v int64) uint64   { return uint64((v << 1) ^ (v >> 63)) }
func unzigzag(u uint64) int64 { return int64(u>>1) ^ -int64(u&1) }

// varintWriter buffers zigzag varints into an io.Writer (the gzip stream).
type varintWriter struct {
	w   io.Writer
	err error
}

func (vw *varintWriter) uv(v uint64) {
	if vw.err != nil {
		return
	}
	var tmp [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(tmp[:], v)
	_, vw.err = vw.w.Write(tmp[:n])
}

func (vw *varintWriter) sv(v int64) { vw.uv(zigzag(v)) }

// varintReader decodes from a fully-decompressed section.
type varintReader struct {
	b []byte
	p int
}

func (vr *varintReader) done() bool { return vr.p >= len(vr.b) }

func (vr *varintReader) uv() (uint64, error) {
	v, n := binary.Uvarint(vr.b[vr.p:])
	if n <= 0 {
		return 0, fmt.Errorf("snapshot: truncated varint at offset %d", vr.p)
	}
	vr.p += n
	return v, nil
}

func (vr *varintReader) sv() (int64, error) {
	u, err := vr.uv()
	return unzigzag(u), err
}

// ---------------------------------------------------------------------------
// frame codec

// prevUnitState is the encoder/decoder's per-unit memory of the previous
// sampled frame, in quantized units.
type prevUnitState struct {
	def, team, x, z, hp, maxHp, dvx, dvz int64
	build, target                        int64
}

// advance returns the state an unchanged unit reaches one sample later: the
// position moves by the velocity displacement, everything else stays. This is
// simultaneously the column predictor and the decoder's reconstruction of a
// skipped unit — they must be the same function for skipping to be lossless.
func (p prevUnitState) advance() prevUnitState {
	p.x += p.dvx
	p.z += p.dvz
	return p
}

type prevResState struct{ m, e, ms, es, mi, ei int64 }

// frameCodec holds the shared prediction state; encode and decode walk it
// identically.
type frameCodec struct {
	sampleEvery int32
	prevFrame   int64
	prev        map[int32]prevUnitState
	prevRes     map[int32]prevResState
}

func newFrameCodec(sampleEvery int32) *frameCodec {
	if sampleEvery <= 0 {
		sampleEvery = simFPS // 1 Hz default, matches the capture default
	}
	return &frameCodec{
		sampleEvery: sampleEvery,
		prev:        map[int32]prevUnitState{},
		prevRes:     map[int32]prevResState{},
	}
}

func roundq(f float32) int64 { return int64(math.Round(float64(f))) }

// quantize converts a UnitState to the stored integer domain.
func (c *frameCodec) quantize(u UnitState) prevUnitState {
	se := float32(c.sampleEvery)
	return prevUnitState{
		def: int64(u.DefID), team: int64(u.Team),
		x: roundq(u.Pos.X), z: roundq(u.Pos.Z),
		hp: roundq(u.Health), maxHp: roundq(u.MaxHealth),
		dvx: roundq(u.VelX * se), dvz: roundq(u.VelZ * se),
		build: roundq(u.BuildProgress * buildScale), target: int64(u.TargetID),
	}
}

// coreColumns defines the 10 core columns' accessors in stream order. The
// predictor for every column is the same: the corresponding field of
// prev.advance() — see prevUnitState.advance.
var coreColumns = []func(*prevUnitState) *int64{
	func(s *prevUnitState) *int64 { return &s.def },
	func(s *prevUnitState) *int64 { return &s.team },
	func(s *prevUnitState) *int64 { return &s.x },
	func(s *prevUnitState) *int64 { return &s.z },
	func(s *prevUnitState) *int64 { return &s.hp },
	func(s *prevUnitState) *int64 { return &s.maxHp },
	func(s *prevUnitState) *int64 { return &s.dvx },
	func(s *prevUnitState) *int64 { return &s.dvz },
	func(s *prevUnitState) *int64 { return &s.build },
	func(s *prevUnitState) *int64 { return &s.target },
}

// encodeFrame appends one frame to the core (F) and extra (X) streams (see
// the frame-encoding layout at the top of the file). Returns the full frame's
// sorted, quantized units — including the skipped ones — so the writer can
// update aggregates.
func (c *frameCodec) encodeFrame(core, extra *varintWriter, fr Frame) []prevUnitState {
	units := make([]UnitState, len(fr.Units))
	copy(units, fr.Units)
	sort.Slice(units, func(i, j int) bool { return units[i].UnitID < units[j].UnitID })

	q := make([]prevUnitState, len(units))
	for i, u := range units {
		q[i] = c.quantize(u)
	}

	core.sv(int64(fr.Frame) - c.prevFrame)
	c.prevFrame = int64(fr.Frame)

	// Dead ids: in the previous frame, absent now.
	live := make(map[int32]bool, len(units))
	for _, u := range units {
		live[u.UnitID] = true
	}
	var dead []int64
	for id := range c.prev {
		if !live[id] {
			dead = append(dead, int64(id))
		}
	}
	sort.Slice(dead, func(i, j int) bool { return dead[i] < dead[j] })
	core.uv(uint64(len(dead)))
	last := int64(0)
	for _, id := range dead {
		core.sv(id - last)
		last = id
	}

	// Changed set: new units, plus units whose quantized state differs from
	// the prediction in any stored column (including build).
	changed := make([]int, 0, len(units))
	for i, u := range units {
		p, ok := c.prev[u.UnitID]
		if !ok || p.advance() != q[i] {
			changed = append(changed, i)
		}
	}
	core.uv(uint64(len(changed)))
	last = 0
	for _, i := range changed {
		core.sv(int64(units[i].UnitID) - last)
		last = int64(units[i].UnitID)
	}

	// Core columns for the changed units: delta vs the advanced previous state
	// (absolute when the id is new), one column at a time.
	for _, col := range coreColumns {
		for _, i := range changed {
			base := int64(0)
			if p, ok := c.prev[units[i].UnitID]; ok {
				pa := p.advance()
				base = *col(&pa)
			}
			core.sv(*col(&q[i]) - base)
		}
	}
	// Team resources ride the extra stream, delta-coded per team.
	res := make([]TeamResource, len(fr.Resources))
	copy(res, fr.Resources)
	sort.Slice(res, func(i, j int) bool { return res[i].Team < res[j].Team })
	extra.uv(uint64(len(res)))
	for _, r := range res {
		p := c.prevRes[r.Team]
		cur := prevResState{
			m: roundq(r.Metal * resScale), e: roundq(r.Energy * resScale),
			ms: roundq(r.MetalStorage * resScale), es: roundq(r.EnergyStorage * resScale),
			mi: roundq(r.MetalIncome * resScale), ei: roundq(r.EnergyIncome * resScale),
		}
		extra.sv(int64(r.Team))
		extra.sv(cur.m - p.m)
		extra.sv(cur.e - p.e)
		extra.sv(cur.ms - p.ms)
		extra.sv(cur.es - p.es)
		extra.sv(cur.mi - p.mi)
		extra.sv(cur.ei - p.ei)
		c.prevRes[r.Team] = cur
	}

	next := make(map[int32]prevUnitState, len(units))
	for i, u := range units {
		next[u.UnitID] = q[i]
	}
	c.prev = next
	return q
}

// decodeFrames reconstructs full frames from a core stream and, when present,
// the matching extra stream (one economy record per frame; it decodes on its
// own too — app.js decodeEconomy does — but carries no frame numbers, which
// come from the core stream). Every live unit appears in every decoded
// frame: units skipped by the encoder are re-materialised by advancing their
// previous state. The codec carries the prediction state ACROSS calls — the
// caller decodes a chunk by running its keyframe bytes (from the K section)
// and then its delta bytes through the same codec.
func decodeFrames(c *frameCodec, core, extra []byte) ([]Frame, error) {
	se := float32(c.sampleEvery)
	cr := &varintReader{b: core}
	var xr *varintReader
	if extra != nil {
		xr = &varintReader{b: extra}
	}
	readIDs := func() ([]int32, error) {
		n, err := cr.uv()
		if err != nil {
			return nil, err
		}
		ids := make([]int32, n)
		last := int64(0)
		for i := range ids {
			d, err := cr.sv()
			if err != nil {
				return nil, err
			}
			last += d
			ids[i] = int32(last)
		}
		return ids, nil
	}
	var frames []Frame
	for !cr.done() {
		fd, err := cr.sv()
		if err != nil {
			return nil, err
		}
		frame := c.prevFrame + fd
		c.prevFrame = frame

		dead, err := readIDs()
		if err != nil {
			return nil, err
		}
		chIDs, err := readIDs()
		if err != nil {
			return nil, err
		}

		// Decode the changed units' columns.
		n := len(chIDs)
		q := make([]prevUnitState, n)
		exists := make([]bool, n)
		preds := make([]prevUnitState, n)
		for i, id := range chIDs {
			if p, ok := c.prev[id]; ok {
				preds[i], exists[i] = p.advance(), true
			}
		}
		for _, col := range coreColumns {
			for i := 0; i < n; i++ {
				d, err := cr.sv()
				if err != nil {
					return nil, err
				}
				base := int64(0)
				if exists[i] {
					base = *col(&preds[i])
				}
				*col(&q[i]) = base + d
			}
		}

		fr := Frame{Frame: int32(frame), TimeSec: float32(frame) / simFPS}

		if xr != nil {
			nr, err := xr.uv()
			if err != nil {
				return nil, err
			}
			fr.Resources = make([]TeamResource, nr)
			for i := range fr.Resources {
				team64, err := xr.sv()
				if err != nil {
					return nil, err
				}
				team := int32(team64)
				p := c.prevRes[team]
				var d [6]int64
				for j := range d {
					if d[j], err = xr.sv(); err != nil {
						return nil, err
					}
				}
				cur := prevResState{m: p.m + d[0], e: p.e + d[1], ms: p.ms + d[2], es: p.es + d[3], mi: p.mi + d[4], ei: p.ei + d[5]}
				c.prevRes[team] = cur
				fr.Resources[i] = TeamResource{
					Team:  team,
					Metal: float32(cur.m) / resScale, Energy: float32(cur.e) / resScale,
					MetalStorage: float32(cur.ms) / resScale, EnergyStorage: float32(cur.es) / resScale,
					MetalIncome: float32(cur.mi) / resScale, EnergyIncome: float32(cur.ei) / resScale,
				}
			}
		}

		// Assemble the next state: survivors advance, changed units override.
		next := make(map[int32]prevUnitState, len(c.prev)+n)
		for id, p := range c.prev {
			next[id] = p.advance()
		}
		for _, id := range dead {
			if _, ok := next[id]; !ok {
				return nil, fmt.Errorf("snapshot: frame %d: dead unit %d was not alive", frame, id)
			}
			delete(next, id)
		}
		for i, id := range chIDs {
			next[id] = q[i]
		}
		c.prev = next

		// Materialise the full frame, sorted by id.
		ids := make([]int32, 0, len(next))
		for id := range next {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		fr.Units = make([]UnitState, len(ids))
		for i, id := range ids {
			s := next[id]
			fr.Units[i] = UnitState{
				UnitID: id, DefID: int32(s.def), Team: int32(s.team),
				Pos:    Vec3{X: float32(s.x), Z: float32(s.z)},
				Health: float32(s.hp), MaxHealth: float32(s.maxHp),
				VelX: float32(s.dvx) / se, VelZ: float32(s.dvz) / se,
				BuildProgress: float32(s.build) / buildScale,
				TargetID:      int32(s.target),
			}
		}
		frames = append(frames, fr)
	}
	return frames, nil
}

// ---------------------------------------------------------------------------
// event codec

func encodeEvents(events []Event) []byte {
	var buf bytes.Buffer
	vw := &varintWriter{w: &buf}
	vw.uv(uint64(len(events)))
	// Kind string table (order of first appearance), then one column at a time.
	kindIdx := map[EventKind]uint64{}
	var kinds []EventKind
	for _, e := range events {
		if _, ok := kindIdx[e.Kind]; !ok {
			kindIdx[e.Kind] = uint64(len(kinds))
			kinds = append(kinds, e.Kind)
		}
	}
	vw.uv(uint64(len(kinds)))
	for _, k := range kinds {
		vw.uv(uint64(len(k)))
		buf.WriteString(string(k))
	}
	prevFrame := int64(0)
	for _, e := range events {
		vw.sv(int64(e.Frame) - prevFrame)
		prevFrame = int64(e.Frame)
	}
	for _, e := range events {
		vw.uv(kindIdx[e.Kind])
	}
	prevID := int64(0)
	for _, e := range events {
		vw.sv(int64(e.UnitID) - prevID)
		prevID = int64(e.UnitID)
	}
	for _, e := range events {
		vw.sv(int64(e.DefID))
	}
	for _, e := range events {
		vw.sv(int64(e.Team))
	}
	// v6: the cause columns, -1 where an event has none. Readers detect them
	// by the bytes left after the team column, so the section needs no flag
	// of its own and a v5 section (which ends there) reads unchanged.
	cause := func(e Event) EventCause {
		if e.Cause == nil {
			return EventCause{UnitID: -1, DefID: -1, Team: -1, WeaponDef: -1}
		}
		return *e.Cause
	}
	for _, e := range events {
		vw.sv(int64(cause(e).UnitID))
	}
	for _, e := range events {
		vw.sv(int64(cause(e).DefID))
	}
	for _, e := range events {
		vw.sv(int64(cause(e).Team))
	}
	for _, e := range events {
		vw.sv(int64(cause(e).WeaponDef))
	}
	return buf.Bytes()
}

func decodeEvents(b []byte) ([]Event, error) {
	vr := &varintReader{b: b}
	n64, err := vr.uv()
	if err != nil {
		return nil, err
	}
	n := int(n64)
	nk, err := vr.uv()
	if err != nil {
		return nil, err
	}
	kinds := make([]EventKind, nk)
	for i := range kinds {
		l, err := vr.uv()
		if err != nil {
			return nil, err
		}
		if vr.p+int(l) > len(vr.b) {
			return nil, fmt.Errorf("snapshot: truncated event kind table")
		}
		kinds[i] = EventKind(vr.b[vr.p : vr.p+int(l)])
		vr.p += int(l)
	}
	events := make([]Event, n)
	prev := int64(0)
	for i := 0; i < n; i++ {
		d, err := vr.sv()
		if err != nil {
			return nil, err
		}
		prev += d
		events[i].Frame = int32(prev)
	}
	for i := 0; i < n; i++ {
		k, err := vr.uv()
		if err != nil {
			return nil, err
		}
		if int(k) >= len(kinds) {
			return nil, fmt.Errorf("snapshot: event kind index %d out of range", k)
		}
		events[i].Kind = kinds[k]
	}
	prev = 0
	for i := 0; i < n; i++ {
		d, err := vr.sv()
		if err != nil {
			return nil, err
		}
		prev += d
		events[i].UnitID = int32(prev)
	}
	for i := 0; i < n; i++ {
		v, err := vr.sv()
		if err != nil {
			return nil, err
		}
		events[i].DefID = int32(v)
	}
	for i := 0; i < n; i++ {
		v, err := vr.sv()
		if err != nil {
			return nil, err
		}
		events[i].Team = int32(v)
	}
	if vr.done() {
		return events, nil // v5: no cause columns
	}
	cause := make([][4]int64, n)
	for c := 0; c < 4; c++ {
		for i := 0; i < n; i++ {
			v, err := vr.sv()
			if err != nil {
				return nil, err
			}
			cause[i][c] = v
		}
	}
	for i := range events {
		c := cause[i]
		if c[0] < 0 && c[1] < 0 && c[2] < 0 && c[3] < 0 {
			continue
		}
		events[i].Cause = &EventCause{UnitID: int32(c[0]), DefID: int32(c[1]), Team: int32(c[2]), WeaponDef: int32(c[3])}
	}
	return events, nil
}

// ---------------------------------------------------------------------------
// comm codec
//
// Same columnar shape as the events codec — a count, string tables for the two
// small enumerations (kind, chat destination), then one column at a time — with
// two differences that matter for the volume: positions are quantized to whole
// elmos (a map mark needs no sub-elmo precision) and DELTA-coded against the
// previous comm, and a line's far end is delta-coded against its OWN near end.
// Freehand drawing is the bulk of any real capture and arrives as runs of short
// segments walking across the map, so both deltas are tiny there; a chat
// message or a lone marker pays a few bytes for the position columns it does
// not use.

// commStrings writes a length-prefixed string table.
func writeStringTable(vw *varintWriter, buf *bytes.Buffer, vals []string) {
	vw.uv(uint64(len(vals)))
	for _, s := range vals {
		vw.uv(uint64(len(s)))
		buf.WriteString(s)
	}
}

func readStringTable(vr *varintReader) ([]string, error) {
	n, err := vr.uv()
	if err != nil {
		return nil, err
	}
	out := make([]string, n)
	for i := range out {
		l, err := vr.uv()
		if err != nil {
			return nil, err
		}
		if vr.p+int(l) > len(vr.b) {
			return nil, fmt.Errorf("snapshot: truncated string table")
		}
		out[i] = string(vr.b[vr.p : vr.p+int(l)])
		vr.p += int(l)
	}
	return out, nil
}

// intern adds s to tab/idx if new and returns its index.
func intern(idx map[string]uint64, tab *[]string, s string) uint64 {
	if i, ok := idx[s]; ok {
		return i
	}
	i := uint64(len(*tab))
	idx[s] = i
	*tab = append(*tab, s)
	return i
}

func encodeComms(comms []Comm) []byte {
	var buf bytes.Buffer
	vw := &varintWriter{w: &buf}
	vw.uv(uint64(len(comms)))

	kindIdx, destIdx := map[string]uint64{}, map[string]uint64{}
	var kinds, dests []string
	kindOf := make([]uint64, len(comms))
	destOf := make([]uint64, len(comms))
	for i, c := range comms {
		kindOf[i] = intern(kindIdx, &kinds, string(c.Kind))
		destOf[i] = intern(destIdx, &dests, c.Dest)
	}
	writeStringTable(vw, &buf, kinds)
	writeStringTable(vw, &buf, dests)

	prevFrame := int64(0)
	for _, c := range comms {
		vw.sv(int64(c.Frame) - prevFrame)
		prevFrame = int64(c.Frame)
	}
	for _, k := range kindOf {
		vw.uv(k)
	}
	for _, d := range destOf {
		vw.uv(d)
	}
	for _, c := range comms {
		vw.sv(int64(c.PlayerID))
	}
	prevX, prevZ := int64(0), int64(0)
	for _, c := range comms {
		x, z := roundq(c.X), roundq(c.Z)
		vw.sv(x - prevX)
		vw.sv(z - prevZ)
		vw.sv(roundq(c.X2) - x)
		vw.sv(roundq(c.Z2) - z)
		prevX, prevZ = x, z
	}
	for _, c := range comms {
		vw.uv(uint64(len(c.Text)))
		buf.WriteString(c.Text)
	}
	for _, c := range comms {
		vw.uv(uint64(len(c.Name)))
		buf.WriteString(c.Name)
	}
	return buf.Bytes()
}

func decodeComms(b []byte) ([]Comm, error) {
	vr := &varintReader{b: b}
	n64, err := vr.uv()
	if err != nil {
		return nil, err
	}
	n := int(n64)
	kinds, err := readStringTable(vr)
	if err != nil {
		return nil, err
	}
	dests, err := readStringTable(vr)
	if err != nil {
		return nil, err
	}
	comms := make([]Comm, n)
	prev := int64(0)
	for i := 0; i < n; i++ {
		d, err := vr.sv()
		if err != nil {
			return nil, err
		}
		prev += d
		comms[i].Frame = int32(prev)
	}
	for i := 0; i < n; i++ {
		k, err := vr.uv()
		if err != nil {
			return nil, err
		}
		if int(k) >= len(kinds) {
			return nil, fmt.Errorf("snapshot: comm kind index %d out of range", k)
		}
		comms[i].Kind = CommKind(kinds[k])
	}
	for i := 0; i < n; i++ {
		d, err := vr.uv()
		if err != nil {
			return nil, err
		}
		if int(d) >= len(dests) {
			return nil, fmt.Errorf("snapshot: comm dest index %d out of range", d)
		}
		comms[i].Dest = dests[d]
	}
	for i := 0; i < n; i++ {
		v, err := vr.sv()
		if err != nil {
			return nil, err
		}
		comms[i].PlayerID = int32(v)
	}
	prevX, prevZ := int64(0), int64(0)
	for i := 0; i < n; i++ {
		dx, err := vr.sv()
		if err != nil {
			return nil, err
		}
		dz, err := vr.sv()
		if err != nil {
			return nil, err
		}
		dx2, err := vr.sv()
		if err != nil {
			return nil, err
		}
		dz2, err := vr.sv()
		if err != nil {
			return nil, err
		}
		x, z := prevX+dx, prevZ+dz
		comms[i].X, comms[i].Z = float32(x), float32(z)
		comms[i].X2, comms[i].Z2 = float32(x+dx2), float32(z+dz2)
		prevX, prevZ = x, z
	}
	for _, col := range []func(i int, s string){
		func(i int, s string) { comms[i].Text = s },
		func(i int, s string) { comms[i].Name = s },
	} {
		for i := 0; i < n; i++ {
			l, err := vr.uv()
			if err != nil {
				return nil, err
			}
			if vr.p+int(l) > len(vr.b) {
				return nil, fmt.Errorf("snapshot: truncated comm string column")
			}
			col(i, string(vr.b[vr.p:vr.p+int(l)]))
			vr.p += int(l)
		}
	}
	return comms, nil
}

// ---------------------------------------------------------------------------
// gzip helpers

// Sections compress at gzip's default level: on real capture data
// BestCompression is >10x slower for <2% size (measured 9.35 vs 9.20 MB on a
// 38 MB frame stream, 1.5s vs 17s).
func gzipCompress(b []byte) []byte {
	var buf bytes.Buffer
	gz, _ := gzip.NewWriterLevel(&buf, gzip.DefaultCompression)
	gz.Write(b)
	gz.Close()
	return buf.Bytes()
}

func gunzip(b []byte) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	return io.ReadAll(gz)
}

// ---------------------------------------------------------------------------
// writer

// brpWriter implements Writer: frames buffer until a chunk fills, each chunk
// is encoded with fresh codec state (its first frame becomes the keyframe).
// Core keyframe bytes accumulate RAW in keysBuf (gzipped once, as the K
// section, at Close); delta frames are gzipped per chunk into the growing F/X
// payloads. The container is assembled at Close.
type brpWriter struct {
	path        string
	meta        Meta
	chunkFrames int

	pending           []Frame      // frames of the not-yet-flushed chunk
	keysBuf           bytes.Buffer // raw concatenated core keyframes -> K
	coreBuf, extraBuf bytes.Buffer
	chunks            []BRPChunk

	events      []Event
	comms       []Comm
	facts       []Fact
	damage      []DamageWindow
	lives       []UnitLife
	visibility  []Visibility
	bounds      BRPBounds
	anyUnit     bool
	frameTeams  map[int32]bool
	frames      int
	unitRecords int64
}

// NewBRPWriter creates dir if needed and returns a Writer producing
// "<gameID>.brp". The file is written in one piece at Close.
func NewBRPWriter(dir, gameID string) (Writer, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &brpWriter{
		path:        filepath.Join(dir, gameID+".brp"),
		chunkFrames: defaultChunkFrames,
		frameTeams:  map[int32]bool{},
		bounds:      BRPBounds{MinX: math.Inf(1), MaxX: math.Inf(-1), MinZ: math.Inf(1), MaxZ: math.Inf(-1)},
	}, nil
}

func (w *brpWriter) WriteMeta(m Meta) error {
	w.meta = m
	return nil
}

func (w *brpWriter) WriteFrame(fr Frame) error {
	w.pending = append(w.pending, fr)
	if len(w.pending) >= w.chunkFrames {
		w.flushChunk()
	}
	return nil
}

// flushChunk encodes the pending frames as one chunk: fresh codec state
// (first frame all-absolute = keyframe). The core keyframe bytes go raw into
// keysBuf (the future K section); the core delta frames are gzipped into the
// F payload; the extra stream keeps its keyframe+delta gzip pair in X.
func (w *brpWriter) flushChunk() {
	if len(w.pending) == 0 {
		return
	}
	codec := newFrameCodec(w.meta.SampleEvery)
	var coreKey, coreRest, extraKey, extraRest bytes.Buffer
	encode := func(core, extra *bytes.Buffer, fr Frame) {
		q := codec.encodeFrame(&varintWriter{w: core}, &varintWriter{w: extra}, fr)
		for _, u := range q {
			w.anyUnit = true
			w.bounds.MinX = math.Min(w.bounds.MinX, float64(u.x))
			w.bounds.MaxX = math.Max(w.bounds.MaxX, float64(u.x))
			w.bounds.MinZ = math.Min(w.bounds.MinZ, float64(u.z))
			w.bounds.MaxZ = math.Max(w.bounds.MaxZ, float64(u.z))
			w.frameTeams[int32(u.team)] = true
		}
		w.unitRecords += int64(len(q))
	}
	encode(&coreKey, &extraKey, w.pending[0])
	for _, fr := range w.pending[1:] {
		encode(&coreRest, &extraRest, fr)
	}

	c := BRPChunk{
		Frame: w.pending[0].Frame,
		Count: len(w.pending),
		KOff:  int64(w.keysBuf.Len()),
		KLen:  int64(coreKey.Len()),
		FOff:  int64(w.coreBuf.Len()),
		XOff:  int64(w.extraBuf.Len()),
	}
	w.keysBuf.Write(coreKey.Bytes())
	w.extraBuf.Write(gzipCompress(extraKey.Bytes()))
	c.XKeyLen = int64(w.extraBuf.Len()) - c.XOff
	if len(w.pending) > 1 {
		w.coreBuf.Write(gzipCompress(coreRest.Bytes()))
		w.extraBuf.Write(gzipCompress(extraRest.Bytes()))
	}
	c.FLen = int64(w.coreBuf.Len()) - c.FOff
	c.XLen = int64(w.extraBuf.Len()) - c.XOff

	w.chunks = append(w.chunks, c)
	w.frames += len(w.pending)
	w.pending = w.pending[:0]
}

func (w *brpWriter) WriteEvent(e Event) error {
	w.events = append(w.events, e)
	w.frameTeams[e.Team] = true
	return nil
}

// WriteComm records one chat message or map drawing. Comms carry no team id of
// their own (the author's player record supplies it), so they never widen
// frameTeams, and they are not part of any chunk — the whole set is one small
// section written at Close.
func (w *brpWriter) WriteComm(c Comm) error {
	w.comms = append(w.comms, c)
	return nil
}

func (w *brpWriter) WriteFact(f Fact) error {
	w.facts = append(w.facts, f)
	return nil
}

func (w *brpWriter) WriteDamage(d DamageWindow) error {
	w.damage = append(w.damage, d)
	return nil
}

func (w *brpWriter) WriteLife(l UnitLife) error {
	w.lives = append(w.lives, l)
	return nil
}

func (w *brpWriter) WriteVisibility(v Visibility) error {
	w.visibility = append(w.visibility, v)
	return nil
}

func (w *brpWriter) Close() error {
	w.flushChunk()

	rec := brpMetaRecord{
		Meta:        w.meta,
		Frames:      w.frames,
		Events:      len(w.events),
		Comms:       len(w.comms),
		UnitRecords: w.unitRecords,

		Facts:         len(w.facts),
		DamageWindows: len(w.damage),
		Lives:         len(w.lives),
		Visibility:    len(w.visibility),
		ChunkFrames:   w.chunkFrames,
		Chunks:        w.chunks,
	}
	if w.anyUnit {
		b := w.bounds
		rec.Bounds = &b
	}
	teams := make([]int32, 0, len(w.frameTeams))
	for t := range w.frameTeams {
		teams = append(teams, t)
	}
	sort.Slice(teams, func(i, j int) bool { return teams[i] < teams[j] })
	rec.FrameTeams = teams

	// The sections the browser needs before it can draw anything (events,
	// comms) come straight after the meta, so the viewer's first Range read
	// — the head of the file — usually covers all three; the bulk frame data
	// follows. Comms are optional: a capture from a widget that never
	// recorded them (or a game where nobody spoke or drew) writes no section
	// at all, which is also what every .brp from before they existed looks
	// like.
	data := []Section{{Tag: SecEvents, Payload: gzipCompress(encodeEvents(w.events))}}
	if len(w.comms) > 0 {
		data = append(data, Section{Tag: SecComms, Payload: gzipCompress(encodeComms(w.comms))})
	}
	data = append(data,
		Section{Tag: SecKeyframes, Payload: gzipCompress(w.keysBuf.Bytes())},
		Section{Tag: SecFrames, Payload: w.coreBuf.Bytes()},
		Section{Tag: SecExtra, Payload: w.extraBuf.Bytes()},
	)
	// The analysis sections (v6) exist only when recorded — which only a
	// re-simulation does — and the browser fetches none of them, so they go
	// last, past everything the viewer reads.
	if len(w.facts) > 0 {
		data = append(data, Section{Tag: SecFacts, Payload: gzipCompress(encodeFacts(w.facts))})
	}
	if len(w.damage) > 0 {
		data = append(data, Section{Tag: SecDamage, Payload: gzipCompress(encodeDamage(w.damage))})
	}
	if len(w.lives) > 0 {
		data = append(data, Section{Tag: SecLives, Payload: gzipCompress(encodeLives(w.lives))})
	}
	if len(w.visibility) > 0 {
		data = append(data, Section{Tag: SecVisibility, Payload: gzipCompress(encodeVisibility(w.visibility))})
	}
	rec.Sections = sectionLayout(data)

	metaJSON, err := json.Marshal(rec)
	if err != nil {
		return err
	}

	f, err := os.Create(w.path)
	if err != nil {
		return err
	}
	sections := append([]Section{{Tag: SecMeta, Payload: gzipCompress(metaJSON)}}, data...)
	if err := WriteContainer(f, BRPMagic, BRPVersion, sections); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// ---------------------------------------------------------------------------
// reader

// ParseBRP reads the container and decodes only the meta section (including
// the chunk index), leaving the data sections compressed — the basis for
// pass-through chunk serving and random access.
func ParseBRP(r io.Reader) (*BRPFile, error) {
	version, sections, err := ReadContainer(r, BRPMagic)
	if err != nil {
		return nil, err
	}
	if version < BRPMinVersion || version > BRPVersion {
		return nil, fmt.Errorf("snapshot: unsupported .brp version %d (want %d..%d)", version, BRPMinVersion, BRPVersion)
	}
	f := &BRPFile{Version: version, Sections: map[byte][]byte{}, SectionOffsets: map[byte]int64{}}
	for _, s := range sections {
		f.Sections[s.Tag] = s.Payload
		f.SectionOffsets[s.Tag] = s.Offset
	}
	m, ok := f.Sections[SecMeta]
	if !ok {
		return nil, fmt.Errorf("snapshot: .brp has no meta section")
	}
	metaJSON, err := gunzip(m)
	if err != nil {
		return nil, fmt.Errorf("snapshot: meta section: %w", err)
	}
	var rec brpMetaRecord
	if err := json.Unmarshal(metaJSON, &rec); err != nil {
		return nil, fmt.Errorf("snapshot: meta section: %w", err)
	}
	f.Meta = rec.Meta
	f.Bounds = rec.Bounds
	f.FrameTeams = rec.FrameTeams
	f.FrameCount = rec.Frames
	f.EventCount = rec.Events
	f.CommCount = rec.Comms
	f.UnitRecords = rec.UnitRecords
	f.ChunkFrames = rec.ChunkFrames
	f.Chunks = rec.Chunks
	return f, nil
}

// IndexBRP copies the .brp container read from r to w, adding the section
// layout (brpMetaRecord.Sections) to its meta record when the file was written
// before it existed. It is what makes ANY .brp publishable: the viewer reads a
// published file by Range requests and needs the layout to find its sections.
// A file that already carries a layout is rewritten unchanged (and refused if
// that layout does not describe the file), so publishing a fresh capture
// uploads exactly the bytes the writer produced. Meta fields this reader does
// not know are kept.
func IndexBRP(r io.Reader, w io.Writer) error {
	version, sections, err := ReadContainer(r, BRPMagic)
	if err != nil {
		return err
	}
	if version != BRPVersion {
		return fmt.Errorf("snapshot: unsupported .brp version %d (want %d)", version, BRPVersion)
	}
	if len(sections) == 0 || sections[0].Tag != SecMeta {
		return fmt.Errorf("snapshot: .brp meta is not the first section")
	}
	metaJSON, err := gunzip(sections[0].Payload)
	if err != nil {
		return fmt.Errorf("snapshot: meta section: %w", err)
	}
	var rec map[string]json.RawMessage
	if err := json.Unmarshal(metaJSON, &rec); err != nil {
		return fmt.Errorf("snapshot: meta section: %w", err)
	}
	layout := sectionLayout(sections[1:])
	if have, ok := rec["sections"]; ok {
		var got []BRPSectionLen
		if err := json.Unmarshal(have, &got); err != nil {
			return fmt.Errorf("snapshot: meta section layout: %w", err)
		}
		if len(got) != len(layout) {
			return fmt.Errorf("snapshot: meta section layout lists %d sections, file has %d", len(got), len(layout))
		}
		for i := range got {
			if got[i] != layout[i] {
				return fmt.Errorf("snapshot: meta section layout entry %d is %+v, file has %+v", i, got[i], layout[i])
			}
		}
	} else {
		b, err := json.Marshal(layout)
		if err != nil {
			return err
		}
		rec["sections"] = b
		if metaJSON, err = json.Marshal(rec); err != nil {
			return err
		}
		sections[0].Payload = gzipCompress(metaJSON)
	}
	return WriteContainer(w, BRPMagic, version, sections)
}

// chunkSlice extracts and decompresses one gzip stream out of a section
// payload.
func chunkSlice(sec []byte, off, length int64, what string) ([]byte, error) {
	if off < 0 || length < 0 || off+length > int64(len(sec)) {
		return nil, fmt.Errorf("snapshot: %s range [%d,+%d) outside section (%d bytes)", what, off, length, len(sec))
	}
	raw, err := gunzip(sec[off : off+length])
	if err != nil {
		return nil, fmt.Errorf("snapshot: %s: %w", what, err)
	}
	return raw, nil
}

// Keyframes returns the decompressed K section (every chunk's core keyframe,
// concatenated; chunk i's slice is [KOff, KOff+KLen)), gunzipping it once and
// caching the result.
func (f *BRPFile) Keyframes() ([]byte, error) {
	if f.keysRaw != nil {
		return f.keysRaw, nil
	}
	sec, ok := f.Sections[SecKeyframes]
	if !ok {
		return nil, fmt.Errorf("snapshot: .brp has no keyframes section")
	}
	raw, err := gunzip(sec)
	if err != nil {
		return nil, fmt.Errorf("snapshot: keyframes section: %w", err)
	}
	f.keysRaw = raw
	return raw, nil
}

// DecodeChunk decodes chunk i into frames — the random-access entry point: it
// touches only chunk i's keyframe (in K) and delta bytes. Values come back at
// the format's storage precision (whole elmos, per-interval velocity, 1/255
// build progress, 1/10 resources); TimeSec is frame/30. Units are sorted by
// id.
func (f *BRPFile) DecodeChunk(i int) ([]Frame, error) {
	if i < 0 || i >= len(f.Chunks) {
		return nil, fmt.Errorf("snapshot: chunk %d out of range (%d chunks)", i, len(f.Chunks))
	}
	c := f.Chunks[i]
	keys, err := f.Keyframes()
	if err != nil {
		return nil, err
	}
	if c.KOff < 0 || c.KLen < 0 || c.KOff+c.KLen > int64(len(keys)) {
		return nil, fmt.Errorf("snapshot: chunk %d keyframe range [%d,+%d) outside K (%d bytes)", i, c.KOff, c.KLen, len(keys))
	}
	key := keys[c.KOff : c.KOff+c.KLen]

	fsec, ok := f.Sections[SecFrames]
	if !ok {
		return nil, fmt.Errorf("snapshot: .brp has no frames section")
	}
	var deltas []byte
	if c.FLen > 0 {
		if deltas, err = chunkSlice(fsec, c.FOff, c.FLen, "chunk deltas"); err != nil {
			return nil, err
		}
	}
	var extraKey, extraDeltas []byte
	if xsec, ok := f.Sections[SecExtra]; ok {
		if extraKey, err = chunkSlice(xsec, c.XOff, c.XKeyLen, "chunk extra keyframe"); err != nil {
			return nil, err
		}
		if c.XLen > c.XKeyLen {
			if extraDeltas, err = chunkSlice(xsec, c.XOff+c.XKeyLen, c.XLen-c.XKeyLen, "chunk extra deltas"); err != nil {
				return nil, err
			}
		}
	}

	// The keyframe and the delta frames run through the SAME codec: the
	// keyframe (encoded against empty state) establishes the prediction state
	// the delta frames were encoded against.
	codec := newFrameCodec(f.Meta.SampleEvery)
	frames, err := decodeFrames(codec, key, extraKey)
	if err != nil {
		return nil, err
	}
	if len(deltas) > 0 {
		rest, err := decodeFrames(codec, deltas, extraDeltas)
		if err != nil {
			return nil, err
		}
		frames = append(frames, rest...)
	}
	if len(frames) != c.Count {
		return nil, fmt.Errorf("snapshot: chunk %d decoded %d frames, index says %d", i, len(frames), c.Count)
	}
	return frames, nil
}

// Comms decodes the C section: everything the capture's players wrote or drew.
// Absent section (an older capture, or a game with none) yields nil, not an
// error. It is deliberately NOT part of ReadBRP's return: comms are a small
// side channel most consumers of the frame data have no use for.
func (f *BRPFile) Comms() ([]Comm, error) {
	sec, ok := f.Sections[SecComms]
	if !ok {
		return nil, nil
	}
	b, err := gunzip(sec)
	if err != nil {
		return nil, fmt.Errorf("snapshot: comms section: %w", err)
	}
	return decodeComms(b)
}

// ReadBRP decodes a .brp capture's meta, frames (every chunk in order) and
// events. Chat and map drawings are read separately, via
// ParseBRP(...).Comms().
func ReadBRP(r io.Reader) (Meta, []Frame, []Event, error) {
	f, err := ParseBRP(r)
	if err != nil {
		return Meta{}, nil, nil, err
	}
	var frames []Frame
	for i := range f.Chunks {
		fs, err := f.DecodeChunk(i)
		if err != nil {
			return f.Meta, nil, nil, err
		}
		frames = append(frames, fs...)
	}
	var events []Event
	if sec, ok := f.Sections[SecEvents]; ok {
		b, err := gunzip(sec)
		if err != nil {
			return f.Meta, nil, nil, fmt.Errorf("snapshot: events section: %w", err)
		}
		if events, err = decodeEvents(b); err != nil {
			return f.Meta, nil, nil, err
		}
	}
	return f.Meta, frames, events, nil
}
