package snapshot

import (
	"os"
	"path/filepath"
	"testing"
)

func computeStats(t *testing.T, path string) *BRPStats {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	bf, err := ParseBRP(f)
	if err != nil {
		t.Fatal(err)
	}
	st, err := ComputeBRPStats(bf)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

// The stats must attribute EVERY encoded stream byte (ComputeBRPStats
// self-checks the totals against the real decompressed sections and errors on
// drift — so a passing run already proves the measurer matches the codec) and
// count records/instances per def correctly.
func TestBRPStats(t *testing.T) {
	meta, frames, events := testCapture()
	path := writeBRP(t, t.TempDir(), meta, frames, events)
	st := computeStats(t, path)

	// All five sections, in file order, with sane sizes.
	wantSecs := []byte{SecMeta, SecKeyframes, SecFrames, SecExtra, SecEvents}
	if len(st.Sections) != len(wantSecs) {
		t.Fatalf("sections = %+v", st.Sections)
	}
	for i, tag := range wantSecs {
		s := st.Sections[i]
		if s.Tag != tag || s.Stored <= 0 || s.Raw <= 0 || s.Name == "" {
			t.Errorf("section[%d] = %+v, want tag %q with non-zero sizes", i, s, tag)
		}
	}

	// testCapture: armcom (def 1) is unit 100 in frames 1-2; corllt (def 2) is
	// unit 200 (3 frames) + unit 300 (2 frames).
	if len(st.Defs) != 2 {
		t.Fatalf("defs = %+v", st.Defs)
	}
	byID := map[int32]BRPDefStat{}
	for _, d := range st.Defs {
		byID[d.DefID] = d
		if d.CoreBytes <= 0 {
			t.Errorf("def %d: no core bytes attributed: %+v", d.DefID, d)
		}
	}
	if d := byID[1]; d.Name != "armcom" || d.Records != 2 || d.Instances != 1 {
		t.Errorf("armcom stats = %+v, want 2 records / 1 instance", d)
	}
	if d := byID[2]; d.Name != "corllt" || d.Records != 5 || d.Instances != 2 {
		t.Errorf("corllt stats = %+v, want 5 records / 2 instances", d)
	}

	// Defs are sorted by attributed size, and the totals reconcile.
	var defCore, defExtra int64
	for i, d := range st.Defs {
		if i > 0 {
			prev := st.Defs[i-1]
			if prev.CoreBytes+prev.ExtraBytes < d.CoreBytes+d.ExtraBytes {
				t.Errorf("defs not sorted by size: %+v", st.Defs)
			}
		}
		defCore += d.CoreBytes
		defExtra += d.ExtraBytes
	}
	if defCore+st.OverheadBytes != st.CoreRaw {
		t.Errorf("core bytes: %d def + %d overhead != %d raw", defCore, st.OverheadBytes, st.CoreRaw)
	}
	if defExtra+st.ResourceBytes != st.ExtraRaw {
		t.Errorf("extra bytes: %d def + %d resources != %d raw", defExtra, st.ResourceBytes, st.ExtraRaw)
	}
	if st.ResourceBytes <= 0 {
		t.Errorf("resource bytes = %d, capture has resources", st.ResourceBytes)
	}
}

// Instances must count unit LIFETIMES: a unit alive across a chunk boundary is
// one instance (the per-chunk codec reset must not recount it), a recycled id
// with a different def is a new one.
func TestBRPStatsMultiChunkInstances(t *testing.T) {
	meta, _, _ := testCapture()
	var frames []Frame
	for i := 0; i < 150; i++ { // 3 chunks: 64 + 64 + 22
		fr := Frame{Frame: int32(30 * (i + 1))}
		for u := 0; u < 5; u++ {
			if u == 4 && i >= 100 {
				continue // unit 104 dies at sample 100...
			}
			fr.Units = append(fr.Units, UnitState{
				UnitID: int32(100 + u), DefID: 1, Team: 0,
				Pos:    Vec3{X: float32(10*u + i), Z: float32(2000 - i*2)},
				Health: float32(3000 - i), MaxHealth: 3000, VelX: 1, VelZ: -2,
			})
		}
		if i >= 100 { // ...and its id comes back as a different def
			fr.Units = append(fr.Units, UnitState{
				UnitID: 104, DefID: 2, Team: 1,
				Pos: Vec3{X: 50, Z: 60}, Health: 800, MaxHealth: 800,
			})
		}
		frames = append(frames, fr)
	}

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
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	st := computeStats(t, filepath.Join(dir, meta.GameID+".brp"))

	byID := map[int32]BRPDefStat{}
	for _, d := range st.Defs {
		byID[d.DefID] = d
	}
	// def 1: units 100-103 live all 150 samples, unit 104 the first 100.
	if d := byID[1]; d.Instances != 5 || d.Records != 4*150+100 {
		t.Errorf("def 1 = %+v, want 5 instances / %d records", d, 4*150+100)
	}
	// def 2: the recycled id 104 for the last 50 samples.
	if d := byID[2]; d.Instances != 1 || d.Records != 50 {
		t.Errorf("def 2 = %+v, want 1 instance / 50 records", d)
	}
}

// An empty capture yields empty stats, not an error (its F payload is zero
// bytes — no gzip stream at all).
func TestBRPStatsEmptyCapture(t *testing.T) {
	dir := t.TempDir()
	w, err := NewBRPWriter(dir, "empty")
	if err != nil {
		t.Fatal(err)
	}
	if err := w.WriteMeta(Meta{GameID: "empty"}); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	st := computeStats(t, filepath.Join(dir, "empty.brp"))
	if len(st.Defs) != 0 || st.CoreRaw != 0 || st.OverheadBytes != 0 {
		t.Errorf("empty capture stats = %+v", st)
	}
	if len(st.Sections) != 5 {
		t.Errorf("sections = %+v", st.Sections)
	}
}
