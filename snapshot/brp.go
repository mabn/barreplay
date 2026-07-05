package snapshot

// The v2 on-disk format: ".brp", a compact binary capture. It replaces JSONL as
// the default because a real game is ~500 MB of JSONL but ~13 MB of .brp — unit
// state changes very little between 1 Hz samples, so per-unit temporal deltas
// (with the unit's own velocity as the position predictor) shrink to near-zero
// varints, and gzip flattens what remains.
//
// Layout: a magic + version header, then tagged sections, each independently
// gzip-compressed:
//
//	"BRP1" <version u8> then per section: <tag u8> <len u32le> <gzip payload>
//
//	M  meta JSON: {"meta": <Meta>, "bounds": ..., "frameTeams": [...], counts}
//	F  core frame columns: id def team x z hp maxHp dvx dvz   (the viewer's data)
//	X  extra frame columns: y dvy build + team resources      (full fidelity)
//	E  lifecycle events
//
// Sections are separate gzip streams ON PURPOSE: the viz server sends the F and
// E payloads to the browser byte-for-byte (inside a "BRW1" container, same
// framing) with no server-side re-encoding, and the browser gunzips them with
// its native DecompressionStream. The X section (data the viewer doesn't use
// yet) is simply not sent. Unknown tags are skipped on read, so sections can be
// added compatibly.
//
// Values are quantized once at write time: positions/health to whole
// elmos/points, velocities to whole elmos *per sample interval* (dv =
// round(vel*sampleEvery) — exactly the displacement the viewer interpolates
// with), build progress to 1/255, resources to 1/10. Frame time is not stored
// (t = frame/30 by the engine's fixed sim rate). Units within a frame are
// sorted by id.
//
// Column encoding (all zigzag varints, one column at a time per frame): a
// unit's value is stored as a delta against the SAME unit in the previous
// sampled frame (absolute if the id is new). The x/z columns additionally add
// the previous frame's dvx/dvz to the prediction, so a unit moving at constant
// velocity encodes as zero. The id column is delta-encoded within the frame
// (ids ascend). Decoders must mirror this exactly; the JS decoder lives in
// internal/viz/web/app.js — evolve them together.

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

	SecMeta   byte = 'M' // .brp: meta JSON
	SecFrames byte = 'F' // core frame columns
	SecExtra  byte = 'X' // extra frame columns (not sent to the browser)
	SecEvents byte = 'E' // lifecycle events
	SecHead   byte = 'J' // wire payload: head JSON (viz-specific)
)

// simFPS is the engine's fixed simulation rate; frame time is derived from it.
const simFPS = 30

// buildScale quantizes BuildProgress (0..1) for storage.
const buildScale = 255

// resScale quantizes resource values (metal/energy/storage/income) to tenths.
const resScale = 10

// Section is one tagged, independently-gzipped payload of a container.
type Section struct {
	Tag     byte
	Payload []byte // still gzip-compressed
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

// ReadContainer parses a container written by WriteContainer.
func ReadContainer(r io.Reader, magic string) ([]Section, error) {
	head := make([]byte, len(magic)+1)
	if _, err := io.ReadFull(r, head); err != nil {
		return nil, fmt.Errorf("snapshot: reading container header: %w", err)
	}
	if string(head[:len(magic)]) != magic {
		return nil, fmt.Errorf("snapshot: bad magic %q (want %q)", head[:len(magic)], magic)
	}
	var sections []Section
	var hdr [5]byte
	for {
		if _, err := io.ReadFull(r, hdr[:]); err == io.EOF {
			return sections, nil
		} else if err != nil {
			return nil, fmt.Errorf("snapshot: reading section header: %w", err)
		}
		n := binary.LittleEndian.Uint32(hdr[1:])
		payload := make([]byte, n)
		if _, err := io.ReadFull(r, payload); err != nil {
			return nil, fmt.Errorf("snapshot: reading section %q: %w", hdr[0], err)
		}
		sections = append(sections, Section{Tag: hdr[0], Payload: payload})
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

// brpMetaRecord is the JSON stored in the M section: the capture Meta plus
// aggregates a consumer would otherwise need a full frame scan for.
type brpMetaRecord struct {
	Meta Meta `json:"meta"`
	// Bounds of all sampled positions; nil when the capture has no units.
	Bounds *BRPBounds `json:"bounds,omitempty"`
	// FrameTeams lists every team id that appears in frames or events, so a
	// consumer can colour teams missing from Meta.Teams without scanning.
	FrameTeams  []int32 `json:"frameTeams,omitempty"`
	Frames      int     `json:"frames"`
	Events      int     `json:"events"`
	UnitRecords int64   `json:"unitRecords"`
}

// BRPFile is a parsed .brp container: the decoded meta plus the raw
// (still-gzipped) sections, so consumers can forward F/E without re-encoding.
type BRPFile struct {
	Meta        Meta
	Bounds      *BRPBounds
	FrameTeams  []int32
	FrameCount  int
	EventCount  int
	UnitRecords int64
	Sections    map[byte][]byte // tag -> gzip payload
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
	y, dvy, build                        int64
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
		y: roundq(u.Pos.Y), dvy: roundq(u.VelY * se),
		build: roundq(u.BuildProgress * buildScale),
	}
}

// encodeFrame appends one frame to the core (F) and extra (X) streams. Units
// are sorted by id. Returns the sorted, quantized units so the writer can
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
	core.uv(uint64(len(units)))

	// id column: delta within the frame (ascending).
	last := int64(0)
	for _, u := range units {
		core.sv(int64(u.UnitID) - last)
		last = int64(u.UnitID)
	}
	// Remaining columns: delta vs the same unit in the previous frame (absolute
	// when new); x/z predict with the previous frame's velocity displacement.
	type colFn struct {
		get  func(prevUnitState) int64
		pred func(prevUnitState) int64 // base when the unit existed last frame
	}
	coreCols := []colFn{
		{get: func(s prevUnitState) int64 { return s.def }, pred: func(p prevUnitState) int64 { return p.def }},
		{get: func(s prevUnitState) int64 { return s.team }, pred: func(p prevUnitState) int64 { return p.team }},
		{get: func(s prevUnitState) int64 { return s.x }, pred: func(p prevUnitState) int64 { return p.x + p.dvx }},
		{get: func(s prevUnitState) int64 { return s.z }, pred: func(p prevUnitState) int64 { return p.z + p.dvz }},
		{get: func(s prevUnitState) int64 { return s.hp }, pred: func(p prevUnitState) int64 { return p.hp }},
		{get: func(s prevUnitState) int64 { return s.maxHp }, pred: func(p prevUnitState) int64 { return p.maxHp }},
		{get: func(s prevUnitState) int64 { return s.dvx }, pred: func(p prevUnitState) int64 { return p.dvx }},
		{get: func(s prevUnitState) int64 { return s.dvz }, pred: func(p prevUnitState) int64 { return p.dvz }},
	}
	extraCols := []colFn{
		{get: func(s prevUnitState) int64 { return s.y }, pred: func(p prevUnitState) int64 { return p.y + p.dvy }},
		{get: func(s prevUnitState) int64 { return s.dvy }, pred: func(p prevUnitState) int64 { return p.dvy }},
		{get: func(s prevUnitState) int64 { return s.build }, pred: func(p prevUnitState) int64 { return p.build }},
	}
	emit := func(vw *varintWriter, cols []colFn) {
		for _, col := range cols {
			for i, u := range units {
				base := int64(0)
				if p, ok := c.prev[u.UnitID]; ok {
					base = col.pred(p)
				}
				vw.sv(col.get(q[i]) - base)
			}
		}
	}
	emit(core, coreCols)
	emit(extra, extraCols)

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

// decodeFrames reconstructs frames from the F section and, when present, the X
// section (which cannot be decoded standalone: it relies on F's ids/order).
func decodeFrames(core, extra []byte, sampleEvery int32) ([]Frame, error) {
	c := newFrameCodec(sampleEvery)
	se := float32(c.sampleEvery)
	cr := &varintReader{b: core}
	var xr *varintReader
	if extra != nil {
		xr = &varintReader{b: extra}
	}
	var frames []Frame
	for !cr.done() {
		fd, err := cr.sv()
		if err != nil {
			return nil, err
		}
		frame := c.prevFrame + fd
		c.prevFrame = frame
		n64, err := cr.uv()
		if err != nil {
			return nil, err
		}
		n := int(n64)
		ids := make([]int32, n)
		last := int64(0)
		for i := 0; i < n; i++ {
			d, err := cr.sv()
			if err != nil {
				return nil, err
			}
			last += d
			ids[i] = int32(last)
		}
		q := make([]prevUnitState, n)
		exists := make([]bool, n)
		prevs := make([]prevUnitState, n)
		for i, id := range ids {
			prevs[i], exists[i] = c.prev[id]
		}
		readCol := func(vr *varintReader, set func(i int, v int64), pred func(p prevUnitState) int64) error {
			for i := 0; i < n; i++ {
				d, err := vr.sv()
				if err != nil {
					return err
				}
				base := int64(0)
				if exists[i] {
					base = pred(prevs[i])
				}
				set(i, base+d)
			}
			return nil
		}
		coreCols := []struct {
			set  func(i int, v int64)
			pred func(p prevUnitState) int64
		}{
			{func(i int, v int64) { q[i].def = v }, func(p prevUnitState) int64 { return p.def }},
			{func(i int, v int64) { q[i].team = v }, func(p prevUnitState) int64 { return p.team }},
			{func(i int, v int64) { q[i].x = v }, func(p prevUnitState) int64 { return p.x + p.dvx }},
			{func(i int, v int64) { q[i].z = v }, func(p prevUnitState) int64 { return p.z + p.dvz }},
			{func(i int, v int64) { q[i].hp = v }, func(p prevUnitState) int64 { return p.hp }},
			{func(i int, v int64) { q[i].maxHp = v }, func(p prevUnitState) int64 { return p.maxHp }},
			{func(i int, v int64) { q[i].dvx = v }, func(p prevUnitState) int64 { return p.dvx }},
			{func(i int, v int64) { q[i].dvz = v }, func(p prevUnitState) int64 { return p.dvz }},
		}
		for _, col := range coreCols {
			if err := readCol(cr, col.set, col.pred); err != nil {
				return nil, err
			}
		}

		fr := Frame{Frame: int32(frame), TimeSec: float32(frame) / simFPS}
		fr.Units = make([]UnitState, n)

		if xr != nil {
			extraCols := []struct {
				set  func(i int, v int64)
				pred func(p prevUnitState) int64
			}{
				{func(i int, v int64) { q[i].y = v }, func(p prevUnitState) int64 { return p.y + p.dvy }},
				{func(i int, v int64) { q[i].dvy = v }, func(p prevUnitState) int64 { return p.dvy }},
				{func(i int, v int64) { q[i].build = v }, func(p prevUnitState) int64 { return p.build }},
			}
			for _, col := range extraCols {
				if err := readCol(xr, col.set, col.pred); err != nil {
					return nil, err
				}
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

		next := make(map[int32]prevUnitState, n)
		for i := range q {
			fr.Units[i] = UnitState{
				UnitID: ids[i], DefID: int32(q[i].def), Team: int32(q[i].team),
				Pos:    Vec3{X: float32(q[i].x), Y: float32(q[i].y), Z: float32(q[i].z)},
				Health: float32(q[i].hp), MaxHealth: float32(q[i].maxHp),
				VelX: float32(q[i].dvx) / se, VelY: float32(q[i].dvy) / se, VelZ: float32(q[i].dvz) / se,
				BuildProgress: float32(q[i].build) / buildScale,
			}
			next[ids[i]] = q[i]
		}
		c.prev = next
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

// EncodeFramesSection encodes frames into a gzip-compressed F-section payload.
// Used by consumers (the viz server) that need to serve a legacy capture in
// wire form; NewBRPWriter uses the same codec internally.
func EncodeFramesSection(frames []Frame, sampleEvery int32) []byte {
	var core, extra bytes.Buffer
	cw := &varintWriter{w: &core}
	xw := &varintWriter{w: &extra}
	c := newFrameCodec(sampleEvery)
	for _, fr := range frames {
		c.encodeFrame(cw, xw, fr)
	}
	return gzipCompress(core.Bytes())
}

// EncodeEventsSection encodes events into a gzip-compressed E-section payload.
func EncodeEventsSection(events []Event) []byte {
	return gzipCompress(encodeEvents(events))
}

// ---------------------------------------------------------------------------
// writer

// brpWriter implements Writer, streaming frames through the codec into
// in-memory gzip buffers and assembling the container at Close.
type brpWriter struct {
	path  string
	meta  Meta
	codec *frameCodec

	coreBuf, extraBuf bytes.Buffer
	coreGz, extraGz   *gzip.Writer
	coreVW, extraVW   *varintWriter

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
	w := &brpWriter{
		path:       filepath.Join(dir, gameID+".brp"),
		frameTeams: map[int32]bool{},
		bounds:     BRPBounds{MinX: math.Inf(1), MaxX: math.Inf(-1), MinZ: math.Inf(1), MaxZ: math.Inf(-1)},
	}
	w.coreGz, _ = gzip.NewWriterLevel(&w.coreBuf, gzip.DefaultCompression)
	w.extraGz, _ = gzip.NewWriterLevel(&w.extraBuf, gzip.DefaultCompression)
	w.coreVW = &varintWriter{w: w.coreGz}
	w.extraVW = &varintWriter{w: w.extraGz}
	return w, nil
}

func (w *brpWriter) WriteMeta(m Meta) error {
	w.meta = m
	w.codec = newFrameCodec(m.SampleEvery)
	return nil
}

func (w *brpWriter) WriteFrame(fr Frame) error {
	if w.codec == nil { // meta not written; tolerate with defaults like jsonl would
		w.codec = newFrameCodec(0)
	}
	q := w.codec.encodeFrame(w.coreVW, w.extraVW, fr)
	for _, u := range q {
		w.anyUnit = true
		w.bounds.MinX = math.Min(w.bounds.MinX, float64(u.x))
		w.bounds.MaxX = math.Max(w.bounds.MaxX, float64(u.x))
		w.bounds.MinZ = math.Min(w.bounds.MinZ, float64(u.z))
		w.bounds.MaxZ = math.Max(w.bounds.MaxZ, float64(u.z))
		w.frameTeams[int32(u.team)] = true
	}
	w.frames++
	w.unitRecords += int64(len(q))
	if w.coreVW.err != nil {
		return w.coreVW.err
	}
	return w.extraVW.err
}

func (w *brpWriter) WriteEvent(e Event) error {
	w.events = append(w.events, e)
	w.frameTeams[e.Team] = true
	return nil
}

func (w *brpWriter) Close() error {
	if err := w.coreGz.Close(); err != nil {
		return err
	}
	if err := w.extraGz.Close(); err != nil {
		return err
	}

	rec := brpMetaRecord{
		Meta:        w.meta,
		Frames:      w.frames,
		Events:      len(w.events),
		UnitRecords: w.unitRecords,
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
		{Tag: SecFrames, Payload: w.coreBuf.Bytes()},
		{Tag: SecExtra, Payload: w.extraBuf.Bytes()},
		{Tag: SecEvents, Payload: gzipCompress(encodeEvents(w.events))},
	}
	if err := WriteContainer(f, BRPMagic, 1, sections); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// ---------------------------------------------------------------------------
// reader

// ParseBRP reads the container and decodes only the meta section, leaving the
// data sections compressed (for pass-through serving).
func ParseBRP(r io.Reader) (*BRPFile, error) {
	sections, err := ReadContainer(r, BRPMagic)
	if err != nil {
		return nil, err
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
	return f, nil
}

// ReadBRP fully decodes a .brp capture. Frames come back with units sorted by
// id and values at the format's storage precision (whole elmos, per-interval
// velocity, 1/255 build progress, 1/10 resources); TimeSec is frame/30.
func ReadBRP(r io.Reader) (Meta, []Frame, []Event, error) {
	f, err := ParseBRP(r)
	if err != nil {
		return Meta{}, nil, nil, err
	}
	var frames []Frame
	if sec, ok := f.Sections[SecFrames]; ok {
		core, err := gunzip(sec)
		if err != nil {
			return f.Meta, nil, nil, fmt.Errorf("snapshot: frames section: %w", err)
		}
		var extra []byte
		if xsec, ok := f.Sections[SecExtra]; ok {
			if extra, err = gunzip(xsec); err != nil {
				return f.Meta, nil, nil, fmt.Errorf("snapshot: extra section: %w", err)
			}
		}
		if frames, err = decodeFrames(core, extra, f.Meta.SampleEvery); err != nil {
			return f.Meta, nil, nil, err
		}
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
