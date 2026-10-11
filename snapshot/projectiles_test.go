package snapshot

import (
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The R and W sections round-trip through the writer and ParseBRP: every
// column exactly, except the stream's float velocity and gravity, which the
// file keeps to 0.01 elmo/frame and 1e-5 elmo/frame². The file sorts tracks
// by birth (then id) and blasts by frame whatever order they were written in.
func TestBRPProjectilesRoundTrip(t *testing.T) {
	meta, frames, events := testCapture()
	tracks := []Projectile{
		// Written out of order: the file sorts by birth.
		{Birth: 1500, End: 1620, ID: 7002, Weapon: 6, Owner: 501, Team: 0, Class: ProjNuke,
			EndKind: TrackExploded, Flags: TrackEngaged | TrackIntercepted,
			X0: 1030, Y0: 125, Z0: 1030, VX: 30, VY: 4.95, VZ: 30, Gravity: 0.05,
			TargetType: 'g', Target: -1, TX: 7000, TY: 0, TZ: 7000, X1: 4630, Y1: 362, Z1: 4630,
			Path: []PathPoint{{DF: 10, X: 1330, Y: 172, Z: 1330}, {DF: 20, X: 1630, Y: 215, Z: 1630}}},
		{Birth: 610, End: 670, ID: 7001, Weapon: 8, Owner: 502, Team: 0, Class: ProjArtillery,
			EndKind: TrackExploded, X0: 2033, Y0: 124, Z0: 2017, VX: 33.3, VY: 3.48, VZ: 16.7, Gravity: 0.12,
			TargetType: 'g', Target: -1, TX: 4000, TY: 0, TZ: 3000, X1: 4031, Y1: 120, Z1: 3019},
		// A beam: no velocity, its path is its hit points, a negative
		// coordinate past the map edge.
		{Birth: 1800, End: 1844, ID: 8000, Weapon: 9, Owner: 504, Team: 1, Class: ProjBeam,
			EndKind: TrackExploded, X0: 2600, Y0: 120, Z0: 3800, TargetType: 'u', Target: 123,
			TX: 3000, TY: 0, TZ: 4000, X1: 3640, Y1: 30, Z1: 4132,
			Path: []PathPoint{{DF: 0, X: 3000, Y: 30, Z: 4000}, {DF: 30, X: -12, Y: 30, Z: 4090}, {DF: 44, X: 3640, Y: 30, Z: 4132}}},
		// Unknown everything, still flying at the end.
		{Birth: 4150, End: 4195, ID: -1, Weapon: -1, Owner: -1, Team: -1, Class: ProjRocket,
			EndKind: TrackOpen, Target: -1},
	}
	blasts := []Blast{
		{Frame: 2100, Weapon: 11, X: 5000, Y: 60, Z: 5200, Unit: 505, Team: 1, Kind: BlastUnit},
		{Frame: 671, Weapon: 10, X: 4071, Y: 120, Z: 3019, Unit: 502, Team: 0, Kind: BlastStray},
		{Frame: 671, Weapon: 10, X: 3991, Y: -5, Z: 3044, Unit: -1, Team: -1, Kind: BlastStray},
	}

	dir := t.TempDir()
	w, err := NewBRPWriter(dir, meta.GameID)
	if err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(w.WriteMeta(meta))
	for _, fr := range frames {
		must(w.WriteFrame(fr))
	}
	for _, e := range events {
		must(w.WriteEvent(e))
	}
	for _, p := range tracks {
		must(w.WriteProjectile(p))
	}
	for _, b := range blasts {
		must(w.WriteBlast(b))
	}
	must(w.Close())

	f, err := os.Open(filepath.Join(dir, meta.GameID+".brp"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	bf, err := ParseBRP(f)
	if err != nil {
		t.Fatal(err)
	}

	gotTracks, err := bf.Projectiles()
	if err != nil {
		t.Fatal(err)
	}
	wantTracks := []Projectile{tracks[1], tracks[0], tracks[2], tracks[3]}
	if len(gotTracks) != len(wantTracks) {
		t.Fatalf("got %d tracks, want %d", len(gotTracks), len(wantTracks))
	}
	near := func(a, b float32, eps float64) bool { return math.Abs(float64(a-b)) <= eps }
	for i, want := range wantTracks {
		got := gotTracks[i]
		if !near(got.VX, want.VX, 0.005) || !near(got.VY, want.VY, 0.005) || !near(got.VZ, want.VZ, 0.005) ||
			!near(got.Gravity, want.Gravity, 0.000005) {
			t.Errorf("track %d velocity/gravity = %v %v %v / %v, want %v %v %v / %v",
				i, got.VX, got.VY, got.VZ, got.Gravity, want.VX, want.VY, want.VZ, want.Gravity)
		}
		got.VX, got.VY, got.VZ, got.Gravity = want.VX, want.VY, want.VZ, want.Gravity
		if !reflect.DeepEqual(got, want) {
			t.Errorf("track %d:\n got %+v\nwant %+v", i, got, want)
		}
	}
	if !gotTracks[1].Intercepted() || gotTracks[0].Intercepted() {
		t.Error("Intercepted() reads the wrong flag")
	}

	gotBlasts, err := bf.Blasts()
	if err != nil {
		t.Fatal(err)
	}
	wantBlasts := []Blast{blasts[1], blasts[2], blasts[0]}
	if !reflect.DeepEqual(gotBlasts, wantBlasts) {
		t.Errorf("blasts:\n got %+v\nwant %+v", gotBlasts, wantBlasts)
	}

	// Analysis sections go last, past everything the viewer reads.
	if !(bf.SectionOffsets[SecExtra] < bf.SectionOffsets[SecProjectiles] &&
		bf.SectionOffsets[SecProjectiles] < bf.SectionOffsets[SecBlasts]) {
		t.Errorf("section offsets X %d, R %d, W %d: want X < R < W",
			bf.SectionOffsets[SecExtra], bf.SectionOffsets[SecProjectiles], bf.SectionOffsets[SecBlasts])
	}
}

// A capture without the protocol-5 records writes neither section, and the
// accessors answer nil rather than an error.
func TestBRPWithoutProjectiles(t *testing.T) {
	meta, frames, events := testCapture()
	dir := t.TempDir()
	w, err := NewBRPWriter(dir, meta.GameID)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}
	for _, fr := range frames {
		if err := w.WriteFrame(fr); err != nil {
			t.Fatal(err)
		}
	}
	for _, e := range events {
		if err := w.WriteEvent(e); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(filepath.Join(dir, meta.GameID+".brp"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	bf, err := ParseBRP(f)
	if err != nil {
		t.Fatal(err)
	}
	for _, tag := range []byte{SecProjectiles, SecBlasts} {
		if _, ok := bf.Sections[tag]; ok {
			t.Errorf("capture without projectiles wrote a %q section", tag)
		}
	}
	if ps, err := bf.Projectiles(); ps != nil || err != nil {
		t.Errorf("Projectiles() = %v, %v; want nil, nil", ps, err)
	}
	if bs, err := bf.Blasts(); bs != nil || err != nil {
		t.Errorf("Blasts() = %v, %v; want nil, nil", bs, err)
	}
}

// A truncated or corrupt section is an error, never a panic or a huge
// allocation.
func TestDecodeProjectilesRejectsCorrupt(t *testing.T) {
	good := encodeProjectiles([]Projectile{{Birth: 10, End: 20, ID: 1, Weapon: 2, Owner: 3, Team: 0,
		Class: ProjNuke, EndKind: TrackExploded, Target: -1,
		Path: []PathPoint{{DF: 5, X: 1, Y: 2, Z: 3}}}})
	for n := 0; n < len(good); n++ {
		if _, err := decodeProjectiles(good[:n]); err == nil {
			t.Errorf("decodeProjectiles accepted %d of %d bytes", n, len(good))
		}
	}
	if _, err := decodeProjectiles([]byte{0xff, 0xff, 0xff, 0xff, 0x0f}); err == nil {
		t.Error("decodeProjectiles accepted an impossible row count")
	}
	goodB := encodeBlasts([]Blast{{Frame: 5, Weapon: 1, X: 1, Y: 2, Z: 3, Unit: 4, Team: 0, Kind: BlastUnit}})
	for n := 0; n < len(goodB); n++ {
		if _, err := decodeBlasts(goodB[:n]); err == nil {
			t.Errorf("decodeBlasts accepted %d of %d bytes", n, len(goodB))
		}
	}
}
