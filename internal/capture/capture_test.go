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
	comms  []snapshot.Comm
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
func (r *recordingWriter) WriteComm(c snapshot.Comm) error {
	r.comms = append(r.comms, c)
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
	// No GAME line = legacy stream: the over-scaled income is divided back by
	// the default gameSpeed (30) at decode time (see repairIncome).
	if r := w.frames[0].Resources[0]; r.Team != 0 || r.Metal != 500 || r.EnergyStorage != 5000 || r.MetalIncome != float32(45.6)/30 {
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

// When the caller pre-seeds a rich player roster (from the demo startscript),
// the widget's live P line for the same id must not duplicate it.
func TestConsumeKeepsSeededPlayers(t *testing.T) {
	stream := strings.Join([]string{
		"BRSNAP P 0 0 0 Alice",    // same id as the seed -> merged away
		"BRSNAP P 5 3 0 Newcomer", // not in the seed -> appended
		"BRSNAP READY",
	}, "\n")
	base := snapshot.Meta{
		GameID:  "x",
		Players: []snapshot.PlayerInfo{{PlayerID: 0, Name: "Alice", Team: 0, CountryCode: "US", Skill: 31.24}},
	}
	w := &recordingWriter{}
	if err := Consume(strings.NewReader(stream), base, w); err != nil {
		t.Fatal(err)
	}
	if len(w.meta.Players) != 2 {
		t.Fatalf("players = %d, want 2 (seed kept, newcomer added)", len(w.meta.Players))
	}
	if p := w.meta.Players[0]; p.Skill != 31.24 || p.CountryCode != "US" {
		t.Errorf("seeded player0 lost its rich fields: %+v", p)
	}
	if w.meta.Players[1].Name != "Newcomer" {
		t.Errorf("newcomer not appended: %+v", w.meta.Players)
	}
}

// Protocol >= 3 streams write income as the engine reports it (already per
// game-second); the legacy repair must NOT touch it.
func TestConsumeProtocol3IncomeUnscaled(t *testing.T) {
	stream := strings.Join([]string{
		`BRSNAP GAME {"protocol":3,"sampleEvery":30,"gameSpeed":30}`,
		"BRSNAP READY",
		"BRSNAP F 30 1.000 0",
		"BRSNAP R 0 500.0 1200.0 1000.0 5000.0 2.00 45.00",
	}, "\n")
	w := &recordingWriter{}
	if err := Consume(strings.NewReader(stream), snapshot.Meta{}, w); err != nil {
		t.Fatal(err)
	}
	if len(w.frames) != 1 || len(w.frames[0].Resources) != 1 {
		t.Fatalf("frames = %+v", w.frames)
	}
	if r := w.frames[0].Resources[0]; r.MetalIncome != 2 || r.EnergyIncome != 45 {
		t.Errorf("protocol 3 income must pass through unscaled: %+v", r)
	}
}

// The GAME line names the widget build that produced the stream. A player's
// installed copy can be arbitrarily old, so this is the only place it can be
// learned — the catalog stores it per replay, and a bad capture is traced back
// through it.
func TestConsumeRecordsWidgetBuild(t *testing.T) {
	const sha = "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736"
	stream := strings.Join([]string{
		`BRSNAP GAME {"protocol":3,"widgetVersion":"1.7.0","widgetDate":"2026-08-16","widgetSha":"` + sha + `","mode":"live"}`,
		// A widget re-enabled mid-game appends a segment with its own
		// preamble; the capture is named after the build that started it.
		`BRSNAP GAME {"protocol":3,"widgetVersion":"9.9.9","mode":"live"}`,
		"BRSNAP READY",
	}, "\n")
	w := &recordingWriter{}
	if err := Consume(strings.NewReader(stream), snapshot.Meta{}, w); err != nil {
		t.Fatal(err)
	}
	got := w.meta.Widget
	if got == nil {
		t.Fatal("Meta.Widget not recorded")
	}
	if want := (snapshot.WidgetInfo{Version: "1.7.0", Sha: sha, Date: "2026-08-16"}); *got != want {
		t.Errorf("Meta.Widget = %+v, want %+v", *got, want)
	}
}

// An older widget reports only a version, and one installed straight from the
// repo was never SHA-stamped. Both must still record what they do know.
func TestConsumeWidgetBuildPartialAndAbsent(t *testing.T) {
	unstamped := &recordingWriter{}
	if err := Consume(strings.NewReader(
		`BRSNAP GAME {"protocol":3,"widgetVersion":"1.6.0","mode":"live"}`+"\nBRSNAP READY",
	), snapshot.Meta{}, unstamped); err != nil {
		t.Fatal(err)
	}
	if w := unstamped.meta.Widget; w == nil || w.Version != "1.6.0" || w.Sha != "" || w.Date != "" {
		t.Errorf("partial widget info = %+v, want version only", w)
	}

	// A re-sim capture's GAME line names no widget at all: nothing to record,
	// and inventing an empty struct would make the catalog claim otherwise.
	resim := &recordingWriter{}
	if err := Consume(strings.NewReader(
		`BRSNAP GAME {"protocol":3,"mode":"replay"}`+"\nBRSNAP READY",
	), snapshot.Meta{}, resim); err != nil {
		t.Fatal(err)
	}
	if resim.meta.Widget != nil {
		t.Errorf("Meta.Widget = %+v, want nil for a capture that names none", resim.meta.Widget)
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

// COMM records carry chat and drawings. The text they hold comes from
// arbitrary players, so the parser must sanitize it; a record it cannot make
// sense of is dropped without taking the rest of the capture with it.
func TestConsumeComms(t *testing.T) {
	stream := strings.Join([]string{
		"BRSNAP READY",
		`BRSNAP COMM {"f":60,"k":"chat","p":0,"d":"ally","t":"go north"}`,
		`BRSNAP COMM {"f":90,"k":"chat","p":-1,"n":"LobbyOnly","d":"lobby","t":"gl hf"}`,
		`BRSNAP COMM {"f":120,"k":"point","p":1,"x":1200.5,"z":3400.25,"t":"here"}`,
		`BRSNAP COMM {"f":150,"k":"line","p":1,"x":1200,"z":3400,"x2":1260,"z2":3450}`,
		`BRSNAP COMM {"f":180,"k":"erase","p":1,"x":1200,"z":3400}`,
		// Control characters (JSON can only carry them escaped) are flattened
		// to spaces and the result trimmed.
		`BRSNAP COMM {"f":210,"k":"chat","p":0,"d":"all","t":"tab\u0009and\u0008reset  "}`,
		// Junk: unparseable JSON, and a kind the model does not define.
		"BRSNAP COMM not json at all",
		`BRSNAP COMM {"f":240,"k":"telepathy","p":0,"t":"?"}`,
		// No player id at all: unknown, not player 0.
		`BRSNAP COMM {"f":270,"k":"chat","d":"all","t":"who said that"}`,
	}, "\n")
	w := &recordingWriter{}
	if err := Consume(strings.NewReader(stream), snapshot.Meta{}, w); err != nil {
		t.Fatal(err)
	}
	want := []snapshot.Comm{
		{Frame: 60, Kind: snapshot.CommChat, PlayerID: 0, Dest: "ally", Text: "go north"},
		{Frame: 90, Kind: snapshot.CommChat, PlayerID: -1, Name: "LobbyOnly", Dest: "lobby", Text: "gl hf"},
		{Frame: 120, Kind: snapshot.CommPoint, PlayerID: 1, X: 1200.5, Z: 3400.25, Text: "here"},
		{Frame: 150, Kind: snapshot.CommLine, PlayerID: 1, X: 1200, Z: 3400, X2: 1260, Z2: 3450},
		{Frame: 180, Kind: snapshot.CommErase, PlayerID: 1, X: 1200, Z: 3400},
		{Frame: 210, Kind: snapshot.CommChat, PlayerID: 0, Dest: "all", Text: "tab and reset"},
		{Frame: 270, Kind: snapshot.CommChat, PlayerID: -1, Dest: "all", Text: "who said that"},
	}
	if len(w.comms) != len(want) {
		t.Fatalf("comms = %+v", w.comms)
	}
	for i := range want {
		if w.comms[i] != want[i] {
			t.Errorf("comm[%d] = %+v, want %+v", i, w.comms[i], want[i])
		}
	}
}

func TestSanitizeCommText(t *testing.T) {
	long := strings.Repeat("é", maxCommText) // 2 bytes per rune: must cut cleanly
	for _, tc := range []struct{ in, want string }{
		{"plain", "plain"},
		{"\xff\x10\x20\x30coloured", "coloured"}, // colour code + RGB
		{"a\bb", "a b"},                          // reset byte
		{"  trimmed\t\n", "trimmed"},             // control chars -> space, then trimmed
		{"caf\xc3\xa9", "café"},                  // valid UTF-8 survives
		{"bad\xc3", "bad�"},                      // truncated sequence
		{long, long[:maxCommText]},               // truncated at a rune boundary
	} {
		if got := sanitizeCommText(tc.in); got != tc.want {
			t.Errorf("sanitizeCommText(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// The demo is the authoritative source for comms, so when a caller has them
// they replace whatever the capture stream recorded — but only when the demo
// actually yielded some, since an empty result also means "truncated stream".
func TestReplaceComms(t *testing.T) {
	stream := strings.Join([]string{
		"BRSNAP READY",
		`BRSNAP COMM {"f":60,"k":"chat","p":0,"d":"all","t":"from the widget"}`,
	}, "\n")
	demo := []snapshot.Comm{
		{Frame: 61, Kind: snapshot.CommChat, PlayerID: 1, Dest: snapshot.DestAlly, Text: "from the demo"},
	}

	t.Run("replaces", func(t *testing.T) {
		w := &recordingWriter{}
		// Consume never closes the writer; the caller does, and that is when the
		// replacement comms are written.
		rc := ReplaceComms(w, demo)
		if err := Consume(strings.NewReader(stream), snapshot.Meta{}, rc); err != nil {
			t.Fatal(err)
		}
		if err := rc.Close(); err != nil {
			t.Fatal(err)
		}
		if len(w.comms) != 1 || w.comms[0] != demo[0] {
			t.Errorf("comms = %+v, want the demo's", w.comms)
		}
		if !w.closed {
			t.Error("Close must reach the wrapped writer")
		}
	})

	t.Run("empty keeps the stream's", func(t *testing.T) {
		w := &recordingWriter{}
		if err := Consume(strings.NewReader(stream), snapshot.Meta{}, ReplaceComms(w, nil)); err != nil {
			t.Fatal(err)
		}
		if len(w.comms) != 1 || w.comms[0].Text != "from the widget" {
			t.Errorf("comms = %+v, want the stream's", w.comms)
		}
	})
}
