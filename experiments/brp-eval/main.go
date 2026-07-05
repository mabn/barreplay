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
//
//	-unit <id>   instead of benchmarking, dump one unit's per-frame encoded
//	             deltas (cartesian vs polar) across all chunks and exit
package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"flag"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"

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
// opt3: polar velocity. The dvx/dvz columns are replaced by (speed, angle):
// speed = round(hypot(dvx,dvz)) in elmos per sample interval (same radial
// precision as today), angle quantized to `steps` per full turn, delta-coded
// with wrap-around (a stopped unit keeps its previous angle so stopping costs
// one speed delta, not an angle jump). The x/z position predictor becomes the
// RECONSTRUCTED velocity (spd·cos, spd·sin), so polar quantization error
// leaks into the x/z residual columns — that trade-off is the experiment.
// secondOrder additionally predicts angle += previous angle delta (constant
// turn rate encodes as zero). skipIdle layers opt1 on top.

type pState struct {
	q        qUnit
	spd, ang int64
	angD     int64 // previous frame's angle delta (2nd-order predictor)
	rdx, rdz int64 // velocity reconstructed from (spd, ang) — the x/z predictor
}

func polarOf(dvx, dvz int64, steps int64, prevAng int64, hadPrev bool) (spd, ang int64) {
	spd = int64(math.Round(math.Hypot(float64(dvx), float64(dvz))))
	if spd == 0 {
		if hadPrev {
			return 0, prevAng
		}
		return 0, 0
	}
	a := math.Atan2(float64(dvz), float64(dvx))
	ang = int64(math.Round(a / (2 * math.Pi) * float64(steps)))
	ang = ((ang % steps) + steps) % steps
	return
}

func reconDV(spd, ang, steps int64) (int64, int64) {
	if spd == 0 {
		return 0, 0
	}
	th := 2 * math.Pi * float64(ang) / float64(steps)
	return int64(math.Round(float64(spd) * math.Cos(th))),
		int64(math.Round(float64(spd) * math.Sin(th)))
}

func wrapAng(d, steps int64) int64 {
	d = ((d % steps) + steps) % steps
	if d >= steps/2 {
		d -= steps
	}
	return d
}

func polarState(u qUnit, steps int64) pState {
	spd, ang := polarOf(u.dvx, u.dvz, steps, 0, false)
	rdx, rdz := reconDV(spd, ang, steps)
	return pState{q: u, spd: spd, ang: ang, rdx: rdx, rdz: rdz}
}

func encodePolarDeltas(core, extra vw, frames []qFrame, prev map[int32]pState, prevFrame *int64, prevRes map[int32]qRes, steps int64, secondOrder, skipIdle bool) {
	for _, fr := range frames {
		core.sv(fr.frame - *prevFrame)
		*prevFrame = fr.frame

		type rec struct {
			u        qUnit
			d        [8]int64 // def team x z hp maxHp spd ang
			xd       [3]int64 // y dvy build
			spd, ang int64
		}
		recs := make([]rec, 0, len(fr.units))
		next := make(map[int32]pState, len(fr.units))
		for _, u := range fr.units {
			p, ok := prev[u.id]
			spd, ang := polarOf(u.dvx, u.dvz, steps, p.ang, ok)
			r := rec{u: u, spd: spd, ang: ang}
			if ok {
				r.d = [8]int64{
					u.def - p.q.def, u.team - p.q.team,
					u.x - (p.q.x + p.rdx), u.z - (p.q.z + p.rdz),
					u.hp - p.q.hp, u.maxHp - p.q.maxHp,
					spd - p.spd, 0,
				}
				pa := p.ang
				if secondOrder {
					pa = ((p.ang+p.angD)%steps + steps) % steps
				}
				r.d[7] = wrapAng(ang-pa, steps)
				r.xd = [3]int64{u.y - (p.q.y + p.q.dvy), u.dvy - p.q.dvy, u.build - p.q.build}
			} else {
				r.d = [8]int64{u.def, u.team, u.x, u.z, u.hp, u.maxHp, spd, ang}
				r.xd = [3]int64{u.y, u.dvy, u.build}
			}
			recs = append(recs, r)

			np := pState{q: u, spd: spd, ang: ang}
			if ok {
				np.angD = wrapAng(ang-p.ang, steps)
			}
			np.rdx, np.rdz = reconDV(spd, ang, steps)
			next[u.id] = np
		}

		if skipIdle {
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
			kept := recs[:0]
			for _, r := range recs {
				_, existed := prev[r.u.id]
				any := !existed
				for _, v := range r.d {
					if v != 0 {
						any = true
					}
				}
				for _, v := range r.xd {
					if v != 0 {
						any = true
					}
				}
				if any {
					kept = append(kept, r)
				}
			}
			recs = kept
		}

		core.uv(uint64(len(recs)))
		last := int64(0)
		for _, r := range recs {
			core.sv(int64(r.u.id) - last)
			last = int64(r.u.id)
		}
		for c := 0; c < 8; c++ {
			for _, r := range recs {
				core.sv(r.d[c])
			}
		}
		for c := 0; c < 3; c++ {
			for _, r := range recs {
				extra.sv(r.xd[c])
			}
		}
		writeRes(extra, fr.res, prevRes)

		clear(prev)
		for k, v := range next {
			prev[k] = v
		}
	}
}

// --------------------------------------------------------------------------
// -unit dump: one unit's per-frame encoded values under both schemes.

// svLen is the encoded size in bytes of one zigzag varint.
func svLen(v int64) int {
	var tmp [binary.MaxVarintLen64]byte
	return binary.PutUvarint(tmp[:], uint64((v<<1)^(v>>63)))
}

func gameTime(frame int64) string {
	sec := frame / simFPSDump
	return fmt.Sprintf("%3dm %02ds f%6d", sec/60, sec%60, frame)
}

const simFPSDump = 30
const dumpAngleSteps = 1024

// dumpUnit prints, for every sampled frame where the unit appears, the deltas
// the CURRENT cartesian codec stores (def team x z hp maxHp dvx dvz | y dvy
// build) and what the polar codec (opt3, 1024 angle steps) would store
// (spd/ang replacing dvx/dvz, x/z residual vs the reconstructed velocity).
// "—" means every delta is zero: the record costs 11 one-byte zeros in the
// current format and would be skipped entirely under opt1. Chunk keyframes
// (every 64th sample) are marked K and store absolutes.
func dumpUnit(qframes []qFrame, id int32) {
	names := []string{"def", "team", "x", "z", "hp", "maxHp", "dvx", "dvz", "y", "dvy", "build"}
	polNames := []string{"def", "team", "x", "z", "hp", "maxHp", "spd", "ang", "y", "dvy", "build"}

	fmtDeltas := func(d []int64, n []string) string {
		var parts []string
		for i, v := range d {
			if v != 0 {
				parts = append(parts, fmt.Sprintf("%s%+d", n[i], v))
			}
		}
		if parts == nil {
			return "—"
		}
		return strings.Join(parts, " ")
	}
	sum := func(d []int64) (n int) {
		for _, v := range d {
			n += svLen(v)
		}
		return
	}

	prevCart := map[int32]qUnit{}
	prevPol := map[int32]pState{}
	present := false
	var frames, idleCart, idlePol int
	var bytesCart, bytesPol int64

	for i, fr := range qframes {
		key := i%chunkFrames == 0
		if key {
			prevCart = map[int32]qUnit{}
			prevPol = map[int32]pState{}
			for _, u := range fr.units {
				prevCart[u.id] = u
				prevPol[u.id] = polarState(u, dumpAngleSteps)
			}
		}
		var cur *qUnit
		for j := range fr.units {
			if fr.units[j].id == id {
				cur = &fr.units[j]
				break
			}
		}
		if cur == nil {
			if present && !key {
				fmt.Printf("%s   unit died / left sampling\n", gameTime(fr.frame))
			}
			present = cur != nil
			if !key { // advance shared state for non-key frames
				nc := make(map[int32]qUnit, len(fr.units))
				np := make(map[int32]pState, len(fr.units))
				for _, u := range fr.units {
					nc[u.id] = u
					p, ok := prevPol[u.id]
					spd, ang := polarOf(u.dvx, u.dvz, dumpAngleSteps, p.ang, ok)
					s := pState{q: u, spd: spd, ang: ang}
					if ok {
						s.angD = wrapAng(ang-p.ang, dumpAngleSteps)
					}
					s.rdx, s.rdz = reconDV(spd, ang, dumpAngleSteps)
					np[u.id] = s
				}
				prevCart, prevPol = nc, np
			}
			continue
		}
		present = true
		frames++

		spd, angNow := polarOf(cur.dvx, cur.dvz, dumpAngleSteps, prevPol[id].ang, !key && func() bool { _, ok := prevPol[id]; return ok }())
		state := fmt.Sprintf("pos %5d,%5d  dv %+4d,%+4d  spd %3d ang %4d  hp %5d",
			cur.x, cur.z, cur.dvx, cur.dvz, spd, angNow, cur.hp)

		if key {
			abs := []int64{cur.def, cur.team, cur.x, cur.z, cur.hp, cur.maxHp, cur.dvx, cur.dvz, cur.y, cur.dvy, cur.build}
			fmt.Printf("%s K %s | keyframe, absolute (%dB)\n", gameTime(fr.frame), state, sum(abs))
		} else {
			dc := deltas(*cur, prevCart)
			p, ok := prevPol[id]
			var dp [11]int64
			if ok {
				dp = [11]int64{
					cur.def - p.q.def, cur.team - p.q.team,
					cur.x - (p.q.x + p.rdx), cur.z - (p.q.z + p.rdz),
					cur.hp - p.q.hp, cur.maxHp - p.q.maxHp,
					spd - p.spd, wrapAng(angNow-p.ang, dumpAngleSteps),
					cur.y - (p.q.y + p.q.dvy), cur.dvy - p.q.dvy, cur.build - p.q.build,
				}
			} else {
				dp = [11]int64{cur.def, cur.team, cur.x, cur.z, cur.hp, cur.maxHp, spd, angNow, cur.y, cur.dvy, cur.build}
			}
			bc, bp := sum(dc[:]), sum(dp[:])
			bytesCart += int64(bc)
			bytesPol += int64(bp)
			czero, pzero := fmtDeltas(dc[:], names) == "—", fmtDeltas(dp[:], polNames) == "—"
			if czero {
				idleCart++
			}
			if pzero {
				idlePol++
			}
			mark := func(zero bool) string {
				if zero {
					return " opt1:SKIP"
				}
				return ""
			}
			fmt.Printf("%s   %s | cart: %-28s (%2dB)%s | polar: %-24s (%2dB)%s\n",
				gameTime(fr.frame), state,
				fmtDeltas(dc[:], names), bc, mark(czero),
				fmtDeltas(dp[:], polNames), bp, mark(pzero))
		}

		// advance shared codec state
		nc := make(map[int32]qUnit, len(fr.units))
		np := make(map[int32]pState, len(fr.units))
		for _, u := range fr.units {
			nc[u.id] = u
			pp, ok := prevPol[u.id]
			s2, a2 := polarOf(u.dvx, u.dvz, dumpAngleSteps, pp.ang, ok && !key)
			s := pState{q: u, spd: s2, ang: a2}
			if ok && !key {
				s.angD = wrapAng(a2-pp.ang, dumpAngleSteps)
			}
			s.rdx, s.rdz = reconDV(s2, a2, dumpAngleSteps)
			np[u.id] = s
		}
		if !key {
			prevCart, prevPol = nc, np
		}
	}
	fmt.Printf("\nunit %d summary: %d sampled frames; delta frames all-zero: cart %d, polar %d;"+
		" delta bytes (11 cols, pre-gzip): cart %d, polar %d\n",
		id, frames, idleCart, idlePol, bytesCart, bytesPol)
}

// findConstant lists the units with the most "moving but free" delta frames —
// dv non-zero yet every cartesian column delta zero (the constant-velocity
// sweet spot the codec's velocity predictor is built around) — to pick good
// dump subjects.
func findConstant(qframes []qFrame, defs map[int32]snapshot.UnitDef) {
	type acc struct{ free, moving, frames int }
	byID := map[int32]*acc{}
	def := map[int32]int32{}
	prev := map[int32]qUnit{}
	for i, fr := range qframes {
		if i%chunkFrames == 0 {
			prev = map[int32]qUnit{}
			for _, u := range fr.units {
				prev[u.id] = u
			}
			continue
		}
		next := make(map[int32]qUnit, len(fr.units))
		for _, u := range fr.units {
			a := byID[u.id]
			if a == nil {
				a = &acc{}
				byID[u.id] = a
				def[u.id] = int32(u.def)
			}
			a.frames++
			if _, ok := prev[u.id]; ok {
				d := deltas(u, prev)
				zero := true
				for _, v := range d {
					if v != 0 {
						zero = false
						break
					}
				}
				if u.dvx != 0 || u.dvz != 0 {
					a.moving++
					if zero {
						a.free++
					}
				}
			}
			next[u.id] = u
		}
		prev = next
	}
	type row struct {
		id   int32
		a    *acc
		name string
	}
	var rows []row
	for id, a := range byID {
		name := defs[def[id]].Name
		rows = append(rows, row{id, a, name})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].a.free > rows[j].a.free })
	fmt.Println("units with the most moving-yet-all-zero-delta frames (constant velocity):")
	for _, r := range rows[:min(20, len(rows))] {
		fmt.Printf("  unit %5d %-16s frames=%4d moving=%4d free-while-moving=%4d\n",
			r.id, r.name, r.a.frames, r.a.moving, r.a.free)
	}
}

// --------------------------------------------------------------------------

type variant struct {
	name string
	enc  func(coreK, extraK, coreD, extraD vw, frames []qFrame)
}

func main() {
	unitID := flag.Int("unit", -1, "dump per-frame encoding details for this unit id and exit")
	findConst := flag.Bool("find-constant", false, "list units with the most constant-velocity (free) frames and exit")
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: brp-eval [-unit <id>] <capture.brp>")
		os.Exit(2)
	}
	path := flag.Arg(0)
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

	if *unitID >= 0 {
		dumpUnit(qframes, int32(*unitID))
		return
	}
	if *findConst {
		findConstant(qframes, meta.UnitDefs)
		return
	}

	// ---- change statistics over delta frames --------------------------------
	var totRec, idleAll, idleCore int64
	// tolerance probes: how many more records become skippable if ±1 elmo
	// position error is acceptable (idleCoreTol), and additionally ignoring
	// the extra-section terrain-following y/dvy noise (idleAllTol).
	var idleCoreTol, idleAllTol int64
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
					coreTol := d[0] == 0 && d[1] == 0 && abs64(d[2]) <= 1 && abs64(d[3]) <= 1 &&
						d[4] == 0 && d[5] == 0 && d[6] == 0 && d[7] == 0
					if coreTol {
						idleCoreTol++
						if abs64(d[8]) <= 2 && abs64(d[9]) <= 2 && d[10] == 0 {
							idleAllTol++
						}
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
	fmt.Printf("core-idle if |x|,|z| residual <=1 tolerated: %d (%.1f%%)\n", idleCoreTol, 100*float64(idleCoreTol)/float64(totRec))
	fmt.Printf("  ... and |y|,|dvy| <=2 tolerated too:       %d (%.1f%%)\n", idleAllTol, 100*float64(idleAllTol)/float64(totRec))
	fmt.Printf("new-unit records: %d   deaths: %d\n", newCount, deadCount)
	names := []string{"def", "team", "x", "z", "hp", "maxHp", "dvx", "dvz", "y", "dvy", "build"}
	for c := 0; c < nCols; c++ {
		fmt.Printf("  col %-5s changed: %9d (%.1f%%)\n", names[c], colChanged[c], 100*float64(colChanged[c])/float64(totRec))
	}
	fmt.Println()

	// ---- polar (opt3) statistics: change rates + tangent fidelity -----------
	for _, steps := range []int64{1024, 256} {
		var nzX, nzZ, nzSpd, nzAng, nzAng2, withPrev int64
		var errSum, errMax, errCnt, exact int64
		prev := map[int32]pState{}
		for i, fr := range qframes {
			if i%chunkFrames == 0 {
				prev = map[int32]pState{}
				for _, u := range fr.units {
					prev[u.id] = polarState(u, steps)
				}
				continue
			}
			next := make(map[int32]pState, len(fr.units))
			for _, u := range fr.units {
				p, ok := prev[u.id]
				spd, ang := polarOf(u.dvx, u.dvz, steps, p.ang, ok)
				np := pState{q: u, spd: spd, ang: ang}
				if ok {
					np.angD = wrapAng(ang-p.ang, steps)
				}
				np.rdx, np.rdz = reconDV(spd, ang, steps)
				ex := abs64(np.rdx-u.dvx) + abs64(np.rdz-u.dvz)
				errSum += ex
				errCnt++
				if ex == 0 {
					exact++
				}
				if ex > errMax {
					errMax = ex
				}
				if ok {
					withPrev++
					if u.x-(p.q.x+p.rdx) != 0 {
						nzX++
					}
					if u.z-(p.q.z+p.rdz) != 0 {
						nzZ++
					}
					if spd-p.spd != 0 {
						nzSpd++
					}
					if wrapAng(ang-p.ang, steps) != 0 {
						nzAng++
					}
					if wrapAng(ang-((p.ang+p.angD)%steps+steps)%steps, steps) != 0 {
						nzAng2++
					}
				}
				next[u.id] = np
			}
			prev = next
		}
		pc := func(n int64) float64 { return 100 * float64(n) / float64(withPrev) }
		fmt.Printf("== polar stats, angle steps=%d (records with prev: %d) ==\n", steps, withPrev)
		fmt.Printf("nonzero: x-res %.1f%%  z-res %.1f%%  spd %.1f%%  ang %.1f%%  ang(2nd-order) %.1f%%\n",
			pc(nzX), pc(nzZ), pc(nzSpd), pc(nzAng), pc(nzAng2))
		fmt.Printf("tangent |recon-dv| L1 error: mean %.3f elmo/interval, max %d, exact %.1f%%\n\n",
			float64(errSum)/float64(errCnt), errMax, 100*float64(exact)/float64(errCnt))
	}

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
	polar := func(name string, steps int64, secondOrder, skipIdle bool) variant {
		return variant{name, func(ck, xk, cd, xd vw, fs []qFrame) {
			prevFrame := int64(0)
			prevRes := map[int32]qRes{}
			encodeKeyframe(ck, xk, fs[0], &prevFrame, prevRes)
			prev := make(map[int32]pState, len(fs[0].units))
			for _, u := range fs[0].units {
				prev[u.id] = polarState(u, steps)
			}
			encodePolarDeltas(cd, xd, fs[1:], prev, &prevFrame, prevRes, steps, secondOrder, skipIdle)
		}}
	}
	variants = append(variants,
		polar("opt3 polar dv (1024 steps)", 1024, false, false),
		polar("opt3 polar dv (256 steps)", 256, false, false),
		polar("opt1+3 (skip idle, 1024)", 1024, false, true),
		polar("opt1+3 (skip idle, 256)", 256, false, true),
		polar("opt1+3 2nd-order angle", 1024, true, true),
	)

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

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
