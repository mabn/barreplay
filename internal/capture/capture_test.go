package capture

import (
	"strings"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// recordingWriter captures calls for assertions.
type recordingWriter struct {
	meta   *snapshot.Meta
	frames []snapshot.Frame
	events []snapshot.Event
	closed bool
}

func (r *recordingWriter) WriteMeta(m snapshot.Meta) error { r.meta = &m; return nil }
func (r *recordingWriter) WriteFrame(f snapshot.Frame) error {
	r.frames = append(r.frames, f)
	return nil
}
func (r *recordingWriter) WriteEvent(e snapshot.Event) error {
	r.events = append(r.events, e)
	return nil
}
func (r *recordingWriter) Close() error { r.closed = true; return nil }

func TestConsume(t *testing.T) {
	stream := strings.Join([]string{
		"[t=00:00:00] Loading widget BAR Replay Snapshotter", // engine noise, ignored
		"BRSNAP D 1 armcom",
		"BRSNAP D 2 corcom",
		"BRSNAP T 0 0 armada",
		"BRSNAP T 1 1 cortex",
		"BRSNAP READY",
		"some other infolog line",
		"BRSNAP F 30 1.000 2",
		"BRSNAP U 100 1 0 512.0 80.0 1024.0 3000.0 3000.0",
		"BRSNAP U 101 2 1 600.5 82.0 900.0 2500.0 3000.0",
		"BRSNAP EV 45 created 102 1 0",
		"BRSNAP F 60 2.000 1",
		"BRSNAP U 100 1 0 512.0 80.0 1030.0 2900.0 3000.0",
		"BRSNAP EV 58 destroyed 101 2 1",
	}, "\n")

	base := snapshot.Meta{
		GameID:        "gid123",
		EngineVersion: "2025.06.24",
		MapName:       "Isidis crack 1.1",
		SampleEvery:   30,
	}
	w := &recordingWriter{}
	if err := Consume(strings.NewReader(stream), base, w); err != nil {
		t.Fatalf("Consume: %v", err)
	}

	if w.meta == nil {
		t.Fatal("meta not written")
	}
	if w.meta.GameID != "gid123" {
		t.Errorf("meta GameID = %q", w.meta.GameID)
	}
	if w.meta.UnitDefs[1] != "armcom" || w.meta.UnitDefs[2] != "corcom" {
		t.Errorf("unitDefs = %v", w.meta.UnitDefs)
	}
	if len(w.meta.Teams) != 2 || w.meta.Teams[1].Side != "cortex" {
		t.Errorf("teams = %+v", w.meta.Teams)
	}

	if len(w.frames) != 2 {
		t.Fatalf("frames = %d, want 2", len(w.frames))
	}
	if len(w.frames[0].Units) != 2 {
		t.Errorf("frame0 units = %d, want 2", len(w.frames[0].Units))
	}
	if got := w.frames[0].Units[1]; got.UnitID != 101 || got.Pos.X != 600.5 || got.Team != 1 {
		t.Errorf("frame0 unit1 = %+v", got)
	}
	if len(w.frames[1].Units) != 1 {
		t.Errorf("frame1 units = %d, want 1", len(w.frames[1].Units))
	}

	if len(w.events) != 2 {
		t.Fatalf("events = %d, want 2", len(w.events))
	}
	if w.events[0].Kind != snapshot.EventCreated || w.events[0].UnitID != 102 {
		t.Errorf("event0 = %+v", w.events[0])
	}
	if w.events[1].Kind != snapshot.EventDestroyed || w.events[1].Frame != 58 {
		t.Errorf("event1 = %+v", w.events[1])
	}
}

func TestConsumeEmptyStillWritesMeta(t *testing.T) {
	w := &recordingWriter{}
	if err := Consume(strings.NewReader("no snapshot data here\n"), snapshot.Meta{GameID: "x"}, w); err != nil {
		t.Fatal(err)
	}
	if w.meta == nil {
		t.Error("meta should be written even for empty capture")
	}
}
