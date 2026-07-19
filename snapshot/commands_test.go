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
