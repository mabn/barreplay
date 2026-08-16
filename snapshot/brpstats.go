package snapshot

// Size statistics for a .brp: per-section stored/raw byte counts and a
// per-unit-def attribution of the encoded frame-stream bytes, answering "what
// makes this file big". Attribution re-runs the encoder's decisions over the
// decoded frames (chunk by chunk, fresh codec state at each boundary — exactly
// like the writer) and sums the varint lengths each unit would emit; because a
// decoded .brp is exact at storage precision, re-quantizing reproduces the
// original streams byte-for-byte, and ComputeBRPStats verifies that: it fails
// loudly if the measured totals do not equal the real decompressed section
// sizes, so the measurer cannot silently drift from the codec.

import (
	"fmt"
	"sort"
)

// BRPSectionStat is one container section's size: Stored is the payload as it
// sits in the file (compressed), Raw its decompressed size.
type BRPSectionStat struct {
	Tag    byte
	Name   string
	Stored int64
	Raw    int64
}

// BRPDefStat attributes encoded frame-stream bytes to one unit def.
// CoreBytes counts the def's raw bytes in the K+F streams (changed-id deltas,
// the 10 core columns, dead-id deltas). ExtraBytes is always 0 since v5 moved
// the build column into the core stream (X carries only team resources, which
// no def owns); the field stays for the report's shape.
// Records is how many sampled unit states carry the def; Instances how many
// distinct unit lifetimes did (a unit id appearing, living, then dying is one
// instance — the divisor for "does this def cost a lot per unit, or are there
// just a lot of them").
type BRPDefStat struct {
	DefID      int32
	Name       string
	HumanName  string
	CoreBytes  int64
	ExtraBytes int64
	Records    int64
	Instances  int64
}

// BRPStats is the full size breakdown of one .brp.
type BRPStats struct {
	Sections []BRPSectionStat // file order (M, K, F, X, E, C), present sections only
	Defs     []BRPDefStat     // sorted by CoreBytes+ExtraBytes descending

	// OverheadBytes is the core-stream framing no def owns: frame deltas and
	// the dead/changed list-length varints. ResourceBytes is the extra
	// stream's team-economy records (count + per-team columns).
	OverheadBytes int64
	ResourceBytes int64

	// CoreRaw/ExtraRaw are the decompressed K+F / X sizes; by construction
	// CoreRaw == sum(Defs.CoreBytes) + OverheadBytes and
	// ExtraRaw == sum(Defs.ExtraBytes) + ResourceBytes.
	CoreRaw  int64
	ExtraRaw int64
}

// uvLen/svLen are the byte counts binary.PutUvarint would emit — the measuring
// twins of varintWriter.uv/sv.
func uvLen(v uint64) int64 {
	n := int64(1)
	for v >= 0x80 {
		v >>= 7
		n++
	}
	return n
}

func svLen(v int64) int64 { return uvLen(zigzag(v)) }

// ComputeBRPStats decodes every chunk of f and measures where the bytes go.
func ComputeBRPStats(f *BRPFile) (*BRPStats, error) {
	st := &BRPStats{}
	rawSize := map[byte]int64{}
	for _, s := range []struct {
		tag  byte
		name string
	}{
		{SecMeta, "meta"},
		{SecKeyframes, "keyframes"},
		{SecFrames, "frames"},
		{SecExtra, "extra"},
		{SecEvents, "events"},
		{SecComms, "comms"},
	} {
		payload, ok := f.Sections[s.tag]
		if !ok {
			continue
		}
		var raw int64
		if len(payload) > 0 {
			// F and X are concatenated gzip members (one per chunk); Go's gzip
			// reader consumes multistream payloads transparently.
			b, err := gunzip(payload)
			if err != nil {
				return nil, fmt.Errorf("snapshot: stats: section %q: %w", s.tag, err)
			}
			raw = int64(len(b))
		}
		rawSize[s.tag] = raw
		st.Sections = append(st.Sections, BRPSectionStat{Tag: s.tag, Name: s.name, Stored: int64(len(payload)), Raw: raw})
	}
	st.CoreRaw = rawSize[SecKeyframes] + rawSize[SecFrames]
	st.ExtraRaw = rawSize[SecExtra]

	agg := map[int32]*BRPDefStat{}
	defAgg := func(defID int32) *BRPDefStat {
		d, ok := agg[defID]
		if !ok {
			d = &BRPDefStat{DefID: defID}
			if ud, ok := f.Meta.UnitDefs[defID]; ok {
				d.Name, d.HumanName = ud.Name, ud.HumanName
			}
			agg[defID] = d
		}
		return d
	}

	// alive tracks unit lifetimes ACROSS chunk boundaries (unlike the codec's
	// prediction state, which resets per chunk): a unit id first seen — or seen
	// with a new def, i.e. the id was recycled between samples — starts an
	// instance; disappearing ends it.
	alive := map[int32]int32{} // unit id -> def id
	for ci := range f.Chunks {
		frames, err := f.DecodeChunk(ci)
		if err != nil {
			return nil, err
		}
		codec := newFrameCodec(f.Meta.SampleEvery)
		for _, fr := range frames {
			// Records and instances (independent of the byte measurement).
			live := make(map[int32]bool, len(fr.Units))
			for _, u := range fr.Units {
				live[u.UnitID] = true
				d := defAgg(u.DefID)
				d.Records++
				if prevDef, ok := alive[u.UnitID]; !ok || prevDef != u.DefID {
					d.Instances++
				}
				alive[u.UnitID] = u.DefID
			}
			for id := range alive {
				if !live[id] {
					delete(alive, id)
				}
			}

			// Mirror encodeFrame's stream layout, summing varint lengths.
			// DecodeChunk returns units sorted by id — the encoder's order.
			q := make([]prevUnitState, len(fr.Units))
			for i, u := range fr.Units {
				q[i] = codec.quantize(u)
			}

			st.OverheadBytes += svLen(int64(fr.Frame) - codec.prevFrame)
			codec.prevFrame = int64(fr.Frame)

			var dead []int64
			for id := range codec.prev {
				if !live[id] {
					dead = append(dead, int64(id))
				}
			}
			sort.Slice(dead, func(i, j int) bool { return dead[i] < dead[j] })
			st.OverheadBytes += uvLen(uint64(len(dead)))
			last := int64(0)
			for _, id := range dead {
				defAgg(int32(codec.prev[int32(id)].def)).CoreBytes += svLen(id - last)
				last = id
			}

			changed := make([]int, 0, len(fr.Units))
			for i, u := range fr.Units {
				p, ok := codec.prev[u.UnitID]
				if !ok || p.advance() != q[i] {
					changed = append(changed, i)
				}
			}
			st.OverheadBytes += uvLen(uint64(len(changed)))
			last = 0
			for _, i := range changed {
				defAgg(fr.Units[i].DefID).CoreBytes += svLen(int64(fr.Units[i].UnitID) - last)
				last = int64(fr.Units[i].UnitID)
			}
			for _, col := range coreColumns {
				for _, i := range changed {
					base := int64(0)
					if p, ok := codec.prev[fr.Units[i].UnitID]; ok {
						pa := p.advance()
						base = *col(&pa)
					}
					defAgg(fr.Units[i].DefID).CoreBytes += svLen(*col(&q[i]) - base)
				}
			}
			res := make([]TeamResource, len(fr.Resources))
			copy(res, fr.Resources)
			sort.Slice(res, func(i, j int) bool { return res[i].Team < res[j].Team })
			st.ResourceBytes += uvLen(uint64(len(res)))
			for _, r := range res {
				p := codec.prevRes[r.Team]
				cur := prevResState{
					m: roundq(r.Metal * resScale), e: roundq(r.Energy * resScale),
					ms: roundq(r.MetalStorage * resScale), es: roundq(r.EnergyStorage * resScale),
					mi: roundq(r.MetalIncome * resScale), ei: roundq(r.EnergyIncome * resScale),
				}
				st.ResourceBytes += svLen(int64(r.Team)) +
					svLen(cur.m-p.m) + svLen(cur.e-p.e) +
					svLen(cur.ms-p.ms) + svLen(cur.es-p.es) +
					svLen(cur.mi-p.mi) + svLen(cur.ei-p.ei)
				codec.prevRes[r.Team] = cur
			}

			next := make(map[int32]prevUnitState, len(fr.Units))
			for i, u := range fr.Units {
				next[u.UnitID] = q[i]
			}
			codec.prev = next
		}
	}

	var defCore, defExtra int64
	for _, d := range agg {
		st.Defs = append(st.Defs, *d)
		defCore += d.CoreBytes
		defExtra += d.ExtraBytes
	}
	sort.Slice(st.Defs, func(i, j int) bool {
		a, b := &st.Defs[i], &st.Defs[j]
		if sa, sb := a.CoreBytes+a.ExtraBytes, b.CoreBytes+b.ExtraBytes; sa != sb {
			return sa > sb
		}
		return a.DefID < b.DefID
	})
	if defCore+st.OverheadBytes != st.CoreRaw || defExtra+st.ResourceBytes != st.ExtraRaw {
		return nil, fmt.Errorf("snapshot: stats attribution (%d def + %d overhead core bytes, %d def + %d resource extra bytes) does not match the encoded streams (%d core, %d extra): the stats measurer has drifted from the codec",
			defCore, st.OverheadBytes, defExtra, st.ResourceBytes, st.CoreRaw, st.ExtraRaw)
	}
	return st, nil
}
