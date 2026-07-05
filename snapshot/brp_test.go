package snapshot

import (
	"bytes"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// testMeta/testFrames/testEvents build a small capture exercising the codec's
// edge cases: units appearing/disappearing between frames, moving/stationary
// units, under-construction units, resources, and multiple event kinds.
func testCapture() (Meta, []Frame, []Event) {
	meta := Meta{
		GameID:        "game-1",
		EngineVersion: "2025.06.24",
		GameVersion:   "BAR test-1",
		MapName:       "Test Map",
		StartUnix:     1700000000,
		SampleEvery:   30,
		UnitDefs: map[int32]UnitDef{
			1: {DefID: 1, Name: "armcom", CanMove: true},
			2: {DefID: 2, Name: "corllt", XSize: 2, ZSize: 3, IsBuilding: true},
		},
		Teams: []TeamInfo{
			{TeamID: 0, AllyTeam: 0, Side: "armada", Color: "#ff0000"},
			{TeamID: 1, AllyTeam: 1, Side: "cortex"},
		},
		Players: []PlayerInfo{{PlayerID: 0, Name: "alice", Team: 0, Skill: 22.5}},
	}
	frames := []Frame{
		{Frame: 30, TimeSec: 1, Units: []UnitState{
			// deliberately unsorted by id: the writer sorts
			{UnitID: 200, DefID: 2, Team: 1, Pos: Vec3{X: -50, Y: 12, Z: 80}, Health: 400, MaxHealth: 800, BuildProgress: 0.5},
			{UnitID: 100, DefID: 1, Team: 0, Pos: Vec3{X: 10, Y: 5, Z: 20}, Health: 3000, MaxHealth: 3000, VelX: 2, VelZ: -1, BuildProgress: 1},
		}, Resources: []TeamResource{
			{Team: 0, Metal: 1000.25, Energy: 500, MetalStorage: 1500, EnergyStorage: 6000, MetalIncome: 2.3, EnergyIncome: 105.7},
			{Team: 1, Metal: 900, Energy: 400, MetalStorage: 1500, EnergyStorage: 6000, MetalIncome: 1.9, EnergyIncome: 90},
		}},
		{Frame: 60, TimeSec: 2, Units: []UnitState{
			// unit 100 moved by its velocity (perfect prediction), 200 finished building
			{UnitID: 100, DefID: 1, Team: 0, Pos: Vec3{X: 70, Y: 5, Z: -10}, Health: 2500, MaxHealth: 3000, VelX: 2, VelZ: -1, BuildProgress: 1},
			{UnitID: 200, DefID: 2, Team: 1, Pos: Vec3{X: -50, Y: 12, Z: 80}, Health: 800, MaxHealth: 800, BuildProgress: 1},
			// a new unit appears
			{UnitID: 300, DefID: 2, Team: 1, Pos: Vec3{X: 1000, Y: 0, Z: 2000}, Health: 100, MaxHealth: 800, BuildProgress: 0.1},
		}, Resources: []TeamResource{
			{Team: 0, Metal: 1100, Energy: 600, MetalStorage: 1500, EnergyStorage: 6000, MetalIncome: 2.4, EnergyIncome: 110},
		}},
		{Frame: 90, TimeSec: 3, Units: []UnitState{
			// unit 100 gone (destroyed), 200 persists
			{UnitID: 200, DefID: 2, Team: 1, Pos: Vec3{X: -50, Y: 12, Z: 80}, Health: 700, MaxHealth: 800, BuildProgress: 1},
			{UnitID: 300, DefID: 2, Team: 1, Pos: Vec3{X: 1000, Y: 0, Z: 2000}, Health: 300, MaxHealth: 800, BuildProgress: 0.4},
		}},
	}
	events := []Event{
		{Frame: 15, Kind: EventCreated, UnitID: 200, DefID: 2, Team: 1},
		{Frame: 45, Kind: EventFinished, UnitID: 200, DefID: 2, Team: 1},
		{Frame: 75, Kind: EventDestroyed, UnitID: 100, DefID: 1, Team: 0},
	}
	return meta, frames, events
}

func writeBRP(t *testing.T, dir string, meta Meta, frames []Frame, events []Event) string {
	t.Helper()
	w, err := NewBRPWriter(dir, meta.GameID)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}
	// Interleave like capture does: frame, then its events.
	if err := w.WriteFrame(frames[0]); err != nil {
		t.Fatal(err)
	}
	for _, e := range events[:2] {
		if err := w.WriteEvent(e); err != nil {
			t.Fatal(err)
		}
	}
	for _, fr := range frames[1:] {
		if err := w.WriteFrame(fr); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.WriteEvent(events[2]); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, meta.GameID+".brp")
}

func TestBRPRoundTrip(t *testing.T) {
	meta, frames, events := testCapture()
	path := writeBRP(t, t.TempDir(), meta, frames, events)

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gotMeta, gotFrames, gotEvents, err := ReadBRP(f)
	if err != nil {
		t.Fatal(err)
	}

	if gotMeta.GameID != meta.GameID || gotMeta.MapName != meta.MapName || gotMeta.SampleEvery != 30 {
		t.Errorf("meta = %+v", gotMeta)
	}
	if gotMeta.UnitDefs[1].Name != "armcom" || gotMeta.Teams[0].Color != "#ff0000" || gotMeta.Players[0].Skill != 22.5 {
		t.Errorf("meta detail lost: %+v", gotMeta)
	}

	if len(gotFrames) != len(frames) {
		t.Fatalf("frames: got %d want %d", len(gotFrames), len(frames))
	}
	for fi, want := range frames {
		got := gotFrames[fi]
		if got.Frame != want.Frame {
			t.Errorf("frame[%d].Frame = %d want %d", fi, got.Frame, want.Frame)
		}
		if math.Abs(float64(got.TimeSec-want.TimeSec)) > 1e-4 {
			t.Errorf("frame[%d].TimeSec = %v want %v", fi, got.TimeSec, want.TimeSec)
		}
		if len(got.Units) != len(want.Units) {
			t.Fatalf("frame[%d]: %d units want %d", fi, len(got.Units), len(want.Units))
		}
		// Reader returns units sorted by id.
		byID := map[int32]UnitState{}
		for _, u := range want.Units {
			byID[u.UnitID] = u
		}
		lastID := int32(-1)
		for _, gu := range got.Units {
			if gu.UnitID < lastID {
				t.Errorf("frame[%d]: units not sorted by id", fi)
			}
			lastID = gu.UnitID
			wu, ok := byID[gu.UnitID]
			if !ok {
				t.Fatalf("frame[%d]: unexpected unit %d", fi, gu.UnitID)
			}
			if gu.DefID != wu.DefID || gu.Team != wu.Team {
				t.Errorf("frame[%d] unit %d: def/team %d/%d want %d/%d", fi, gu.UnitID, gu.DefID, gu.Team, wu.DefID, wu.Team)
			}
			checks := []struct {
				name      string
				got, want float32
				tol       float64
			}{
				{"x", gu.Pos.X, wu.Pos.X, 0.5},
				{"y", gu.Pos.Y, wu.Pos.Y, 0.5},
				{"z", gu.Pos.Z, wu.Pos.Z, 0.5},
				{"hp", gu.Health, wu.Health, 0.5},
				{"maxHp", gu.MaxHealth, wu.MaxHealth, 0.5},
				{"vx", gu.VelX, wu.VelX, 1.0 / 60},
				{"vy", gu.VelY, wu.VelY, 1.0 / 60},
				{"vz", gu.VelZ, wu.VelZ, 1.0 / 60},
				{"build", gu.BuildProgress, wu.BuildProgress, 1.0 / 255 * 0.5001},
			}
			for _, c := range checks {
				if math.Abs(float64(c.got-c.want)) > c.tol {
					t.Errorf("frame[%d] unit %d: %s = %v want %v (±%v)", fi, gu.UnitID, c.name, c.got, c.want, c.tol)
				}
			}
		}
		if len(got.Resources) != len(want.Resources) {
			t.Fatalf("frame[%d]: %d resources want %d", fi, len(got.Resources), len(want.Resources))
		}
		for ri, wr := range want.Resources {
			gr := got.Resources[ri]
			if gr.Team != wr.Team {
				t.Errorf("frame[%d] res[%d]: team %d want %d", fi, ri, gr.Team, wr.Team)
			}
			pairs := [][2]float32{
				{gr.Metal, wr.Metal}, {gr.Energy, wr.Energy},
				{gr.MetalStorage, wr.MetalStorage}, {gr.EnergyStorage, wr.EnergyStorage},
				{gr.MetalIncome, wr.MetalIncome}, {gr.EnergyIncome, wr.EnergyIncome},
			}
			for pi, p := range pairs {
				if math.Abs(float64(p[0]-p[1])) > 0.05001 {
					t.Errorf("frame[%d] res[%d] field %d: %v want %v", fi, ri, pi, p[0], p[1])
				}
			}
		}
	}

	if len(gotEvents) != len(events) {
		t.Fatalf("events: got %d want %d", len(gotEvents), len(events))
	}
	for i, want := range events {
		if gotEvents[i] != want {
			t.Errorf("event[%d] = %+v want %+v", i, gotEvents[i], want)
		}
	}
}

func TestBRPParseSections(t *testing.T) {
	meta, frames, events := testCapture()
	path := writeBRP(t, t.TempDir(), meta, frames, events)

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	bf, err := ParseBRP(f)
	if err != nil {
		t.Fatal(err)
	}
	if bf.FrameCount != 3 || bf.EventCount != 3 || bf.UnitRecords != 7 {
		t.Errorf("counts: frames=%d events=%d units=%d", bf.FrameCount, bf.EventCount, bf.UnitRecords)
	}
	// Bounds cover the rounded x/z extents: x in [-50, 1000], z in [-10, 2000].
	if bf.Bounds == nil || bf.Bounds.MinX != -50 || bf.Bounds.MaxX != 1000 || bf.Bounds.MinZ != -10 || bf.Bounds.MaxZ != 2000 {
		t.Errorf("bounds = %+v", bf.Bounds)
	}
	if len(bf.FrameTeams) != 2 || bf.FrameTeams[0] != 0 || bf.FrameTeams[1] != 1 {
		t.Errorf("frameTeams = %v", bf.FrameTeams)
	}
	for _, tag := range []byte{SecMeta, SecFrames, SecExtra, SecEvents} {
		if _, ok := bf.Sections[tag]; !ok {
			t.Errorf("missing section %q", tag)
		}
	}

	// 3 frames fit in one chunk; its index entry must describe the whole F/X
	// payloads and start at the first frame.
	if bf.ChunkFrames != defaultChunkFrames || len(bf.Chunks) != 1 {
		t.Fatalf("chunkFrames=%d chunks=%+v", bf.ChunkFrames, bf.Chunks)
	}
	c := bf.Chunks[0]
	if c.Frame != 30 || c.Count != 3 || c.FOff != 0 || c.XOff != 0 {
		t.Errorf("chunk = %+v", c)
	}
	if c.FLen != int64(len(bf.Sections[SecFrames])) || c.XLen != int64(len(bf.Sections[SecExtra])) {
		t.Errorf("chunk lengths %d/%d don't span the sections (%d/%d)",
			c.FLen, c.XLen, len(bf.Sections[SecFrames]), len(bf.Sections[SecExtra]))
	}
	if c.FKeyLen <= 0 || c.FKeyLen >= c.FLen {
		t.Errorf("keyframe range [0,%d) of %d looks wrong", c.FKeyLen, c.FLen)
	}
}

// A capture longer than one chunk must split into self-contained chunks:
// decoding any single chunk in isolation yields exactly the corresponding
// slice of the full decode.
func TestBRPChunking(t *testing.T) {
	meta, _, _ := testCapture()
	var frames []Frame
	for i := 0; i < 150; i++ { // 3 chunks: 64 + 64 + 22
		fr := Frame{Frame: int32(30 * (i + 1)), TimeSec: float32(i + 1)}
		for u := 0; u < 5; u++ {
			fr.Units = append(fr.Units, UnitState{
				UnitID: int32(100 + u), DefID: 1, Team: int32(u % 2),
				Pos:    Vec3{X: float32(10*u + i), Y: 1, Z: float32(2000 - i*2)},
				Health: float32(3000 - i), MaxHealth: 3000, VelX: 1, VelZ: -2,
			})
		}
		frames = append(frames, fr)
	}
	events := []Event{{Frame: 30, Kind: EventCreated, UnitID: 100, DefID: 1, Team: 0}}

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
	if err := w.WriteEvent(events[0]); err != nil {
		t.Fatal(err)
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
	if len(bf.Chunks) != 3 || bf.Chunks[0].Count != 64 || bf.Chunks[1].Count != 64 || bf.Chunks[2].Count != 22 {
		t.Fatalf("chunks = %+v", bf.Chunks)
	}
	if bf.Chunks[1].Frame != frames[64].Frame || bf.Chunks[2].Frame != frames[128].Frame {
		t.Errorf("chunk first frames: %d, %d", bf.Chunks[1].Frame, bf.Chunks[2].Frame)
	}
	// Chunks tile the sections without gaps.
	if bf.Chunks[1].FOff != bf.Chunks[0].FLen || bf.Chunks[2].FOff != bf.Chunks[1].FOff+bf.Chunks[1].FLen {
		t.Errorf("F offsets don't tile: %+v", bf.Chunks)
	}

	// Full decode == concatenation of standalone chunk decodes, and each chunk
	// decode must not depend on any other chunk (fresh BRPFile slice per call
	// isn't needed — DecodeChunk only touches the indexed byte range).
	_, full, _, err := readBRPFile(t, filepath.Join(dir, meta.GameID+".brp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(full) != 150 {
		t.Fatalf("full decode: %d frames", len(full))
	}
	// Decode the middle chunk in isolation and compare against the full decode.
	mid, err := bf.DecodeChunk(1)
	if err != nil {
		t.Fatal(err)
	}
	for i, fr := range mid {
		want := full[64+i]
		if fr.Frame != want.Frame || len(fr.Units) != len(want.Units) {
			t.Fatalf("chunk1[%d]: frame %d units %d, want %d/%d", i, fr.Frame, len(fr.Units), want.Frame, len(want.Units))
		}
		for j := range fr.Units {
			if fr.Units[j] != want.Units[j] {
				t.Fatalf("chunk1[%d].Units[%d] = %+v want %+v", i, j, fr.Units[j], want.Units[j])
			}
		}
	}
	// A seek to the last chunk decodes without the first two.
	last, err := bf.DecodeChunk(2)
	if err != nil {
		t.Fatal(err)
	}
	if len(last) != 22 || last[0].Frame != frames[128].Frame {
		t.Errorf("last chunk: %d frames, first %d", len(last), last[0].Frame)
	}
}

func readBRPFile(t *testing.T, path string) (Meta, []Frame, []Event, error) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	return ReadBRP(f)
}

// Only the current format version is readable; anything else must be rejected
// with a clear error rather than misdecoded.
func TestBRPRejectsOtherVersions(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteContainer(&buf, BRPMagic, 1, []Section{{Tag: SecMeta, Payload: gzipCompress([]byte(`{}`))}}); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseBRP(bytes.NewReader(buf.Bytes())); err == nil {
		t.Error("want error for version 1")
	}
}

// The writer must be deterministic: same input, byte-identical file. The CLI's
// "diff two runs to prove an optimization didn't change the sim" workflow
// depends on this.
func TestBRPDeterministic(t *testing.T) {
	meta, frames, events := testCapture()
	p1 := writeBRP(t, t.TempDir(), meta, frames, events)
	p2 := writeBRP(t, t.TempDir(), meta, frames, events)
	b1, err := os.ReadFile(p1)
	if err != nil {
		t.Fatal(err)
	}
	b2, err := os.ReadFile(p2)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b1, b2) {
		t.Error("two writes of the same capture differ")
	}
}

func TestBRPEmptyCapture(t *testing.T) {
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
	f, err := os.Open(filepath.Join(dir, "empty.brp"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	meta, frames, events, err := ReadBRP(f)
	if err != nil {
		t.Fatal(err)
	}
	if meta.GameID != "empty" || len(frames) != 0 || len(events) != 0 {
		t.Errorf("meta=%+v frames=%d events=%d", meta, len(frames), len(events))
	}
}

func TestReadContainerBadMagic(t *testing.T) {
	if _, _, err := ReadContainer(bytes.NewReader([]byte("NOPE\x01")), BRPMagic); err == nil {
		t.Error("want error for bad magic")
	}
}
