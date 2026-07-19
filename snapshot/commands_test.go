package snapshot

import (
	"os"
	"testing"
)

// cmdFrames builds a capture spanning two chunks (70 frames at the default 64
// samples/chunk) with evolving command state: set, change, carry-over, clear,
// and death — every C-section codec path.
func cmdTestCapture() (Meta, []Frame, []Event) {
	meta := Meta{
		GameID:      "cmdcmdcmdcmdcmdcmdcmdcmdcmdcmd12",
		SampleEvery: 30,
		UnitDefs: map[int32]UnitDef{
			1: {Name: "armcom"},
		},
	}
	var frames []Frame
	for i := 0; i < 70; i++ {
		frame := int32(i * 30)
		fr := Frame{Frame: frame}
		// Unit 5 lives the whole capture; 9 dies at sample 40.
		fr.Units = append(fr.Units, UnitState{UnitID: 5, DefID: 1, Team: 0, Pos: Vec3{X: 100, Z: 100}, Health: 900, MaxHealth: 900, BuildProgress: 1})
		if i < 40 {
			fr.Units = append(fr.Units, UnitState{UnitID: 9, DefID: 1, Team: 1, Pos: Vec3{X: 300, Z: 300}, Health: 700, MaxHealth: 900, BuildProgress: 1})
		}
		switch {
		case i < 10: // 5 building, 9 idle
			fr.Commands = []UnitCommand{{UnitID: 5, Cmd: -42, TX: 640, TZ: 512, Buildee: 9}}
		case i < 30: // 5 unchanged (carry-over), 9 reclaiming a feature
			fr.Commands = []UnitCommand{
				{UnitID: 5, Cmd: -42, TX: 640, TZ: 512, Buildee: 9},
				{UnitID: 9, Cmd: 90, TargetID: 33000},
			}
		case i < 40: // 5 idle (cleared), 9 still reclaiming
			fr.Commands = []UnitCommand{{UnitID: 9, Cmd: 90, TargetID: 33000}}
		default: // 9 dead; nobody has commands
		}
		frames = append(frames, fr)
	}
	events := []Event{
		{Frame: 0, Kind: EventCreated, UnitID: 5, DefID: 1, Team: 0},
		{Frame: 0, Kind: EventCreated, UnitID: 9, DefID: 1, Team: 1},
		{Frame: 40 * 30, Kind: EventDestroyed, UnitID: 9, DefID: 1, Team: 1},
	}
	return meta, frames, events
}

func TestBRPCommandsRoundTrip(t *testing.T) {
	meta, frames, events := cmdTestCapture()
	path := writeBRP(t, t.TempDir(), meta, frames, events)

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	_, got, _, err := ReadBRP(f)
	if err != nil {
		t.Fatalf("ReadBRP: %v", err)
	}
	if len(got) != len(frames) {
		t.Fatalf("frames = %d, want %d", len(got), len(frames))
	}
	for i := range frames {
		want := frames[i].Commands
		gotC := got[i].Commands
		if len(gotC) != len(want) {
			t.Fatalf("frame %d: commands %+v, want %+v", i, gotC, want)
		}
		for j := range want {
			if gotC[j] != want[j] {
				t.Fatalf("frame %d command %d: got %+v, want %+v", i, j, gotC[j], want[j])
			}
		}
	}
}

// TestBRPCommandsChunkRandomAccess decodes only the second chunk: its command
// keyframe must restate the state mid-stream without chunk 0.
func TestBRPCommandsChunkRandomAccess(t *testing.T) {
	meta, frames, events := cmdTestCapture()
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
	if len(bf.Chunks) != 2 {
		t.Fatalf("chunks = %d, want 2", len(bf.Chunks))
	}
	chunk1, err := bf.DecodeChunk(1)
	if err != nil {
		t.Fatalf("DecodeChunk(1): %v", err)
	}
	for k, fr := range chunk1 {
		if len(fr.Commands) != len(frames[64+k].Commands) {
			t.Fatalf("chunk1 frame %d: commands %+v, want %+v", k, fr.Commands, frames[64+k].Commands)
		}
	}
}

// TestBRPNoCommandsUnchanged: a capture with no command data writes no C
// section and no c* chunk fields — the output must stay byte-identical to the
// pre-command writer, which this pins structurally.
func TestBRPNoCommandsUnchanged(t *testing.T) {
	meta, frames, events := cmdTestCapture()
	for i := range frames {
		frames[i].Commands = nil
	}
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
	if _, ok := bf.Sections[SecCommands]; ok {
		t.Error("command-less capture has a C section")
	}
	for i, c := range bf.Chunks {
		if c.COff != 0 || c.CKeyLen != 0 || c.CLen != 0 {
			t.Errorf("chunk %d has command ranges %d/%d/%d, want 0/0/0", i, c.COff, c.CKeyLen, c.CLen)
		}
	}
}

// recordingSink captures frames passed through a Writer chain.
type recordingSink struct {
	meta   Meta
	frames []Frame
}

func (s *recordingSink) WriteMeta(m Meta) error { s.meta = m; return nil }
func (s *recordingSink) WriteFrame(f Frame) error {
	s.frames = append(s.frames, f)
	return nil
}
func (s *recordingSink) WriteEvent(e Event) error { return nil }
func (s *recordingSink) Close() error             { return nil }

func TestAirIdleWriter(t *testing.T) {
	meta := Meta{
		SampleEvery: 30,
		UnitDefs: map[int32]UnitDef{
			1: {Name: "armhawk", CanFly: true, Speed: 50}, // glide cap = 100 elmos/sample
			2: {Name: "corak"},
		},
	}
	sink := &recordingSink{}
	w := NewAirIdleWriter(sink, AirIdleOptions{Radius: 100, IdleSamples: 3})
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}

	// A fighter circling within r=50 of (1000,1000); a ground unit at the same
	// spot; later the fighter is damaged, blocked by a buildee, and finally
	// the RAW data itself jumps far away (a ghost re-spot).
	circle := [][2]float32{{1050, 1000}, {1000, 1050}, {950, 1000}, {1000, 950}}
	write := func(i int, hp float32, pos [2]float32, cmds []UnitCommand) {
		fr := Frame{Frame: int32(i * 30), Commands: cmds}
		fr.Units = []UnitState{
			{UnitID: 1, DefID: 1, Team: 0, Pos: Vec3{X: pos[0], Z: pos[1]}, Health: hp, MaxHealth: 500, VelX: 3, VelZ: 2},
			{UnitID: 2, DefID: 2, Team: 0, Pos: Vec3{X: pos[0], Z: pos[1]}, Health: 400, MaxHealth: 400, VelX: 3, VelZ: 2},
		}
		if err := w.WriteFrame(fr); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 6; i++ {
		write(i, 500, circle[i%4], nil)
	}
	// Samples 0-3 are faithful (sample 1 restarts the streak — the takeoff
	// detector sees the first orbit step against an empty movement average);
	// sample 4 freezes: the plane GLIDES onto the anchor (the orbit centroid,
	// (1000,1000)) — position lands, velocity is the glide displacement,
	// never a teleport.
	anchor := Vec3{X: 1000, Z: 1000}
	if u := sink.frames[4].Units[0]; u.Pos != anchor || (u.VelX == 0 && u.VelZ == 0) {
		t.Fatalf("freeze arrival: %+v, want gliding onto %+v", u, anchor)
	}
	for i := 5; i < 6; i++ {
		u := sink.frames[i].Units[0]
		if u.Pos != anchor || u.VelX != 0 || u.VelZ != 0 {
			t.Fatalf("sample %d: frozen fighter = %+v, want parked at %+v", i, u, anchor)
		}
		if g := sink.frames[i].Units[1]; g.VelX == 0 {
			t.Fatalf("sample %d: ground unit was frozen: %+v", i, g)
		}
	}

	// Damage unfreezes: the emitted position glides back to the true path
	// (the gap here fits one step, so it lands immediately) — and re-freezes
	// once the fighter settles again.
	write(6, 450, circle[2], nil)
	if u := sink.frames[6].Units[0]; u.Pos.X != circle[2][0] || u.Pos.Z != circle[2][1] {
		t.Fatalf("damaged fighter did not return to its true position: %+v", u)
	}
	for i := 7; i < 11; i++ {
		write(i, 450, circle[i%4], nil)
	}
	if u := sink.frames[10].Units[0]; u.VelX != 0 {
		t.Fatalf("fighter did not re-freeze after damage settled: %+v", u)
	}
	// An active command (nanolathing) blocks freezing despite being parked.
	for i := 11; i < 16; i++ {
		write(i, 450, circle[0], []UnitCommand{{UnitID: 1, Cmd: 0, Buildee: 7}})
	}
	if u := sink.frames[15].Units[0]; u.VelX == 0 {
		t.Fatalf("fighter with a buildee was frozen: %+v", u)
	}
	// A jump in the RAW data (ghost re-spot) passes through untouched: the
	// transform was faithful before it, so it must not smooth genuine capture
	// discontinuities.
	write(16, 450, [2]float32{5000, 5000}, nil)
	if u := sink.frames[16].Units[0]; u.Pos.X != 5000 || u.VelX != 3 {
		t.Fatalf("raw-data jump was altered: %+v", u)
	}

	// Continuity: wherever the transform DIVERGES from the true path, the
	// emitted step must stay within the glide cap; faithful samples may step
	// exactly as far as the raw data did.
	const cap2 = 100.5 * 100.5
	for i := 1; i < len(sink.frames); i++ {
		u0, u1 := sink.frames[i-1].Units[0], sink.frames[i].Units[0]
		dx := float64(u1.Pos.X - u0.Pos.X)
		dz := float64(u1.Pos.Z - u0.Pos.Z)
		if i == 16 {
			continue // the raw jump, preserved on purpose
		}
		if dx*dx+dz*dz > cap2 {
			t.Fatalf("emitted step %d->%d is discontinuous: %+v -> %+v", i-1, i, u0.Pos, u1.Pos)
		}
	}
}

// TestAirIdleWriterGlideOut: a frozen fighter whose true position is far off
// the anchor when it unfreezes must GLIDE back over several samples — capped
// steps, monotonically converging — never jump.
func TestAirIdleWriterGlideOut(t *testing.T) {
	meta := Meta{
		SampleEvery: 30,
		UnitDefs:    map[int32]UnitDef{1: {Name: "armhawk", CanFly: true, Speed: 50}}, // cap 100
	}
	sink := &recordingSink{}
	w := NewAirIdleWriter(sink, AirIdleOptions{Radius: 400, IdleSamples: 2})
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}
	write := func(i int, hp, x float32) {
		if err := w.WriteFrame(Frame{Frame: int32(i * 30), Units: []UnitState{
			{UnitID: 1, DefID: 1, Team: 0, Pos: Vec3{X: x, Z: 0}, Health: hp, MaxHealth: 500, VelX: 3},
		}}); err != nil {
			t.Fatal(err)
		}
	}
	// Settle and freeze near x=0, drifting within the radius slowly enough
	// to count as stationary (hovering wobble, not cruising).
	for i := 0; i < 5; i++ {
		write(i, 500, float32(i*5)) // 0,5,10,15,20 — near-stationary drift
	}
	if u := sink.frames[4].Units[0]; u.VelX != 0 {
		t.Fatalf("fighter did not freeze: %+v", u)
	}
	frozenX := sink.frames[4].Units[0].Pos.X
	// Damage at a true position ~350 elmos from the anchor: the glide must
	// cover the gap in capped steps.
	prevX := frozenX
	for i := 5; i < 12; i++ {
		write(i, 450, 350)
		u := sink.frames[i].Units[0]
		if step := u.Pos.X - prevX; step < -0.01 || step > 100.5 {
			t.Fatalf("sample %d: glide step %v out of [0,100]: %+v", i, step, u)
		}
		prevX = u.Pos.X
	}
	if prevX != 350 {
		t.Fatalf("glide never converged: at %v, want 350", prevX)
	}
}

// TestAirIdleWriterTakeoff: a landed plane (truly stationary, frozen for
// free) that starts moving must unfreeze on the FIRST moving sample — the
// takeoff detector, not the anchor radius, releases it — so the emitted track
// equals the raw track for the whole departure. With a far move order
// recorded (protocol 3), the release happens on the order itself.
func TestAirIdleWriterTakeoff(t *testing.T) {
	for _, withCmd := range []bool{false, true} {
		meta := Meta{
			SampleEvery: 30,
			UnitDefs:    map[int32]UnitDef{1: {Name: "corveng", CanFly: true, Speed: 298}},
		}
		sink := &recordingSink{}
		w := NewAirIdleWriter(sink, AirIdleOptions{Radius: 700, IdleSamples: 3})
		if err := w.WriteMeta(meta); err != nil {
			t.Fatal(err)
		}
		write := func(i int, x, z float32, cmds []UnitCommand) {
			if err := w.WriteFrame(Frame{Frame: int32(i * 30), Commands: cmds, Units: []UnitState{
				{UnitID: 938, DefID: 1, Team: 0, Pos: Vec3{X: x, Z: z}, Health: 500, MaxHealth: 500, VelX: 1, VelZ: 1},
			}}); err != nil {
				t.Fatal(err)
			}
		}
		// Parked for 6 samples, then departs toward a far target, accelerating
		// exactly like the real capture did (37, 147, 215, 255... elmos/sample
		// — all within the 700 anchor radius for a while).
		for i := 0; i < 6; i++ {
			write(i, 2176, 11543, nil)
		}
		if u := sink.frames[5].Units[0]; u.VelX != 0 {
			t.Fatalf("parked plane not frozen: %+v", u)
		}
		track := []float32{11506, 11359, 11144, 10890, 10611, 10329}
		for i, z := range track {
			var cmds []UnitCommand
			if withCmd {
				cmds = []UnitCommand{{UnitID: 938, Cmd: 10, TX: 1767, TZ: 5773}}
			}
			write(6+i, 2170, z, cmds)
		}
		for i, z := range track {
			u := sink.frames[6+i].Units[0]
			if u.Pos.Z != z || u.Pos.X != 2170 {
				t.Fatalf("withCmd=%v: departure sample %d emitted %+v, want the raw (2170,%v)", withCmd, 6+i, u.Pos, z)
			}
			if u.VelX != 1 {
				t.Fatalf("withCmd=%v: departure sample %d velocity rewritten: %+v", withCmd, 6+i, u)
			}
		}
	}
}

// TestAirIdleWriterFarOrderBlocksFreezing: a plane circling near one spot but
// under a move order to a FAR destination (e.g. queued behind congestion)
// must never freeze — "idle" means near the destination.
func TestAirIdleWriterFarOrderBlocksFreezing(t *testing.T) {
	meta := Meta{
		SampleEvery: 30,
		UnitDefs:    map[int32]UnitDef{1: {Name: "armhawk", CanFly: true, Speed: 298}},
	}
	sink := &recordingSink{}
	w := NewAirIdleWriter(sink, AirIdleOptions{Radius: 700, IdleSamples: 2})
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		if err := w.WriteFrame(Frame{Frame: int32(i * 30),
			Commands: []UnitCommand{{UnitID: 1, Cmd: 10, TX: 9000, TZ: 9000}},
			Units: []UnitState{
				{UnitID: 1, DefID: 1, Team: 0, Pos: Vec3{X: float32(1000 + 20*(i%2)), Z: 1000}, Health: 500, MaxHealth: 500, VelX: 2},
			}}); err != nil {
			t.Fatal(err)
		}
	}
	for i, fr := range sink.frames {
		if fr.Units[0].VelX != 2 {
			t.Fatalf("sample %d: plane with a far move order was rewritten: %+v", i, fr.Units[0])
		}
	}
}
