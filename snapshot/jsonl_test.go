package snapshot

import (
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestJSONLRoundTrip(t *testing.T) {
	dir := t.TempDir()
	w, err := NewJSONLWriter(dir, "gid123")
	if err != nil {
		t.Fatalf("NewJSONLWriter: %v", err)
	}

	meta := Meta{
		GameID:        "gid123",
		EngineVersion: "2025.06.24",
		GameVersion:   "Beyond All Reason test-30541",
		MapName:       "Isidis crack 1.1",
		StartUnix:     1783132379,
		SampleEvery:   30,
		UnitDefs: map[int32]UnitDef{
			1: {DefID: 1, Name: "armcom", HumanName: "Armada Commander", MetalCost: 2700, MaxHealth: 3000, IsBuilder: true},
			2: {DefID: 2, Name: "corcom"},
		},
		Teams:   []TeamInfo{{TeamID: 0, AllyTeam: 0, Side: "armada", Color: "#ff0000", PlayerName: "Alice"}},
		Players: []PlayerInfo{{PlayerID: 0, Name: "Alice", Team: 0}},
	}
	frames := []Frame{
		{Frame: 30, TimeSec: 1, Units: []UnitState{
			{UnitID: 100, DefID: 1, Team: 0, Pos: Vec3{X: 512, Y: 80, Z: 1024}, Health: 3000, MaxHealth: 3000},
		}, Resources: []TeamResource{
			{Team: 0, Metal: 500, Energy: 1200, MetalStorage: 1000, EnergyStorage: 5000, MetalIncome: 45.6, EnergyIncome: 90},
		}},
		{Frame: 60, TimeSec: 2, Units: nil},
	}
	events := []Event{
		{Frame: 45, Kind: EventCreated, UnitID: 101, DefID: 2, Team: 1},
		{Frame: 58, Kind: EventDestroyed, UnitID: 100, DefID: 1, Team: 0},
	}

	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}
	// Interleave frames and events the way capture will.
	if err := w.WriteFrame(frames[0]); err != nil {
		t.Fatal(err)
	}
	if err := w.WriteEvent(events[0]); err != nil {
		t.Fatal(err)
	}
	if err := w.WriteEvent(events[1]); err != nil {
		t.Fatal(err)
	}
	if err := w.WriteFrame(frames[1]); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	f, err := os.Open(filepath.Join(dir, "gid123.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	r := NewReader(f)
	var gotMeta *Meta
	var gotFrames []Frame
	var gotEvents []Event
	for {
		m, fr, e, err := r.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Next: %v", err)
		}
		switch {
		case m != nil:
			gotMeta = m
		case fr != nil:
			gotFrames = append(gotFrames, *fr)
		case e != nil:
			gotEvents = append(gotEvents, *e)
		}
	}

	if gotMeta == nil || !reflect.DeepEqual(*gotMeta, meta) {
		t.Errorf("meta mismatch:\n got %+v\nwant %+v", gotMeta, meta)
	}
	if !reflect.DeepEqual(gotFrames, frames) {
		t.Errorf("frames mismatch:\n got %+v\nwant %+v", gotFrames, frames)
	}
	if !reflect.DeepEqual(gotEvents, events) {
		t.Errorf("events mismatch:\n got %+v\nwant %+v", gotEvents, events)
	}
}
