package snapshot

import (
	"bytes"
	"fmt"
	"sort"
)

// Shield charge (Q): what Spring.GetUnitShieldState read for each shield
// generator (Keeper/Overseer, the T3 gates, Legion's deflector, the shielded
// evolving commanders) at the samples where it CHANGED. Where a shield is
// already follows from the frames, and how big it is from the unit def
// (UnitDef.ShieldRadius/ShieldPower), so a row carries only the reading.
// Byte formats: docs/brepstream-format.md ("Protocol 6") for the stream,
// docs/brp-format.md §9.3 for the section.

const SecShields byte = 'Q' // shield charge readings

// Shield is one reading: the unit's shield held Power at Frame and was (or
// was not) switched on. The widget writes a row only when the reading moved
// (see the widget's shield section), so a reader holds each row until the
// unit's next one. Power is whole points, as GetUnitShieldState reports it,
// rounded.
type Shield struct {
	Frame   int32 `json:"f"`
	Unit    int32 `json:"unit"`
	Power   int32 `json:"power"`
	Enabled bool  `json:"on"`
}

// sortShields orders readings by frame (stable: the stream's order breaks
// ties).
func sortShields(in []Shield) []Shield {
	out := append([]Shield(nil), in...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Frame < out[j].Frame })
	return out
}

// encodeShields: count, then the readings column by column (sorted by
// frame): frame delta-coded against the previous reading, unit id, power,
// flags (bit 0 = enabled).
func encodeShields(in []Shield) []byte {
	ss := sortShields(in)
	var buf bytes.Buffer
	vw := &varintWriter{w: &buf}
	vw.uv(uint64(len(ss)))
	prev := int64(0)
	for _, s := range ss {
		vw.sv(int64(s.Frame) - prev)
		prev = int64(s.Frame)
	}
	for _, s := range ss {
		vw.uv(idPlus(s.Unit))
	}
	for _, s := range ss {
		vw.sv(int64(s.Power))
	}
	for _, s := range ss {
		f := uint64(0)
		if s.Enabled {
			f = 1
		}
		vw.uv(f)
	}
	return buf.Bytes()
}

func decodeShields(b []byte) ([]Shield, error) {
	vr := &varintReader{b: b}
	n, err := vr.uv()
	if err != nil {
		return nil, err
	}
	if n > uint64(len(b)) {
		return nil, fmt.Errorf("snapshot: shield count %d exceeds section", n)
	}
	ss := make([]Shield, n)
	prev := int64(0)
	for i := range ss {
		d, err := vr.sv()
		if err != nil {
			return nil, err
		}
		prev += d
		ss[i].Frame = int32(prev)
	}
	for i := range ss {
		v, err := vr.uv()
		if err != nil {
			return nil, err
		}
		ss[i].Unit = int32(v) - 1
	}
	for i := range ss {
		v, err := vr.sv()
		if err != nil {
			return nil, err
		}
		ss[i].Power = int32(v)
	}
	for i := range ss {
		v, err := vr.uv()
		if err != nil {
			return nil, err
		}
		ss[i].Enabled = v&1 != 0
	}
	return ss, nil
}

// Shields decodes the Q section (nil when the capture has none).
func (f *BRPFile) Shields() ([]Shield, error) {
	b, ok, err := f.section(SecShields, "shields")
	if !ok || err != nil {
		return nil, err
	}
	return decodeShields(b)
}
