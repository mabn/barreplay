// brp-eval is a THROWAWAY measurement harness (not a shipping codec): it loads
// a real .brp capture, re-encodes its F (core) and X (extra) frame sections
// under experimental layouts, and prints a size comparison so we can judge
// whether the layouts are worth implementing for real.
//
// Variants (each keeps the chunking model: 64-sample chunks, keyframe gzip
// stream + delta gzip stream per chunk, gzip.DefaultCompression — so numbers
// are apples-to-apples with the current format):
//
//	baseline   replica of the current codec; must match the input file's
//	           section sizes byte-for-byte (harness sanity check)
//	opt1       frame-major like today, but delta frames list only units with
//	           at least one non-zero column delta ("changed"), plus an
//	           explicit dead-id list so absence is unambiguous
//	opt2       unit-major sparse series: per column, per unit, a list of
//	           (frameIdxDelta, valueDelta) pairs holding only non-zero deltas;
//	           presence intervals in a per-chunk unit directory replace the
//	           per-frame id lists (deaths = interval ends)
//	opt2u      opt2 with the emit order flipped (unit's columns adjacent
//	           instead of column's units adjacent) — gzip locality probe
//	opt1+2     opt2 plus a per-unit column bitmask, so a fully idle unit costs
//	           one zero byte instead of one zero count per column
//
// All variants keep the same keyframe encoding (identical K streams), the
// same x/z velocity prediction, and the same resource encoding, so the deltas
// measured are purely the layout change in the D streams.
//
// Usage: go run ./experiments/brp-eval <capture.brp>
package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"sort"

	"github.com/mabn/barreplay/snapshot"
)

const (
	chunkFrames = 64
	nCore       = 8  // def team x z hp maxHp dvx dvz
	nCols       = 11 // + y dvy build
)

// qUnit is a unit's state in the quantized integer domain, mirroring
// snapshot's prevUnitState (plus the id).
type qUnit struct {
	id                                   int32
	def, team, x, z, hp, maxHp, dvx, dvz int64
	y, dvy, build                        int64
}

func colVal(u qUnit, c int) int64 {
	switch c {
	case 0:
		return u.def
	case 1:
		return u.team
	case 2:
		return u.x
	case 3:
		return u.z
	case 4:
		return u.hp
	case 5:
		return u.maxHp
	case 6:
		return u.dvx
	case 7:
		return u.dvz
	case 8:
		return u.y
	case 9:
		return u.dvy
	default:
		return u.build
	}
}

// predict returns the delta base for column c given the unit's previous
// state — identical to the shipping codec (x/z/y add the velocity
// displacement).
func predict(p qUnit, c int) int64 {
	switch c {
	case 2:
		return p.x + p.dvx
	case 3:
		return p.z + p.dvz
	case 8:
		return p.y + p.dvy
	default:
		return colVal(p, c)
	}
}

func roundq(f float32) int64 { return int64(math.Round(float64(f))) }

func quantize(u snapshot.UnitState, se float32) qUnit {
	return qUnit{
		id:  u.UnitID,
		def: int64(u.DefID), team: int64(u.Team),
		x: roundq(u.Pos.X), z: roundq(u.Pos.Z),
		hp: roundq(u.Health), maxHp: roundq(u.MaxHealth),
		dvx: roundq(u.VelX * se), dvz: roundq(u.VelZ * se),
		y: roundq(u.Pos.Y), dvy: roundq(u.VelY * se),
		build: roundq(u.BuildProgress * 255),
	}
}

type qRes struct {
	team                 int32
	m, e, ms, es, mi, ei int64
}

func quantizeRes(r snapshot.TeamResource) qRes {
	return qRes{
		team: r.Team,
		m:    roundq(r.Metal * 10), e: roundq(r.Energy * 10),
		ms: roundq(r.MetalStorage * 10), es: roundq(r.EnergyStorage * 10),
		mi: roundq(r.MetalIncome * 10), ei: roundq(r.EnergyIncome * 10),
	}
}

// qFrame is one sampled frame, quantized and sorted.
type qFrame struct {
	frame int64
	units []qUnit
	res   []qRes
}

// vw is a zigzag-varint writer into a buffer.
type vw struct{ buf *bytes.Buffer }

func (w vw) uv(v uint64) {
	var tmp [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(tmp[:], v)
	w.buf.Write(tmp[:n])
}
func (w vw) sv(v int64) { w.uv(uint64((v << 1) ^ (v >> 63))) }

func gz(b []byte) int {
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.DefaultCompression)
	zw.Write(b)
	zw.Close()
	return buf.Len()
}

// sizes accumulates a variant's per-section byte totals.
type sizes struct {
	fKey, fDelta, xKey, xDelta int64 // gzipped
	fRaw, xRaw                 int64 // raw delta-stream bytes (pre-gzip, K excluded)
}

func (s *sizes) f() int64     { return s.fKey + s.fDelta }
func (s *sizes) x() int64     { return s.xKey + s.xDelta }
func (s *sizes) total() int64 { return s.f() + s.x() }

// encodeKeyframe writes a frame with no prior state — all absolute, the
// current codec's keyframe layout — into core and extra streams, and returns
// the resulting prev map. Shared by every variant.
func encodeKeyframe(core, extra vw, fr qFrame, prevFrame *int64, prevRes map[int32]qRes) map[int32]qUnit {
	core.sv(fr.frame - *prevFrame)
	*prevFrame = fr.frame
	core.uv(uint64(len(fr.units)))
	last := int64(0)
	for _, u := range fr.units {
		core.sv(int64(u.id) - last)
		last = int64(u.id)
	}
	for c := 0; c < nCore; c++ {
		for _, u := range fr.units {
			core.sv(colVal(u, c))
		}
	}
	for c := nCore; c < nCols; c++ {
		for _, u := range fr.units {
			extra.sv(colVal(u, c))
		}
	}
	writeRes(extra, fr.res, prevRes)
	prev := make(map[int32]qUnit, len(fr.units))
	for _, u := range fr.units {
		prev[u.id] = u
	}
	return prev
}

// writeRes appends the per-team resource block (identical in all variants);
// prevRes is mutated.
func writeRes(extra vw, res []qRes, prevRes map[int32]qRes) {
	extra.uv(uint64(len(res)))
	for _, r := range res {
		p := prevRes[r.team]
		extra.sv(int64(r.team))
		extra.sv(r.m - p.m)
		extra.sv(r.e - p.e)
		extra.sv(r.ms - p.ms)
		extra.sv(r.es - p.es)
		extra.sv(r.mi - p.mi)
		extra.sv(r.ei - p.ei)
		prevRes[r.team] = r
	}
}

func deltas(u qUnit, prev map[int32]qUnit) (d [nCols]int64) {
	p, ok := prev[u.id]
	for c := 0; c < nCols; c++ {
		base := int64(0)
		if ok {
			base = predict(p, c)
		}
		d[c] = colVal(u, c) - base
	}
	return
}

// --------------------------------------------------------------------------
// baseline: replica of the shipping delta-frame layout.

func encodeBaselineDeltas(core, extra vw, frames []qFrame, prev map[int32]qUnit, prevFrame *int64, prevRes map[int32]qRes) {
	for _, fr := range frames {
		core.sv(fr.frame - *prevFrame)
		*prevFrame = fr.frame
		core.uv(uint64(len(fr.units)))
		last := int64(0)
		for _, u := range fr.units {
			core.sv(int64(u.id) - last)
			last = int64(u.id)
		}
		ds := make([][nCols]int64, len(fr.units))
		for i, u := range fr.units {
			ds[i] = deltas(u, prev)
		}
		for c := 0; c < nCore; c++ {
			for i := range fr.units {
				core.sv(ds[i][c])
			}
		}
		for c := nCore; c < nCols; c++ {
			for i := range fr.units {
				extra.sv(ds[i][c])
			}
		}
		writeRes(extra, fr.res, prevRes)
		next := make(map[int32]qUnit, len(fr.units))
		for _, u := range fr.units {
			next[u.id] = u
		}
		clear(prev)
		for k, v := range next {
			prev[k] = v
		}
	}
}

// --------------------------------------------------------------------------
// opt1: frame-major, but only changed units are listed; deaths get an
// explicit id list so absence means "unchanged", not "gone".

func encodeOpt1Deltas(core, extra vw, frames []qFrame, prev map[int32]qUnit, prevFrame *int64, prevRes map[int32]qRes) {
	for _, fr := range frames {
		core.sv(fr.frame - *prevFrame)
		*prevFrame = fr.frame

		cur := make(map[int32]bool, len(fr.units))
		for _, u := range fr.units {
			cur[u.id] = true
		}
		var dead []int64
		for id := range prev {
			if !cur[id] {
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

		type chg struct {
			u qUnit
			d [nCols]int64
		}
		var changed []chg
		for _, u := range fr.units {
			d := deltas(u, prev)
			any := false
			for c := 0; c < nCols; c++ {
				if d[c] != 0 {
					any = true
					break
				}
			}
			if _, existed := prev[u.id]; !existed {
				any = true // new unit: always emitted (absolutes)
			}
			if any {
				changed = append(changed, chg{u, d})
			}
		}
		core.uv(uint64(len(changed)))
		last = 0
		for _, ch := range changed {
			core.sv(int64(ch.u.id) - last)
			last = int64(ch.u.id)
		}
		for c := 0; c < nCore; c++ {
			for _, ch := range changed {
				core.sv(ch.d[c])
			}
		}
		for c := nCore; c < nCols; c++ {
			for _, ch := range changed {
				extra.sv(ch.d[c])
			}
		}
		writeRes(extra, fr.res, prevRes)

		// Decoder-visible state: skipped units advance to their prediction,
		// which equals their actual value (all deltas were zero).
		next := make(map[int32]qUnit, len(fr.units))
		for _, u := range fr.units {
			next[u.id] = u
		}
		clear(prev)
		for k, v := range next {
			prev[k] = v
		}
	}
}

// --------------------------------------------------------------------------
// opt2 family: per-chunk unit directory with presence intervals, then sparse
// per-column series of (frameIdxDelta, valueDelta) — only non-zero deltas.

// series holds one unit's sparse entries for one column within a chunk.
type entry struct {
	idx int // frame index within the chunk (0 = keyframe)
	d   int64
}

type unitSeries struct {
	id        int32
	intervals [][2]int // presence [startIdx, endIdx] inclusive, over delta frames + keyframe
	cols      [nCols][]entry
}

// buildSeries walks the chunk's frames and produces, per unit, presence
// intervals and per-column sparse deltas. Frame index 0 is the keyframe
// (already fully encoded in the K stream, so it contributes no entries);
// units first seen at index > 0 emit absolutes for every column there.
func buildSeries(frames []qFrame) []*unitSeries {
	byID := map[int32]*unitSeries{}
	var order []int32
	prev := map[int32]qUnit{}
	for idx, fr := range frames {
		next := make(map[int32]qUnit, len(fr.units))
		for _, u := range fr.units {
			s := byID[u.id]
			if s == nil {
				s = &unitSeries{id: u.id}
				byID[u.id] = s
				order = append(order, u.id)
			}
			if n := len(s.intervals); n > 0 && s.intervals[n-1][1] == idx-1 {
				s.intervals[n-1][1] = idx
			} else {
				s.intervals = append(s.intervals, [2]int{idx, idx})
			}
			if idx > 0 { // keyframe values live in the K stream
				d := deltas(u, prev)
				_, existed := prev[u.id]
				for c := 0; c < nCols; c++ {
					if d[c] != 0 || !existed {
						s.cols[c] = append(s.cols[c], entry{idx, d[c]})
					}
				}
			}
			next[u.id] = u
		}
		prev = next
	}
	sort.Slice(order, func(i, j int) bool { return order[i] < order[j] })
	out := make([]*unitSeries, len(order))
	for i, id := range order {
		out[i] = byID[id]
	}
	return out
}

// writeDirectory emits the chunk's frame list and unit directory (ids +
// presence intervals) — shared by all opt2 variants.
func writeDirectory(core vw, frames []qFrame, units []*unitSeries, prevFrame *int64) {
	core.uv(uint64(len(frames) - 1))
	for _, fr := range frames[1:] {
		core.sv(fr.frame - *prevFrame)
		*prevFrame = fr.frame
	}
	core.uv(uint64(len(units)))
	last := int64(0)
	for _, s := range units {
		core.sv(int64(s.id) - last)
		last = int64(s.id)
	}
	for _, s := range units {
		core.uv(uint64(len(s.intervals)))
		p := 0
		for _, iv := range s.intervals {
			core.uv(uint64(iv[0] - p))
			core.uv(uint64(iv[1] - iv[0]))
			p = iv[1]
		}
	}
}

func writeSeries(w vw, s *unitSeries, c int) {
	w.uv(uint64(len(s.cols[c])))
	p := 0
	for _, e := range s.cols[c] {
		w.uv(uint64(e.idx - p))
		w.sv(e.d)
		p = e.idx
	}
}

// encodeOpt2Deltas: column-major (all units' series for a column adjacent).
// unitMajor flips to unit-major (a unit's columns adjacent). bitmask adds the
// per-unit column-presence mask (opt1+2 combined).
func encodeOpt2Deltas(core, extra vw, frames []qFrame, prevFrame *int64, prevRes map[int32]qRes, unitMajor, bitmask bool) {
	units := buildSeries(frames)
	writeDirectory(core, frames, units, prevFrame)

	if bitmask {
		for _, s := range units {
			m := uint64(0)
			for c := 0; c < nCols; c++ {
				if len(s.cols[c]) > 0 {
					m |= 1 << c
				}
			}
			core.uv(m)
		}
	}
	pick := func(c int) vw {
		if c < nCore {
			return core
		}
		return extra
	}
	emit := func(w vw, s *unitSeries, c int) {
		if bitmask {
			if len(s.cols[c]) == 0 {
				return
			}
			// count still needed (>=1) but shifted by one
			w.uv(uint64(len(s.cols[c]) - 1))
			p := 0
			for _, e := range s.cols[c] {
				w.uv(uint64(e.idx - p))
				w.sv(e.d)
				p = e.idx
			}
			return
		}
		writeSeries(w, s, c)
	}
	if unitMajor {
		for _, s := range units {
			for c := 0; c < nCols; c++ {
				emit(pick(c), s, c)
			}
		}
	} else {
		for c := 0; c < nCols; c++ {
			for _, s := range units {
				emit(pick(c), s, c)
			}
		}
	}
	// Resources stay frame-major, exactly as baseline.
	for _, fr := range frames[1:] {
		writeRes(extra, fr.res, prevRes)
	}
}

// --------------------------------------------------------------------------

type variant struct {
	name string
	enc  func(coreK, extraK, coreD, extraD vw, frames []qFrame)
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: brp-eval <capture.brp>")
		os.Exit(2)
	}
	path := os.Args[1]
	raw, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	pf, err := snapshot.ParseBRP(bytes.NewReader(raw))
	if err != nil {
		panic(err)
	}
	meta, frames, _, err := snapshot.ReadBRP(bytes.NewReader(raw))
	if err != nil {
		panic(err)
	}
	se := float32(meta.SampleEvery)
	if se <= 0 {
		se = 30
	}

	// Quantize once.
	qframes := make([]qFrame, len(frames))
	for i, fr := range frames {
		qf := qFrame{frame: int64(fr.Frame)}
		qf.units = make([]qUnit, len(fr.Units))
		for j, u := range fr.Units {
			qf.units[j] = quantize(u, se)
		}
		sort.Slice(qf.units, func(a, b int) bool { return qf.units[a].id < qf.units[b].id })
		qf.res = make([]qRes, len(fr.Resources))
		for j, r := range fr.Resources {
			qf.res[j] = quantizeRes(r)
		}
		sort.Slice(qf.res, func(a, b int) bool { return qf.res[a].team < qf.res[b].team })
		qframes[i] = qf
	}

	// ---- change statistics over delta frames --------------------------------
	var totRec, idleAll, idleCore int64
	var colChanged [nCols]int64
	var deadCount, newCount int64
	{
		prev := map[int32]qUnit{}
		for i, fr := range qframes {
			if i%chunkFrames == 0 { // chunk boundary: keyframe, reset
				prev = map[int32]qUnit{}
				for _, u := range fr.units {
					prev[u.id] = u
				}
				continue
			}
			cur := map[int32]bool{}
			for _, u := range fr.units {
				cur[u.id] = true
			}
			for id := range prev {
				if !cur[id] {
					deadCount++
				}
			}
			next := make(map[int32]qUnit, len(fr.units))
			for _, u := range fr.units {
				totRec++
				d := deltas(u, prev)
				if _, existed := prev[u.id]; !existed {
					newCount++
				}
				allZero, coreZero := true, true
				for c := 0; c < nCols; c++ {
					if d[c] != 0 {
						colChanged[c]++
						allZero = false
						if c < nCore {
							coreZero = false
						}
					}
				}
				if _, existed := prev[u.id]; existed {
					if allZero {
						idleAll++
					}
					if coreZero {
						idleCore++
					}
				}
				next[u.id] = u
			}
			prev = next
		}
	}
	fmt.Printf("== change statistics (delta frames only, %d unit records) ==\n", totRec)
	fmt.Printf("fully idle (all 11 cols zero-delta): %d (%.1f%%)\n", idleAll, 100*float64(idleAll)/float64(totRec))
	fmt.Printf("core-idle (8 core cols zero-delta):  %d (%.1f%%)\n", idleCore, 100*float64(idleCore)/float64(totRec))
	fmt.Printf("new-unit records: %d   deaths: %d\n", newCount, deadCount)
	names := []string{"def", "team", "x", "z", "hp", "maxHp", "dvx", "dvz", "y", "dvy", "build"}
	for c := 0; c < nCols; c++ {
		fmt.Printf("  col %-5s changed: %9d (%.1f%%)\n", names[c], colChanged[c], 100*float64(colChanged[c])/float64(totRec))
	}
	fmt.Println()

	// ---- variants ------------------------------------------------------------
	variants := []variant{
		{"baseline", func(ck, xk, cd, xd vw, fs []qFrame) {
			prevFrame := int64(0)
			prevRes := map[int32]qRes{}
			prev := encodeKeyframe(ck, xk, fs[0], &prevFrame, prevRes)
			encodeBaselineDeltas(cd, xd, fs[1:], prev, &prevFrame, prevRes)
		}},
		{"opt1 (skip idle units)", func(ck, xk, cd, xd vw, fs []qFrame) {
			prevFrame := int64(0)
			prevRes := map[int32]qRes{}
			prev := encodeKeyframe(ck, xk, fs[0], &prevFrame, prevRes)
			encodeOpt1Deltas(cd, xd, fs[1:], prev, &prevFrame, prevRes)
		}},
		{"opt2 (unit sparse series)", func(ck, xk, cd, xd vw, fs []qFrame) {
			prevFrame := int64(0)
			prevRes := map[int32]qRes{}
			encodeKeyframe(ck, xk, fs[0], &prevFrame, prevRes)
			encodeOpt2Deltas(cd, xd, fs, &prevFrame, prevRes, false, false)
		}},
		{"opt2u (unit-major order)", func(ck, xk, cd, xd vw, fs []qFrame) {
			prevFrame := int64(0)
			prevRes := map[int32]qRes{}
			encodeKeyframe(ck, xk, fs[0], &prevFrame, prevRes)
			encodeOpt2Deltas(cd, xd, fs, &prevFrame, prevRes, true, false)
		}},
		{"opt1+2 (sparse + bitmask)", func(ck, xk, cd, xd vw, fs []qFrame) {
			prevFrame := int64(0)
			prevRes := map[int32]qRes{}
			encodeKeyframe(ck, xk, fs[0], &prevFrame, prevRes)
			encodeOpt2Deltas(cd, xd, fs, &prevFrame, prevRes, false, true)
		}},
	}

	origF := int64(len(pf.Sections[snapshot.SecFrames]))
	origX := int64(len(pf.Sections[snapshot.SecExtra]))
	origTotal := int64(len(raw))

	fmt.Printf("input: %s  (%d bytes total, F=%d, X=%d, other=%d)\n\n",
		path, origTotal, origF, origX, origTotal-origF-origX)

	fmt.Printf("%-28s %10s %10s %10s %12s %8s | %10s %10s %8s | %12s %8s\n",
		"variant", "F bytes", "X bytes", "F+X", "file total", "vs base", "K gz", "D gz", "D vs b", "D raw F+X", "vs base")
	var baseFX, baseRaw, baseD int64
	for _, v := range variants {
		var sz sizes
		for start := 0; start < len(qframes); start += chunkFrames {
			end := start + chunkFrames
			if end > len(qframes) {
				end = len(qframes)
			}
			var ck, xk, cd, xd bytes.Buffer
			v.enc(vw{&ck}, vw{&xk}, vw{&cd}, vw{&xd}, qframes[start:end])
			sz.fKey += int64(gz(ck.Bytes()))
			sz.xKey += int64(gz(xk.Bytes()))
			if end-start > 1 {
				sz.fDelta += int64(gz(cd.Bytes()))
				sz.xDelta += int64(gz(xd.Bytes()))
				sz.fRaw += int64(cd.Len())
				sz.xRaw += int64(xd.Len())
			}
		}
		fileTotal := origTotal - origF - origX + sz.f() + sz.x()
		if v.name == "baseline" {
			baseFX = sz.total()
			baseRaw = sz.fRaw + sz.xRaw
			baseD = sz.fDelta + sz.xDelta
			if sz.f() != origF || sz.x() != origX {
				fmt.Printf("!! baseline replica MISMATCH: got F=%d X=%d, file has F=%d X=%d\n", sz.f(), sz.x(), origF, origX)
			}
		}
		fmt.Printf("%-28s %10d %10d %10d %12d %7.1f%% | %10d %10d %7.1f%% | %12d %7.1f%%\n",
			v.name, sz.f(), sz.x(), sz.total(), fileTotal,
			100*float64(sz.total())/float64(baseFX),
			sz.fKey+sz.xKey, sz.fDelta+sz.xDelta,
			100*float64(sz.fDelta+sz.xDelta)/float64(baseD),
			sz.fRaw+sz.xRaw, 100*float64(sz.fRaw+sz.xRaw)/float64(baseRaw))
	}
}
