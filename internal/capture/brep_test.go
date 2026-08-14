package capture

import (
	"bytes"
	"encoding/binary"
	"math"
	"strings"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// brepEnc builds .brepstream bytes for tests: a Go mirror of the widget's
// encoder (assets/lua/replay_uploader.lua).
type brepEnc struct {
	buf bytes.Buffer
}

func newBrepEnc(preamble string) *brepEnc {
	e := &brepEnc{}
	e.buf.WriteString(BrepHeader + "\n")
	e.buf.WriteString(preamble)
	return e
}

func (e *brepEnc) record(tag byte, payload []byte) {
	e.buf.WriteByte(tag)
	var n [4]byte
	binary.LittleEndian.PutUint32(n[:], uint32(len(payload)))
	e.buf.Write(n[:])
	e.buf.Write(payload)
}

// tu is one changed/keyframe unit in a test frame record.
type tu struct {
	id, def, team, x, z, hp, maxHp, dvx, dvz, build, target int
}

// tr is one team resource row.
type tr struct {
	team                  int
	m, en, ms, es, mi, ei float32
}

func frameRecord(frame int, keyframe bool, units []tu, dead []int, res []tr) []byte {
	var b bytes.Buffer
	w16 := func(v int) { var s [2]byte; binary.LittleEndian.PutUint16(s[:], uint16(v)); b.Write(s[:]) }
	w32 := func(v uint32) { var s [4]byte; binary.LittleEndian.PutUint32(s[:], v); b.Write(s[:]) }
	w32(uint32(frame))
	// Flags bit 1: the target column is present (the current widget always
	// writes it; the no-target legacy path is pinned by the harness fixture).
	if keyframe {
		b.WriteByte(3)
	} else {
		b.WriteByte(2)
	}
	w16(len(units))
	w16(len(dead))
	b.WriteByte(byte(len(res)))
	for _, u := range units {
		w16(u.id)
	}
	for _, u := range units {
		w16(u.def)
	}
	for _, u := range units {
		b.WriteByte(byte(u.team))
	}
	for _, u := range units {
		w16(u.x)
	}
	for _, u := range units {
		w16(u.z)
	}
	for _, u := range units {
		w32(uint32(u.hp))
	}
	for _, u := range units {
		w32(uint32(u.maxHp))
	}
	for _, u := range units {
		w16(u.dvx)
	}
	for _, u := range units {
		w16(u.dvz)
	}
	for _, u := range units {
		b.WriteByte(byte(u.build))
	}
	for _, u := range units {
		w16(u.target)
	}
	for _, id := range dead {
		w16(id)
	}
	for _, r := range res {
		b.WriteByte(byte(r.team))
	}
	for _, col := range []func(tr) float32{
		func(r tr) float32 { return r.m }, func(r tr) float32 { return r.en },
		func(r tr) float32 { return r.ms }, func(r tr) float32 { return r.es },
		func(r tr) float32 { return r.mi }, func(r tr) float32 { return r.ei },
	} {
		for _, r := range res {
			w32(math.Float32bits(col(r)))
		}
	}
	return b.Bytes()
}

const brepPreamble = `BRSNAP GID a1b2c3d4e5f60718293a4b5c6d7e8f90
BRSNAP GAME {"protocol":2,"mode":"live","map":"Test Map","gameVersion":"BAR test","engineVersion":"2026.01","sampleEvery":30,"gameSpeed":30,"playerID":0,"allyTeam":0,"spectator":false}
BRSNAP DEF {"id":1,"name":"armcom","humanName":"Commander","maxHealth":3700}
BRSNAP T 0 0 armada #8040ff
BRSNAP P 0 0 0 Player Zero
BRSNAP READY
`

func TestConsumeBrep(t *testing.T) {
	e := newBrepEnc(brepPreamble)
	// Keyframe: two units. Unit 5 moves at dv=(30,-15); unit 9 stationary.
	e.record('F', frameRecord(30, true, []tu{
		{id: 5, def: 1, team: 0, x: 1000, z: 2000, hp: 900, maxHp: 1000, dvx: 30, dvz: -15, build: 255, target: 9},
		{id: 9, def: 1, team: 0, x: 50, z: 60, hp: 3700, maxHp: 3700, build: 128},
	}, nil, []tr{{team: 0, m: 100.5, en: 900, ms: 500, es: 1000, mi: 27, ei: 81}}))
	// Delta with NO restated units: 5 must advance by prediction, 9 stays.
	e.record('F', frameRecord(60, false, nil, nil, nil))
	// Delta: 5 changes velocity (restated absolutely), new unit 12 appears.
	e.record('F', frameRecord(90, false, []tu{
		{id: 5, def: 1, team: 0, x: 1061, z: 1969, hp: 850, maxHp: 1000, dvx: 0, dvz: 0, build: 255},
		{id: 12, def: 1, team: 0, x: 7, z: 8, hp: 10, maxHp: 3700, build: 3},
	}, nil, nil))
	// Delta: unit 9 dies.
	e.record('F', frameRecord(120, false, nil, []int{9}, nil))
	// Event + end marker + an unknown record type that must be skipped.
	e.record('E', []byte("121 destroyed 9 1 0"))
	e.record('Q', []byte("future record type"))
	e.record('X', []byte("gameover"))

	var sink loadedSink
	var stats Stats
	if err := ConsumeBrepStats(bytes.NewReader(e.buf.Bytes()), snapshot.Meta{}, &sink, &stats); err != nil {
		t.Fatalf("ConsumeBrep: %v", err)
	}

	// Meta from the text head.
	if sink.meta.GameID != "a1b2c3d4e5f60718293a4b5c6d7e8f90" {
		t.Errorf("GameID = %q", sink.meta.GameID)
	}
	if sink.meta.MapName != "Test Map" || sink.meta.GameVersion != "BAR test" ||
		sink.meta.EngineVersion != "2026.01" || sink.meta.SampleEvery != 30 {
		t.Errorf("meta from GAME line = %+v", sink.meta)
	}
	if len(sink.meta.UnitDefs) != 1 || sink.meta.UnitDefs[1].Name != "armcom" {
		t.Errorf("unit defs = %+v", sink.meta.UnitDefs)
	}
	if len(sink.meta.Teams) != 1 || sink.meta.Teams[0].PlayerName != "Player Zero" {
		t.Errorf("teams (want backfilled player) = %+v", sink.meta.Teams)
	}
	// A live-mode GAME line identifies whose point of view the capture is.
	if r := sink.meta.Recorder; r == nil || r.PlayerID != 0 || r.AllyTeam != 0 || r.Spectator {
		t.Errorf("recorder = %+v, want live player 0 / ally 0", sink.meta.Recorder)
	}

	if stats.Frames != 4 || stats.LastFrame != 120 {
		t.Fatalf("stats = %+v", stats)
	}
	if len(sink.frames) != 4 {
		t.Fatalf("frames = %d", len(sink.frames))
	}

	f0 := sink.frames[0]
	if len(f0.Units) != 2 || f0.Units[0].UnitID != 5 || f0.Units[1].UnitID != 9 {
		t.Fatalf("keyframe units = %+v", f0.Units)
	}
	u5 := f0.Units[0]
	if u5.Pos.X != 1000 || u5.Pos.Z != 2000 || u5.Health != 900 || u5.VelX != 1 || u5.VelZ != -0.5 {
		t.Errorf("unit 5 @30 = %+v", u5)
	}
	if u5.TargetID != 9 || f0.Units[1].TargetID != 0 {
		t.Errorf("targets @30 = %d, %d (want 9, 0)", u5.TargetID, f0.Units[1].TargetID)
	}
	if u5.BuildProgress != 1 {
		t.Errorf("unit 5 build = %v", u5.BuildProgress)
	}
	if got := f0.Units[1].BuildProgress; got != float32(128)/255 {
		t.Errorf("unit 9 build = %v", got)
	}
	if f0.TimeSec != 1 {
		t.Errorf("TimeSec = %v", f0.TimeSec)
	}
	// Protocol 2 preamble: the over-scaled income is divided back by gameSpeed
	// at decode time (see repairIncome); the other columns pass through raw.
	if len(f0.Resources) != 1 || f0.Resources[0].Metal != 100.5 ||
		f0.Resources[0].MetalIncome != float32(27)/30 || f0.Resources[0].EnergyIncome != float32(81)/30 {
		t.Errorf("resources = %+v", f0.Resources)
	}

	// Frame 60: pure prediction. 5 advanced by (30,-15); 9 unchanged.
	f1 := sink.frames[1]
	if len(f1.Units) != 2 {
		t.Fatalf("frame 60 units = %+v", f1.Units)
	}
	if f1.Units[0].Pos.X != 1030 || f1.Units[0].Pos.Z != 1985 {
		t.Errorf("unit 5 @60 = %+v", f1.Units[0].Pos)
	}
	if f1.Units[1].Pos.X != 50 || f1.Units[1].Pos.Z != 60 {
		t.Errorf("unit 9 @60 = %+v", f1.Units[1].Pos)
	}

	// Frame 90: 5 restated, 12 appeared, 9 still predicted-stationary.
	f2 := sink.frames[2]
	if len(f2.Units) != 3 {
		t.Fatalf("frame 90 units = %+v", f2.Units)
	}
	if f2.Units[0].Pos.X != 1061 || f2.Units[0].Health != 850 || f2.Units[0].VelX != 0 {
		t.Errorf("unit 5 @90 = %+v", f2.Units[0])
	}
	if f2.Units[2].UnitID != 12 || f2.Units[2].Health != 10 {
		t.Errorf("unit 12 @90 = %+v", f2.Units[2])
	}

	// Frame 120: 9 dead; 5 and 12 remain (5 has dv=0 now, so no movement).
	f3 := sink.frames[3]
	if len(f3.Units) != 2 || f3.Units[0].UnitID != 5 || f3.Units[1].UnitID != 12 {
		t.Fatalf("frame 120 units = %+v", f3.Units)
	}
	if f3.Units[0].Pos.X != 1061 {
		t.Errorf("unit 5 @120 = %+v", f3.Units[0].Pos)
	}

	if len(sink.events) != 1 || sink.events[0].Kind != "destroyed" || sink.events[0].UnitID != 9 {
		t.Errorf("events = %+v", sink.events)
	}
}

func TestConsumeBrepKeyframeReset(t *testing.T) {
	e := newBrepEnc(brepPreamble)
	e.record('F', frameRecord(30, true, []tu{
		{id: 5, def: 1, team: 0, x: 100, z: 100, hp: 10, maxHp: 10, build: 255},
		{id: 6, def: 1, team: 0, x: 200, z: 200, hp: 10, maxHp: 10, build: 255},
	}, nil, nil))
	// Second keyframe omits unit 6: it must vanish without a dead entry.
	e.record('F', frameRecord(1950, true, []tu{
		{id: 5, def: 1, team: 0, x: 100, z: 100, hp: 10, maxHp: 10, build: 255},
	}, nil, nil))

	var sink loadedSink
	if err := ConsumeBrep(bytes.NewReader(e.buf.Bytes()), snapshot.Meta{}, &sink); err != nil {
		t.Fatalf("ConsumeBrep: %v", err)
	}
	if len(sink.frames) != 2 || len(sink.frames[1].Units) != 1 || sink.frames[1].Units[0].UnitID != 5 {
		t.Fatalf("keyframe reset: frames = %+v", sink.frames)
	}
}

// TestConsumeBrepSegments: a widget disabled and re-enabled mid-game appends
// a whole new segment (header + preamble + records). The decoder must reset
// unit state at the boundary and keep the emitted frame sequence monotonic
// even if a segment (anomalously) overlaps an earlier one.
func TestConsumeBrepSegments(t *testing.T) {
	e := newBrepEnc(brepPreamble)
	e.record('F', frameRecord(30, true, []tu{
		{id: 5, def: 1, team: 0, x: 100, z: 100, hp: 10, maxHp: 10, build: 255},
		{id: 6, def: 1, team: 0, x: 200, z: 200, hp: 10, maxHp: 10, build: 255},
	}, nil, nil))
	e.record('F', frameRecord(60, false, nil, nil, nil))

	// Re-enable: new segment, keyframe restates only unit 5 — unit 6 must be
	// gone without a dead entry (decoder reset at the boundary).
	e.buf.WriteString(BrepHeader + "\n" + brepPreamble)
	e.record('F', frameRecord(2190, true, []tu{
		{id: 5, def: 1, team: 0, x: 150, z: 150, hp: 8, maxHp: 10, build: 255},
	}, nil, nil))

	// Anomalous third segment overlapping already-emitted frames: its stale
	// frames must not be emitted (monotonic output), but its state must still
	// apply so the post-overlap frame is correct.
	e.buf.WriteString(BrepHeader + "\n" + brepPreamble)
	e.record('F', frameRecord(90, true, []tu{
		{id: 9, def: 1, team: 0, x: 7, z: 7, hp: 5, maxHp: 5, build: 255},
	}, nil, nil))
	e.record('F', frameRecord(2220, false, nil, nil, nil))

	var sink loadedSink
	if err := ConsumeBrep(bytes.NewReader(e.buf.Bytes()), snapshot.Meta{}, &sink); err != nil {
		t.Fatalf("ConsumeBrep: %v", err)
	}
	var frames []int32
	for _, f := range sink.frames {
		frames = append(frames, f.Frame)
	}
	if len(frames) != 4 || frames[0] != 30 || frames[1] != 60 || frames[2] != 2190 || frames[3] != 2220 {
		t.Fatalf("frames = %v", frames)
	}
	f2 := sink.frames[2]
	if len(f2.Units) != 1 || f2.Units[0].UnitID != 5 || f2.Units[0].Pos.X != 150 {
		t.Fatalf("post-restart frame = %+v", f2.Units)
	}
	f3 := sink.frames[3]
	if len(f3.Units) != 1 || f3.Units[0].UnitID != 9 {
		t.Fatalf("post-overlap frame = %+v", f3.Units)
	}
	// The repeated preamble must not duplicate the team table.
	if len(sink.meta.Teams) != 1 {
		t.Fatalf("teams duplicated across segments: %+v", sink.meta.Teams)
	}
}

func TestConsumeBrepTruncated(t *testing.T) {
	e := newBrepEnc(brepPreamble)
	e.record('F', frameRecord(30, true, []tu{
		{id: 5, def: 1, team: 0, x: 100, z: 100, hp: 10, maxHp: 10, build: 255},
	}, nil, nil))
	full := e.buf.Bytes()
	// Chop the stream inside the second record's payload.
	e.record('F', frameRecord(60, false, []tu{
		{id: 5, def: 1, team: 0, x: 1, z: 1, hp: 1, maxHp: 10, build: 255},
	}, nil, nil))
	chopped := e.buf.Bytes()[:len(full)+10]

	var sink loadedSink
	if err := ConsumeBrep(bytes.NewReader(chopped), snapshot.Meta{}, &sink); err != nil {
		t.Fatalf("ConsumeBrep on truncated stream: %v", err)
	}
	if len(sink.frames) != 1 || sink.frames[0].Frame != 30 {
		t.Fatalf("truncated stream: frames = %+v", sink.frames)
	}
}

// Protocol >= 3 streams write income as the engine reports it (already per
// game-second); the legacy repair must NOT touch it.
func TestConsumeBrepProtocol3IncomeUnscaled(t *testing.T) {
	preamble := strings.Replace(brepPreamble, `"protocol":2`, `"protocol":3`, 1)
	e := newBrepEnc(preamble)
	e.record('F', frameRecord(30, true, nil, nil,
		[]tr{{team: 0, m: 100, en: 900, ms: 500, es: 1000, mi: 2, ei: 45}}))

	var sink loadedSink
	if err := ConsumeBrep(bytes.NewReader(e.buf.Bytes()), snapshot.Meta{}, &sink); err != nil {
		t.Fatalf("ConsumeBrep: %v", err)
	}
	if len(sink.frames) != 1 || len(sink.frames[0].Resources) != 1 {
		t.Fatalf("frames = %+v", sink.frames)
	}
	if r := sink.frames[0].Resources[0]; r.MetalIncome != 2 || r.EnergyIncome != 45 {
		t.Errorf("protocol 3 income must pass through unscaled: %+v", r)
	}
}

func TestConsumeBrepRejectsNonBrep(t *testing.T) {
	var sink loadedSink
	err := ConsumeBrep(strings.NewReader("BRSNAP READY\n"), snapshot.Meta{}, &sink)
	if err == nil || !strings.Contains(err.Error(), "not a brepstream") {
		t.Fatalf("err = %v", err)
	}
}

// loadedSink is an in-memory snapshot.Writer for tests.
type loadedSink struct {
	meta   snapshot.Meta
	frames []snapshot.Frame
	events []snapshot.Event
}

func (l *loadedSink) WriteMeta(m snapshot.Meta) error   { l.meta = m; return nil }
func (l *loadedSink) WriteFrame(f snapshot.Frame) error { l.frames = append(l.frames, f); return nil }
func (l *loadedSink) WriteEvent(e snapshot.Event) error { l.events = append(l.events, e); return nil }
func (l *loadedSink) Close() error                      { return nil }
