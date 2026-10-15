package snapshot

import (
	"bytes"
	"fmt"
	"math"
	"sort"
)

// Projectile and beam tracks (R) and strong explosions (W): the re-sim's
// protocol-5 records. The widget decides what to watch from the weapon defs
// and writes what the engine reported; everything a report concludes from
// them — who a nuke hit, whether an anti-nuke saved a base, what a reactor
// chain destroyed — is derived on read, from these plus the H hits. Byte
// formats: docs/brepstream-format.md ("Protocol 5") for the stream,
// docs/brp-format.md §9.2 for the sections here.

const (
	SecProjectiles byte = 'R' // projectile and beam tracks
	SecBlasts      byte = 'W' // strong explosions that end no track (blast Waves)
)

// Track classes: the widget's classification of the weapon that fired, by
// the rules in docs/brepstream-format.md. The weapon's wdefs entry names the
// class too, so a reader never needs this table to know what it is reading.
const (
	ProjNuke      uint8 = 1
	ProjAntiNuke  uint8 = 2
	ProjEMP       uint8 = 3
	ProjTactical  uint8 = 4
	ProjJuno      uint8 = 5
	ProjArtillery uint8 = 6
	ProjRocket    uint8 = 7
	ProjBeam      uint8 = 8
	ProjAA        uint8 = 9 // long-range anti-air (widget >= 1.11.0)
)

var projClassNames = map[uint8]string{
	ProjNuke: "nuke", ProjAntiNuke: "antinuke", ProjEMP: "emp", ProjTactical: "tactical",
	ProjJuno: "juno", ProjArtillery: "artillery", ProjRocket: "rocket", ProjBeam: "beam",
	ProjAA: "aa",
}

// ProjectileClassName is the class's name as the wdefs fact spells it, or ""
// for a code this reader does not know.
func ProjectileClassName(c uint8) string { return projClassNames[c] }

// How a track ended.
const (
	TrackOpen     uint8 = 0 // still in flight when the game ended
	TrackExploded uint8 = 1 // an explosion carried its id (a beam: it hit something)
	TrackVanished uint8 = 2 // gone with no explosion (a beam: it never hit)
)

// Track flags.
const (
	TrackEngaged       uint8 = 1 // an interceptor targeted it
	TrackIntercepted   uint8 = 2 // destroyed by the interceptor that targeted it
	TrackPathTruncated uint8 = 4 // the path hit the widget's point cap
	// TrackEndInferred: no explosion was seen (a sandboxed BAR build denies
	// the widget the callin). A track's end is one frame past where the
	// projectile was last seen; a beam's one hit is its target at firing.
	TrackEndInferred   uint8 = 8
	maxTrackPathPoints       = 1 << 16
)

// PathPoint is one sampled position of a track: DF frames after its birth,
// whole elmos. A beam's points are where it hit.
type PathPoint struct {
	DF int32 `json:"df"`
	X  int32 `json:"x"`
	Y  int32 `json:"y"`
	Z  int32 `json:"z"`
}

// Projectile is one track: a projectile of a tracked weapon from launch to
// its end, or one firing of a tracked beam. Unknown ids are -1.
type Projectile struct {
	Birth int32 `json:"birth"` // sim frame of the launch (a beam: its first frame)
	End   int32 `json:"end"`   // the explosion / last frame seen
	// ID is the engine's projectile id (a beam: its first hit's segment id).
	// Ids are recycled, so (ID, Birth) names a track.
	ID      int32 `json:"id"`
	Weapon  int32 `json:"weapon"`
	Owner   int32 `json:"owner"` // the launcher unit
	Team    int32 `json:"team"`  // its team at launch
	Class   uint8 `json:"class"`
	EndKind uint8 `json:"endKind"`
	Flags   uint8 `json:"flags,omitempty"`
	// Launch position (a beam's muzzle) and velocity in elmos per frame.
	X0      int32   `json:"x0"`
	Y0      int32   `json:"y0"`
	Z0      int32   `json:"z0"`
	VX      float32 `json:"vx"`
	VY      float32 `json:"vy"`
	VZ      float32 `json:"vz"`
	Gravity float32 `json:"gravity"` // per frame², as the engine reported it
	// TargetType is the engine's byte: 'u' unit, 'g' ground, 'f' feature,
	// 'p' projectile (an interceptor's target), 0 none. Target is the id, -1
	// for none or a ground target; TX/TY/TZ where the target was at launch.
	TargetType uint8 `json:"targetType,omitempty"`
	Target     int32 `json:"target"`
	TX         int32 `json:"tx"`
	TY         int32 `json:"ty"`
	TZ         int32 `json:"tz"`
	// End position: the explosion, or where it was last seen.
	X1   int32       `json:"x1"`
	Y1   int32       `json:"y1"`
	Z1   int32       `json:"z1"`
	Path []PathPoint `json:"path,omitempty"`
}

// Intercepted reports whether an interceptor destroyed it.
func (p Projectile) Intercepted() bool { return p.Flags&TrackIntercepted != 0 }

// Blast kinds.
const (
	BlastUnit  uint8 = 1 // a unit's own death or self-destruct explosion
	BlastStray uint8 = 2 // a watched projectile's explosion that ended no track
)

// Blast is one strong explosion that is not the end of a track: a unit's
// own (Unit = the unit that exploded) or a projectile's no track was open
// for, like a cluster sub-munition (Unit = its owner). What it did is in the
// hits: its weapon, around (X, Z), from Frame on.
type Blast struct {
	Frame  int32 `json:"f"`
	Weapon int32 `json:"weapon"`
	X      int32 `json:"x"`
	Y      int32 `json:"y"`
	Z      int32 `json:"z"`
	Unit   int32 `json:"unit"`
	Team   int32 `json:"team"`
	Kind   uint8 `json:"kind"`
}

// sortProjectiles orders tracks by birth, then id, then weapon and owner —
// what the encoder writes, so a capture always packs to the same bytes.
func sortProjectiles(ps []Projectile) []Projectile {
	out := append([]Projectile(nil), ps...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Birth != b.Birth {
			return a.Birth < b.Birth
		}
		if a.ID != b.ID {
			return a.ID < b.ID
		}
		if a.Weapon != b.Weapon {
			return a.Weapon < b.Weapon
		}
		return a.Owner < b.Owner
	})
	return out
}

// sortBlasts orders blasts by frame (stable: the stream's order breaks ties).
func sortBlasts(bs []Blast) []Blast {
	out := append([]Blast(nil), bs...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Frame < out[j].Frame })
	return out
}

// Quantization of the stream's float columns (docs/brp-format.md §9.2): the
// velocity to 0.01 elmo per frame, the gravity to 1e-5 elmo per frame².
const (
	projVelScale     = 100
	projGravityScale = 100000
)

func roundScaled(f float32, scale float64) int64 {
	if math.IsNaN(float64(f)) || math.IsInf(float64(f), 0) {
		return 0
	}
	return int64(math.Round(float64(f) * scale))
}

// encodeProjectiles: count, then the tracks column by column (sorted by
// birth), then every track's path points in track order.
func encodeProjectiles(in []Projectile) []byte {
	ps := sortProjectiles(in)
	var buf bytes.Buffer
	vw := &varintWriter{w: &buf}
	vw.uv(uint64(len(ps)))
	prev := int64(0)
	for _, p := range ps {
		vw.sv(int64(p.Birth) - prev)
		prev = int64(p.Birth)
	}
	uvCol := func(get func(p Projectile) uint64) {
		for _, p := range ps {
			vw.uv(get(p))
		}
	}
	svCol := func(get func(p Projectile) int64) {
		for _, p := range ps {
			vw.sv(get(p))
		}
	}
	uvCol(func(p Projectile) uint64 {
		if p.End < p.Birth {
			return 0
		}
		return uint64(p.End - p.Birth)
	})
	uvCol(func(p Projectile) uint64 { return idPlus(p.ID) })
	uvCol(func(p Projectile) uint64 { return idPlus(p.Weapon) })
	uvCol(func(p Projectile) uint64 { return idPlus(p.Owner) })
	uvCol(func(p Projectile) uint64 { return idPlus(p.Team) })
	uvCol(func(p Projectile) uint64 { return uint64(p.Class) })
	uvCol(func(p Projectile) uint64 { return uint64(p.EndKind) })
	uvCol(func(p Projectile) uint64 { return uint64(p.Flags) })
	svCol(func(p Projectile) int64 { return int64(p.X0) })
	svCol(func(p Projectile) int64 { return int64(p.Y0) })
	svCol(func(p Projectile) int64 { return int64(p.Z0) })
	svCol(func(p Projectile) int64 { return roundScaled(p.VX, projVelScale) })
	svCol(func(p Projectile) int64 { return roundScaled(p.VY, projVelScale) })
	svCol(func(p Projectile) int64 { return roundScaled(p.VZ, projVelScale) })
	svCol(func(p Projectile) int64 { return roundScaled(p.Gravity, projGravityScale) })
	uvCol(func(p Projectile) uint64 { return uint64(p.TargetType) })
	uvCol(func(p Projectile) uint64 { return idPlus(p.Target) })
	svCol(func(p Projectile) int64 { return int64(p.TX - p.X0) })
	svCol(func(p Projectile) int64 { return int64(p.TY) })
	svCol(func(p Projectile) int64 { return int64(p.TZ - p.Z0) })
	svCol(func(p Projectile) int64 { return int64(p.X1 - p.X0) })
	svCol(func(p Projectile) int64 { return int64(p.Y1) })
	svCol(func(p Projectile) int64 { return int64(p.Z1 - p.Z0) })
	uvCol(func(p Projectile) uint64 { return uint64(len(p.Path)) })
	for _, p := range ps {
		px, pz := int64(p.X0), int64(p.Z0)
		for _, pt := range p.Path {
			df := pt.DF
			if df < 0 {
				df = 0
			}
			vw.uv(uint64(df))
			vw.sv(int64(pt.X) - px)
			vw.sv(int64(pt.Y))
			vw.sv(int64(pt.Z) - pz)
			px, pz = int64(pt.X), int64(pt.Z)
		}
	}
	return buf.Bytes()
}

func decodeProjectiles(b []byte) ([]Projectile, error) {
	vr := &varintReader{b: b}
	n, err := vr.uv()
	if err != nil {
		return nil, err
	}
	if n > uint64(len(b)) {
		return nil, fmt.Errorf("snapshot: projectile count %d exceeds section", n)
	}
	ps := make([]Projectile, n)
	prev := int64(0)
	for i := range ps {
		d, err := vr.sv()
		if err != nil {
			return nil, err
		}
		prev += d
		ps[i].Birth = int32(prev)
	}
	uvCol := func(set func(p *Projectile, v uint64)) error {
		for i := range ps {
			v, err := vr.uv()
			if err != nil {
				return err
			}
			set(&ps[i], v)
		}
		return nil
	}
	svCol := func(set func(p *Projectile, v int64)) error {
		for i := range ps {
			v, err := vr.sv()
			if err != nil {
				return err
			}
			set(&ps[i], v)
		}
		return nil
	}
	steps := []func() error{
		func() error { return uvCol(func(p *Projectile, v uint64) { p.End = p.Birth + int32(v) }) },
		func() error { return uvCol(func(p *Projectile, v uint64) { p.ID = int32(v) - 1 }) },
		func() error { return uvCol(func(p *Projectile, v uint64) { p.Weapon = int32(v) - 1 }) },
		func() error { return uvCol(func(p *Projectile, v uint64) { p.Owner = int32(v) - 1 }) },
		func() error { return uvCol(func(p *Projectile, v uint64) { p.Team = int32(v) - 1 }) },
		func() error { return uvCol(func(p *Projectile, v uint64) { p.Class = uint8(v) }) },
		func() error { return uvCol(func(p *Projectile, v uint64) { p.EndKind = uint8(v) }) },
		func() error { return uvCol(func(p *Projectile, v uint64) { p.Flags = uint8(v) }) },
		func() error { return svCol(func(p *Projectile, v int64) { p.X0 = int32(v) }) },
		func() error { return svCol(func(p *Projectile, v int64) { p.Y0 = int32(v) }) },
		func() error { return svCol(func(p *Projectile, v int64) { p.Z0 = int32(v) }) },
		func() error { return svCol(func(p *Projectile, v int64) { p.VX = float32(v) / projVelScale }) },
		func() error { return svCol(func(p *Projectile, v int64) { p.VY = float32(v) / projVelScale }) },
		func() error { return svCol(func(p *Projectile, v int64) { p.VZ = float32(v) / projVelScale }) },
		func() error {
			return svCol(func(p *Projectile, v int64) { p.Gravity = float32(float64(v) / projGravityScale) })
		},
		func() error { return uvCol(func(p *Projectile, v uint64) { p.TargetType = uint8(v) }) },
		func() error { return uvCol(func(p *Projectile, v uint64) { p.Target = int32(v) - 1 }) },
		func() error { return svCol(func(p *Projectile, v int64) { p.TX = p.X0 + int32(v) }) },
		func() error { return svCol(func(p *Projectile, v int64) { p.TY = int32(v) }) },
		func() error { return svCol(func(p *Projectile, v int64) { p.TZ = p.Z0 + int32(v) }) },
		func() error { return svCol(func(p *Projectile, v int64) { p.X1 = p.X0 + int32(v) }) },
		func() error { return svCol(func(p *Projectile, v int64) { p.Y1 = int32(v) }) },
		func() error { return svCol(func(p *Projectile, v int64) { p.Z1 = p.Z0 + int32(v) }) },
	}
	for _, s := range steps {
		if err := s(); err != nil {
			return nil, err
		}
	}
	counts := make([]uint64, n)
	total := uint64(0)
	for i := range counts {
		c, err := vr.uv()
		if err != nil {
			return nil, err
		}
		if c > maxTrackPathPoints {
			return nil, fmt.Errorf("snapshot: track %d claims %d path points", i, c)
		}
		counts[i] = c
		total += c
	}
	if total > uint64(len(b)) {
		return nil, fmt.Errorf("snapshot: %d path points exceed section", total)
	}
	for i := range ps {
		if counts[i] == 0 {
			continue
		}
		pts := make([]PathPoint, counts[i])
		px, pz := int64(ps[i].X0), int64(ps[i].Z0)
		for k := range pts {
			df, err := vr.uv()
			if err != nil {
				return nil, err
			}
			dx, err := vr.sv()
			if err != nil {
				return nil, err
			}
			y, err := vr.sv()
			if err != nil {
				return nil, err
			}
			dz, err := vr.sv()
			if err != nil {
				return nil, err
			}
			px += dx
			pz += dz
			pts[k] = PathPoint{DF: int32(df), X: int32(px), Y: int32(y), Z: int32(pz)}
		}
		ps[i].Path = pts
	}
	return ps, nil
}

// encodeBlasts: count, then the blasts column by column (sorted by frame),
// frame and position delta-coded against the previous blast.
func encodeBlasts(in []Blast) []byte {
	bs := sortBlasts(in)
	var buf bytes.Buffer
	vw := &varintWriter{w: &buf}
	vw.uv(uint64(len(bs)))
	delta := func(get func(b Blast) int32) {
		prev := int64(0)
		for _, b := range bs {
			v := int64(get(b))
			vw.sv(v - prev)
			prev = v
		}
	}
	delta(func(b Blast) int32 { return b.Frame })
	for _, b := range bs {
		vw.uv(idPlus(b.Weapon))
	}
	delta(func(b Blast) int32 { return b.X })
	for _, b := range bs {
		vw.sv(int64(b.Y))
	}
	delta(func(b Blast) int32 { return b.Z })
	for _, b := range bs {
		vw.uv(idPlus(b.Unit))
	}
	for _, b := range bs {
		vw.uv(idPlus(b.Team))
	}
	for _, b := range bs {
		vw.uv(uint64(b.Kind))
	}
	return buf.Bytes()
}

func decodeBlasts(b []byte) ([]Blast, error) {
	vr := &varintReader{b: b}
	n, err := vr.uv()
	if err != nil {
		return nil, err
	}
	if n > uint64(len(b)) {
		return nil, fmt.Errorf("snapshot: blast count %d exceeds section", n)
	}
	bs := make([]Blast, n)
	delta := func(set func(x *Blast, v int32)) error {
		prev := int64(0)
		for i := range bs {
			d, err := vr.sv()
			if err != nil {
				return err
			}
			prev += d
			set(&bs[i], int32(prev))
		}
		return nil
	}
	uvCol := func(set func(x *Blast, v uint64)) error {
		for i := range bs {
			v, err := vr.uv()
			if err != nil {
				return err
			}
			set(&bs[i], v)
		}
		return nil
	}
	steps := []func() error{
		func() error { return delta(func(x *Blast, v int32) { x.Frame = v }) },
		func() error { return uvCol(func(x *Blast, v uint64) { x.Weapon = int32(v) - 1 }) },
		func() error { return delta(func(x *Blast, v int32) { x.X = v }) },
		func() error {
			for i := range bs {
				v, err := vr.sv()
				if err != nil {
					return err
				}
				bs[i].Y = int32(v)
			}
			return nil
		},
		func() error { return delta(func(x *Blast, v int32) { x.Z = v }) },
		func() error { return uvCol(func(x *Blast, v uint64) { x.Unit = int32(v) - 1 }) },
		func() error { return uvCol(func(x *Blast, v uint64) { x.Team = int32(v) - 1 }) },
		func() error { return uvCol(func(x *Blast, v uint64) { x.Kind = uint8(v) }) },
	}
	for _, s := range steps {
		if err := s(); err != nil {
			return nil, err
		}
	}
	return bs, nil
}

// Projectiles decodes the R section (nil when the capture has none).
func (f *BRPFile) Projectiles() ([]Projectile, error) {
	b, ok, err := f.section(SecProjectiles, "projectiles")
	if !ok || err != nil {
		return nil, err
	}
	return decodeProjectiles(b)
}

// Blasts decodes the W section (nil when the capture has none).
func (f *BRPFile) Blasts() ([]Blast, error) {
	b, ok, err := f.section(SecBlasts, "blasts")
	if !ok || err != nil {
		return nil, err
	}
	return decodeBlasts(b)
}
