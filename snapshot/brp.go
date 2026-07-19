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
//	"BRP1" <version u8 = 4> then per section: <tag u8> <len u32le> <payload>
//
//	M  meta JSON: {"meta": <Meta>, "bounds", "frameTeams", "chunks" index, counts}
//	K  ALL core keyframes, one gzip stream (keys-first streaming + skimming)
//	F  core delta frames, chunked: id def team x z hp maxHp dvx dvz
//	X  extra: build + team resources (keyframe+delta per chunk; never sent to a browser)
//	E  lifecycle events
//
// The M, K and E payloads are single gzip streams. The F and X payloads are a
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
// (never sent to a browser) keeps its keyframe+delta split per chunk.
//
// The M record's "chunks" array indexes everything: first sim frame, sample
// count, the keyframe's raw range in K, and the delta byte ranges (offsets
// RELATIVE to the owning section's payload start; a section's absolute file
// offset is reported by ReadContainer, so range-based consumers can add the
// two).
//
// Chunks are separately gzipped ON PURPOSE: the viz server (and the static
// bundle for R2 hosting) hands individual chunk byte ranges, the K payload,
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
//	8 core columns × nChanged   def team x z hp maxHp dvx dvz
//	(X stream) build × nChanged, then team resources
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
// as zero. "Changed" is judged across all stored columns including build, so
// the X stream's build column always covers exactly the F stream's changed
// list. Decoders must mirror this exactly; the JS decoder lives in
// worker/public/app.js — evolve them together.

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
// ("BRW1"). Section order in a file is fixed (M, F, X, E) but readers accept
// any order and skip unknown tags.
const (
	BRPMagic = "BRP1"
	BRWMagic = "BRW1"

	// BRPVersion is the only readable format version. v1 (unchunked), v2
	// (every live unit re-encoded per frame, y/dvy columns) and v3 (keyframes
	// inside the chunks) existed only pre-release and are not supported —
	// regenerate a .brp from its source .brsnap/.brepstream with pack.
	BRPVersion byte = 4

	SecMeta      byte = 'M' // .brp: meta JSON
	SecKeyframes byte = 'K' // all core keyframes, one gzip stream
	SecFrames    byte = 'F' // core delta frames, chunked
	SecExtra     byte = 'X' // extra frame columns (not sent to the browser)
	SecEvents    byte = 'E' // lifecycle events
	SecCommands  byte = 'C' // per-unit command state, chunked (optional; absent when the capture has none)
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
	// COff/CKeyLen/CLen locate the chunk's command state in the optional C
	// section, in the same keyframe+delta gzip-pair shape as X. All zero (and
	// omitted from the JSON) when the capture carries no commands — the C
	// section is then absent and files stay byte-identical to pre-command
	// output.
	COff    int64 `json:"cOff,omitempty"`
	CKeyLen int64 `json:"cKeyLen,omitempty"`
	CLen    int64 `json:"cLen,omitempty"`
}

// brpMetaRecord is the JSON stored in the M section: the capture Meta plus
// aggregates a consumer would otherwise need a full frame scan for.
type brpMetaRecord struct {
	Meta Meta `json:"meta"`
	// Bounds of all sampled positions; nil when the capture has no units.
	Bounds *BRPBounds `json:"bounds,omitempty"`
	// FrameTeams lists every team id that appears in frames or events, so a
	// consumer can colour teams missing from Meta.Teams without scanning.
	FrameTeams  []int32    `json:"frameTeams,omitempty"`
	Frames      int        `json:"frames"`
	Events      int        `json:"events"`
	UnitRecords int64      `json:"unitRecords"`
	ChunkFrames int        `json:"chunkFrames"` // samples per chunk (last may be short)
	Chunks      []BRPChunk `json:"chunks,omitempty"`
}

// BRPFile is a parsed .brp container: the decoded meta plus the raw
// (still-compressed) sections, so consumers can slice chunks / forward E
// without re-encoding.
type BRPFile struct {
	Meta        Meta
	Bounds      *BRPBounds
	FrameTeams  []int32
	FrameCount  int
	EventCount  int
	UnitRecords int64
	ChunkFrames int
	Chunks      []BRPChunk
	Sections    map[byte][]byte // tag -> raw section payload

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
	build                                int64
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
		build: roundq(u.BuildProgress * buildScale),
	}
}

// coreColumns defines the 8 core columns' accessors in stream order. The
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
	// Extra stream: the build column for the same changed set.
	for _, i := range changed {
		base := int64(0)
		if p, ok := c.prev[units[i].UnitID]; ok {
			base = p.build
		}
		extra.sv(q[i].build - base)
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
// the matching extra stream (which cannot be decoded standalone: it relies on
// the core stream's changed list). Every live unit appears in every decoded
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
			for i := 0; i < n; i++ {
				d, err := xr.sv()
				if err != nil {
					return nil, err
				}
				base := int64(0)
				if exists[i] {
					base = preds[i].build
				}
				q[i].build = base + d
			}
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
	return events, nil
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
// command codec (the optional C section)
//
// Commands don't move, so the codec is simpler than the frame codec: the
// state is one tuple per non-idle unit, carried unchanged unless the frame
// restates it. Per frame: a cleared-id list (units whose state ends — went
// idle or died), a changed-id list, then the changed units' columns as
// ABSOLUTE values (the tuples are small and repeat; delta-coding them against
// themselves bought nothing measurable). A chunk's first frame encodes against
// empty state — the command keyframe — mirroring the core codec's chunk
// discipline, so DecodeChunk stays self-contained.

// encodeCmdFrame appends one frame's command state to vw, mutating prev (the
// shared encoder/decoder state) to exactly what a decoder reconstructs.
func encodeCmdFrame(vw *varintWriter, prev map[int32]UnitCommand, cmds []UnitCommand) {
	cur := make(map[int32]UnitCommand, len(cmds))
	ids := make([]int64, 0, len(cmds))
	for _, c := range cmds {
		cur[c.UnitID] = c
		ids = append(ids, int64(c.UnitID))
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })

	var cleared []int64
	for id := range prev {
		if _, ok := cur[id]; !ok {
			cleared = append(cleared, int64(id))
		}
	}
	sort.Slice(cleared, func(i, j int) bool { return cleared[i] < cleared[j] })
	vw.uv(uint64(len(cleared)))
	last := int64(0)
	for _, id := range cleared {
		vw.sv(id - last)
		last = id
		delete(prev, int32(id))
	}

	changed := make([]int64, 0, len(ids))
	for _, id := range ids {
		if p, ok := prev[int32(id)]; !ok || p != cur[int32(id)] {
			changed = append(changed, id)
		}
	}
	vw.uv(uint64(len(changed)))
	last = 0
	for _, id := range changed {
		vw.sv(id - last)
		last = id
	}
	for _, col := range []func(*UnitCommand) int64{
		func(c *UnitCommand) int64 { return int64(c.Cmd) },
		func(c *UnitCommand) int64 { return int64(c.TargetID) },
		func(c *UnitCommand) int64 { return int64(c.TX) },
		func(c *UnitCommand) int64 { return int64(c.TZ) },
		func(c *UnitCommand) int64 { return int64(c.Buildee) },
	} {
		for _, id := range changed {
			c := cur[int32(id)]
			vw.sv(col(&c))
		}
	}
	for _, id := range changed {
		prev[int32(id)] = cur[int32(id)]
	}
}

// decodeCmdFrames decodes n frames' command state from b, carrying prev across
// frames, and returns each frame's full (reconstructed) sorted command list.
func decodeCmdFrames(b []byte, prev map[int32]UnitCommand, n int) ([][]UnitCommand, error) {
	vr := &varintReader{b: b}
	readIDs := func() ([]int32, error) {
		cnt, err := vr.uv()
		if err != nil {
			return nil, err
		}
		ids := make([]int32, cnt)
		last := int64(0)
		for i := range ids {
			d, err := vr.sv()
			if err != nil {
				return nil, err
			}
			last += d
			ids[i] = int32(last)
		}
		return ids, nil
	}
	out := make([][]UnitCommand, 0, n)
	for k := 0; k < n; k++ {
		cleared, err := readIDs()
		if err != nil {
			return nil, err
		}
		for _, id := range cleared {
			delete(prev, id)
		}
		changed, err := readIDs()
		if err != nil {
			return nil, err
		}
		rows := make([]UnitCommand, len(changed))
		for i, id := range changed {
			rows[i].UnitID = id
		}
		for _, col := range []func(*UnitCommand, int32){
			func(c *UnitCommand, v int32) { c.Cmd = v },
			func(c *UnitCommand, v int32) { c.TargetID = v },
			func(c *UnitCommand, v int32) { c.TX = v },
			func(c *UnitCommand, v int32) { c.TZ = v },
			func(c *UnitCommand, v int32) { c.Buildee = v },
		} {
			for i := range rows {
				v, err := vr.sv()
				if err != nil {
					return nil, err
				}
				col(&rows[i], int32(v))
			}
		}
		for _, r := range rows {
			prev[r.UnitID] = r
		}
		frame := make([]UnitCommand, 0, len(prev))
		for _, c := range prev {
			frame = append(frame, c)
		}
		sort.Slice(frame, func(i, j int) bool { return frame[i].UnitID < frame[j].UnitID })
		if len(frame) == 0 {
			frame = nil
		}
		out = append(out, frame)
	}
	return out, nil
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
	cmdBuf            bytes.Buffer // command keyframe+delta gzip pairs -> C
	anyCommands       bool         // any frame carried commands; false at Close drops C
	chunks            []BRPChunk

	events      []Event
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

	// Command state: fresh codec per chunk (the first frame is the command
	// keyframe), same keyframe+delta gzip-pair shape as X. Always encoded —
	// an empty pair is ~50 bytes — but the whole section (and these chunk
	// fields) is dropped at Close when no frame ever carried commands.
	cmdCodec := map[int32]UnitCommand{}
	var cmdKey, cmdRest bytes.Buffer
	encodeCmdFrame(&varintWriter{w: &cmdKey}, cmdCodec, w.pending[0].Commands)
	for _, fr := range w.pending[1:] {
		encodeCmdFrame(&varintWriter{w: &cmdRest}, cmdCodec, fr.Commands)
	}
	for _, fr := range w.pending {
		if len(fr.Commands) > 0 {
			w.anyCommands = true
			break
		}
	}

	c := BRPChunk{
		Frame: w.pending[0].Frame,
		Count: len(w.pending),
		KOff:  int64(w.keysBuf.Len()),
		KLen:  int64(coreKey.Len()),
		FOff:  int64(w.coreBuf.Len()),
		XOff:  int64(w.extraBuf.Len()),
		COff:  int64(w.cmdBuf.Len()),
	}
	w.keysBuf.Write(coreKey.Bytes())
	w.extraBuf.Write(gzipCompress(extraKey.Bytes()))
	c.XKeyLen = int64(w.extraBuf.Len()) - c.XOff
	w.cmdBuf.Write(gzipCompress(cmdKey.Bytes()))
	c.CKeyLen = int64(w.cmdBuf.Len()) - c.COff
	if len(w.pending) > 1 {
		w.coreBuf.Write(gzipCompress(coreRest.Bytes()))
		w.extraBuf.Write(gzipCompress(extraRest.Bytes()))
		w.cmdBuf.Write(gzipCompress(cmdRest.Bytes()))
	}
	c.FLen = int64(w.coreBuf.Len()) - c.FOff
	c.XLen = int64(w.extraBuf.Len()) - c.XOff
	c.CLen = int64(w.cmdBuf.Len()) - c.COff

	w.chunks = append(w.chunks, c)
	w.frames += len(w.pending)
	w.pending = w.pending[:0]
}

func (w *brpWriter) WriteEvent(e Event) error {
	w.events = append(w.events, e)
	w.frameTeams[e.Team] = true
	return nil
}

func (w *brpWriter) Close() error {
	w.flushChunk()

	// A capture with no commands writes no C section and no cOff/cKeyLen/cLen
	// fields (omitempty) — byte-identical to pre-command output.
	if !w.anyCommands {
		w.cmdBuf.Reset()
		for i := range w.chunks {
			w.chunks[i].COff, w.chunks[i].CKeyLen, w.chunks[i].CLen = 0, 0, 0
		}
	}

	rec := brpMetaRecord{
		Meta:        w.meta,
		Frames:      w.frames,
		Events:      len(w.events),
		UnitRecords: w.unitRecords,
		ChunkFrames: w.chunkFrames,
		Chunks:      w.chunks,
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

	metaJSON, err := json.Marshal(rec)
	if err != nil {
		return err
	}

	f, err := os.Create(w.path)
	if err != nil {
		return err
	}
	sections := []Section{
		{Tag: SecMeta, Payload: gzipCompress(metaJSON)},
		{Tag: SecKeyframes, Payload: gzipCompress(w.keysBuf.Bytes())},
		{Tag: SecFrames, Payload: w.coreBuf.Bytes()},
		{Tag: SecExtra, Payload: w.extraBuf.Bytes()},
		{Tag: SecEvents, Payload: gzipCompress(encodeEvents(w.events))},
	}
	if w.anyCommands {
		sections = append(sections, Section{Tag: SecCommands, Payload: w.cmdBuf.Bytes()})
	}
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
	if version != BRPVersion {
		return nil, fmt.Errorf("snapshot: unsupported .brp version %d (want %d)", version, BRPVersion)
	}
	f := &BRPFile{Sections: map[byte][]byte{}}
	for _, s := range sections {
		f.Sections[s.Tag] = s.Payload
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
	f.UnitRecords = rec.UnitRecords
	f.ChunkFrames = rec.ChunkFrames
	f.Chunks = rec.Chunks
	return f, nil
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

	// Command state (optional C section, same keyframe+delta pair shape as X).
	if csec, ok := f.Sections[SecCommands]; ok && c.CLen > 0 {
		cmdKey, err := chunkSlice(csec, c.COff, c.CKeyLen, "chunk command keyframe")
		if err != nil {
			return nil, err
		}
		cmdState := map[int32]UnitCommand{}
		cmds, err := decodeCmdFrames(cmdKey, cmdState, 1)
		if err != nil {
			return nil, err
		}
		if c.CLen > c.CKeyLen {
			cmdDeltas, err := chunkSlice(csec, c.COff+c.CKeyLen, c.CLen-c.CKeyLen, "chunk command deltas")
			if err != nil {
				return nil, err
			}
			rest, err := decodeCmdFrames(cmdDeltas, cmdState, c.Count-1)
			if err != nil {
				return nil, err
			}
			cmds = append(cmds, rest...)
		}
		if len(cmds) != len(frames) {
			return nil, fmt.Errorf("snapshot: chunk %d decoded %d command frames, want %d", i, len(cmds), len(frames))
		}
		for k := range frames {
			frames[k].Commands = cmds[k]
		}
	}
	return frames, nil
}

// ReadBRP fully decodes a .brp capture by decoding every chunk in order.
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
