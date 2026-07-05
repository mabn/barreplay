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
		`BRSNAP DEF {"id":1,"name":"armcom","humanName":"Armada Commander","metalCost":2700,"maxHealth":3000,"xsize":8,"zsize":8,"iconType":"armcom","isBuilder":true}`,
		"BRSNAP D 2 corcom", // legacy id->name line still understood
		"BRSNAP T 0 0 armada #ff0000",
		"BRSNAP T 1 1 cortex #0000ff",
		"BRSNAP P 0 0 0 Alice",
		"BRSNAP P 1 1 0 Bob The Builder",
		"BRSNAP P 2 -1 1 Spectator Sam",
		"BRSNAP READY",
		"some other infolog line",
		"BRSNAP F 30 1.000 2",
		"BRSNAP U 100 1 0 512.0 80.0 1024.0 3000.0 3000.0 1.50 0.00 -2.25 0.750", // extended
		"BRSNAP U 101 2 1 600.5 82.0 900.0 2500.0 3000.0",                        // legacy (no vel/build)
		"BRSNAP R 0 500.0 1200.0 1000.0 5000.0 45.60 90.00",
		"BRSNAP R 1 250.0 800.0 1000.0 5000.0 30.00 60.00",
		"BRSNAP EV 45 created 102 1 0",
		"BRSNAP F 60 2.000 1",
		"BRSNAP U 100 1 0 512.0 80.0 1030.0 2900.0 3000.0",
		"BRSNAP EV 58 destroyed 101 2 1",
		"BRSNAP PROFD 300 120 1200.5 Sim",
		"BRSNAP PROFD 600 450 3400.0 Sim::Unit::MoveType",
		"BRSNAP PROF 95123.5 Sim",
		"BRSNAP PROF 61200.0 Lua",
	}, "\n")

	base := snapshot.Meta{
		GameID:        "gid123",
		EngineVersion: "2025.06.24",
		MapName:       "Isidis crack 1.1",
		SampleEvery:   30,
	}
	w := &recordingWriter{}
	var stats Stats
	if err := ConsumeStats(strings.NewReader(stream), base, w, &stats); err != nil {
		t.Fatalf("ConsumeStats: %v", err)
	}

	if w.meta == nil {
		t.Fatal("meta not written")
	}
	if w.meta.GameID != "gid123" {
		t.Errorf("meta GameID = %q", w.meta.GameID)
	}
	if d := w.meta.UnitDefs[1]; d.Name != "armcom" || d.HumanName != "Armada Commander" || d.MetalCost != 2700 || !d.IsBuilder {
		t.Errorf("unitDefs[1] = %+v", d)
	}
	if d := w.meta.UnitDefs[1]; d.XSize != 8 || d.ZSize != 8 || d.IconType != "armcom" {
		t.Errorf("unitDefs[1] footprint/icon = %+v", d)
	}
	if w.meta.UnitDefs[2].Name != "corcom" { // legacy D line
		t.Errorf("unitDefs[2] = %+v", w.meta.UnitDefs[2])
	}
	if len(w.meta.Teams) != 2 || w.meta.Teams[1].Side != "cortex" {
		t.Errorf("teams = %+v", w.meta.Teams)
	}
	if w.meta.Teams[0].Color != "#ff0000" || w.meta.Teams[1].Color != "#0000ff" {
		t.Errorf("team colors = %+v", w.meta.Teams)
	}
	// Player roster; team display names backfilled from the first non-spectator.
	if len(w.meta.Players) != 3 || w.meta.Players[1].Name != "Bob The Builder" || !w.meta.Players[2].Spectator {
		t.Errorf("players = %+v", w.meta.Players)
	}
	if w.meta.Teams[0].PlayerName != "Alice" || w.meta.Teams[1].PlayerName != "Bob The Builder" {
		t.Errorf("team player backfill = %+v", w.meta.Teams)
	}

	if len(w.frames) != 2 {
		t.Fatalf("frames = %d, want 2", len(w.frames))
	}
	if len(w.frames[0].Units) != 2 {
		t.Errorf("frame0 units = %d, want 2", len(w.frames[0].Units))
	}
	if got := w.frames[0].Units[0]; got.VelX != 1.5 || got.VelZ != -2.25 || got.BuildProgress != 0.75 {
		t.Errorf("frame0 unit0 velocity/build = %+v", got)
	}
	if got := w.frames[0].Units[1]; got.UnitID != 101 || got.Pos.X != 600.5 || got.Team != 1 {
		t.Errorf("frame0 unit1 = %+v", got)
	}
	if got := w.frames[0].Units[1]; got.VelX != 0 || got.BuildProgress != 0 {
		t.Errorf("frame0 unit1 legacy line should have zero vel/build: %+v", got)
	}
	if len(w.frames[1].Units) != 1 {
		t.Errorf("frame1 units = %d, want 1", len(w.frames[1].Units))
	}
	if len(w.frames[0].Resources) != 2 {
		t.Fatalf("frame0 resources = %d, want 2", len(w.frames[0].Resources))
	}
	if r := w.frames[0].Resources[0]; r.Team != 0 || r.Metal != 500 || r.EnergyStorage != 5000 || r.MetalIncome != 45.6 {
		t.Errorf("frame0 resource0 = %+v", r)
	}
	if len(w.frames[1].Resources) != 0 {
		t.Errorf("frame1 resources = %d, want 0 (none emitted)", len(w.frames[1].Resources))
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

	if stats.Frames != 2 || stats.LastFrame != 60 {
		t.Errorf("stats frames = %d lastFrame = %d, want 2/60", stats.Frames, stats.LastFrame)
	}
	if len(stats.Profile) != 2 || stats.Profile[0].Name != "Sim" || stats.Profile[0].Ms != 95123.5 {
		t.Errorf("stats.Profile = %+v", stats.Profile)
	}
	if stats.Profile[1].Name != "Lua" || stats.Profile[1].Ms != 61200.0 {
		t.Errorf("stats.Profile[1] = %+v", stats.Profile[1])
	}
	if len(stats.ProfileSamples) != 2 {
		t.Fatalf("ProfileSamples = %d, want 2", len(stats.ProfileSamples))
	}
	if s := stats.ProfileSamples[0]; s.Frame != 300 || s.Units != 120 || s.Ms != 1200.5 || s.Name != "Sim" {
		t.Errorf("ProfileSamples[0] = %+v", s)
	}
	if s := stats.ProfileSamples[1]; s.Frame != 600 || s.Units != 450 || s.Name != "Sim::Unit::MoveType" {
		t.Errorf("ProfileSamples[1] = %+v", s)
	}
}

// A frame whose declared count exceeds the U lines present (e.g. a truncated log
// write) is still persisted with the units that did arrive; the mismatch only
// warns.
func TestConsumeTruncatedFrameKeepsPartialUnits(t *testing.T) {
	stream := strings.Join([]string{
		"BRSNAP F 30 1.000 3", // declares 3 units
		"BRSNAP U 100 1 0 1.0 2.0 3.0 100.0 100.0",
		"BRSNAP U 101 1 0 4.0 5.0 6.0 100.0 100.0", // only 2 arrive
		"BRSNAP F 60 2.000 1",
		"BRSNAP U 102 1 0 7.0 8.0 9.0 100.0 100.0",
	}, "\n")
	w := &recordingWriter{}
	if err := Consume(strings.NewReader(stream), snapshot.Meta{GameID: "x"}, w); err != nil {
		t.Fatal(err)
	}
	if len(w.frames) != 2 {
		t.Fatalf("frames = %d, want 2", len(w.frames))
	}
	if len(w.frames[0].Units) != 2 {
		t.Errorf("truncated frame kept %d units, want the 2 that arrived", len(w.frames[0].Units))
	}
	if len(w.frames[1].Units) != 1 {
		t.Errorf("frame1 units = %d, want 1", len(w.frames[1].Units))
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
