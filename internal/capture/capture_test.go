package capture

import (
	"bytes"
	"encoding/binary"
	"math"
	"strings"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// recordingWriter captures calls for assertions.
type recordingWriter struct {
	meta        *snapshot.Meta
	frames      []snapshot.Frame
	events      []snapshot.Event
	comms       []snapshot.Comm
	facts       []snapshot.Fact
	damage      []snapshot.DamageWindow
	lives       []snapshot.UnitLife
	visibility  []snapshot.Visibility
	hits        []snapshot.Hit
	unitEnds    []snapshot.UnitEnd
	projectiles []snapshot.Projectile
	blasts      []snapshot.Blast
	shields     []snapshot.Shield
	closed      bool
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
func (r *recordingWriter) WriteFact(f snapshot.Fact) error { r.facts = append(r.facts, f); return nil }
func (r *recordingWriter) WriteDamage(d snapshot.DamageWindow) error {
	r.damage = append(r.damage, d)
	return nil
}
func (r *recordingWriter) WriteLife(l snapshot.UnitLife) error {
	r.lives = append(r.lives, l)
	return nil
}
func (r *recordingWriter) WriteVisibility(v snapshot.Visibility) error {
	r.visibility = append(r.visibility, v)
	return nil
}
func (r *recordingWriter) WriteHit(h snapshot.Hit) error { r.hits = append(r.hits, h); return nil }
func (r *recordingWriter) WriteUnitEnd(u snapshot.UnitEnd) error {
	r.unitEnds = append(r.unitEnds, u)
	return nil
}
func (r *recordingWriter) WriteProjectile(p snapshot.Projectile) error {
	r.projectiles = append(r.projectiles, p)
	return nil
}
func (r *recordingWriter) WriteBlast(b snapshot.Blast) error {
	r.blasts = append(r.blasts, b)
	return nil
}
func (r *recordingWriter) WriteShield(s snapshot.Shield) error {
	r.shields = append(r.shields, s)
	return nil
}
func (r *recordingWriter) Close() error { r.closed = true; return nil }

// consumeBrep decodes a test stream built from a preamble and records.
func consumeBrep(t *testing.T, e *brepEnc, base snapshot.Meta) (*recordingWriter, *Stats) {
	t.Helper()
	w := &recordingWriter{}
	var st Stats
	if err := ConsumeBrepStats(bytes.NewReader(e.buf.Bytes()), base, w, &st); err != nil {
		t.Fatal(err)
	}
	return w, &st
}

// When the caller pre-seeds a rich player roster (from the demo startscript),
// the widget's live P line for the same id must not duplicate it.
func TestConsumeKeepsSeededPlayers(t *testing.T) {
	e := newBrepEnc("BRSNAP P 0 0 0 Alice\nBRSNAP P 5 3 0 Newcomer\nBRSNAP READY\n")
	base := snapshot.Meta{
		GameID:  "x",
		Players: []snapshot.PlayerInfo{{PlayerID: 0, Name: "Alice", Team: 0, CountryCode: "US", Skill: 31.24}},
	}
	w, _ := consumeBrep(t, e, base)
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

// The GAME line names the widget build that produced the stream. A player's
// installed copy can be arbitrarily old, so this is the only place it can be
// learned — the catalog stores it per replay, and a bad capture is traced back
// through it.
func TestConsumeRecordsWidgetBuild(t *testing.T) {
	const sha = "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736"
	e := newBrepEnc(`BRSNAP GAME {"protocol":3,"widgetVersion":"1.7.0","widgetDate":"2026-08-16","widgetSha":"` + sha + `","mode":"live"}` + "\n" +
		// A widget re-enabled mid-game appends a segment with its own
		// preamble; the capture is named after the build that started it.
		`BRSNAP GAME {"protocol":3,"widgetVersion":"9.9.9","mode":"live"}` + "\nBRSNAP READY\n")
	w, _ := consumeBrep(t, e, snapshot.Meta{})
	got := w.meta.Widget
	if got == nil {
		t.Fatal("Meta.Widget not recorded")
	}
	if want := (snapshot.WidgetInfo{Version: "1.7.0", Sha: sha, Date: "2026-08-16"}); *got != want {
		t.Errorf("Meta.Widget = %+v, want %+v", *got, want)
	}
	if w.meta.Recorder == nil {
		t.Error("a live capture must record its recorder")
	}
}

// An older widget reports only a version, and one installed straight from the
// repo was never SHA-stamped. Both must still record what they do know.
func TestConsumeWidgetBuildPartialAndAbsent(t *testing.T) {
	unstamped, _ := consumeBrep(t, newBrepEnc(`BRSNAP GAME {"protocol":3,"widgetVersion":"1.6.0","mode":"live"}`+"\nBRSNAP READY\n"), snapshot.Meta{})
	if w := unstamped.meta.Widget; w == nil || w.Version != "1.6.0" || w.Sha != "" || w.Date != "" {
		t.Errorf("partial widget info = %+v, want version only", w)
	}

	// The re-simulation sampler is the same widget file, but its build is
	// this tool's own and it is nobody's point of view: it records neither,
	// or the catalog would claim a player uploaded the re-sim.
	resim, _ := consumeBrep(t, newBrepEnc(`BRSNAP GAME {"protocol":4,"widgetVersion":"1.8.0","mode":"live","resim":true}`+"\nBRSNAP READY\n"), snapshot.Meta{})
	if resim.meta.Widget != nil || resim.meta.Recorder != nil {
		t.Errorf("re-sim capture recorded widget %+v / recorder %+v, want neither", resim.meta.Widget, resim.meta.Recorder)
	}
}

func TestConsumeEmptyStillWritesMeta(t *testing.T) {
	w, _ := consumeBrep(t, newBrepEnc(""), snapshot.Meta{GameID: "x"})
	if w.meta == nil {
		t.Error("meta should be written even for an empty capture")
	}
}

// C records carry chat and drawings. The text they hold comes from arbitrary
// players, so the parser must sanitize it; a record it cannot make sense of
// is dropped without taking the rest of the capture with it.
func TestConsumeComms(t *testing.T) {
	e := newBrepEnc("BRSNAP READY\n")
	for _, c := range []string{
		`{"f":60,"k":"chat","p":0,"d":"ally","t":"go north"}`,
		`{"f":90,"k":"chat","p":-1,"n":"LobbyOnly","d":"lobby","t":"gl hf"}`,
		`{"f":120,"k":"point","p":1,"x":1200.5,"z":3400.25,"t":"here"}`,
		`{"f":150,"k":"line","p":1,"x":1200,"z":3400,"x2":1260,"z2":3450}`,
		`{"f":180,"k":"erase","p":1,"x":1200,"z":3400}`,
		// Control characters (JSON can only carry them escaped) are flattened
		// to spaces and the result trimmed.
		`{"f":210,"k":"chat","p":0,"d":"all","t":"tab\u0009and\u0008reset  "}`,
		// Junk: unparseable JSON, and a kind the model does not define.
		"not json at all",
		`{"f":240,"k":"telepathy","p":0,"t":"?"}`,
		// No player id at all: unknown, not player 0.
		`{"f":270,"k":"chat","d":"all","t":"who said that"}`,
	} {
		e.record('C', []byte(c))
	}
	w, _ := consumeBrep(t, e, snapshot.Meta{})
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

// packLE builds a little-endian payload from typed values, mirroring the
// widget's VFS.Pack* calls.
func packLE(vals ...any) []byte {
	var b bytes.Buffer
	for _, v := range vals {
		switch x := v.(type) {
		case uint8:
			b.WriteByte(x)
		case uint16:
			binary.Write(&b, binary.LittleEndian, x)
		case uint32:
			binary.Write(&b, binary.LittleEndian, x)
		case float32:
			binary.Write(&b, binary.LittleEndian, math.Float32bits(x))
		default:
			panic("packLE: unsupported type")
		}
	}
	return b.Bytes()
}

// The protocol-4 records: an event's cause, game facts, damage windows, unit
// lives, visibility and profiler readings — what a re-simulation records for
// the game summary.
func TestConsumeAnalysisRecords(t *testing.T) {
	e := newBrepEnc("BRSNAP READY\n")
	e.record('E', []byte("90 destroyed 12 3 1 40 7 0 5"))
	e.record('E', []byte("91 destroyed 13 3 1 -1 -1 -1 -1")) // all unknown: no cause
	e.record('E', []byte("92 given 14 3 0 -1 -1 2 -1"))
	e.record('G', []byte(`{"k":"end","f":3000,"winners":[0]}`))
	e.record('G', []byte(`{"f":1}`)) // no kind: dropped
	e.record('D', packLE(uint32(60), uint16(2),
		uint8(0), uint8(255), // aTeam
		uint16(7), uint16(65535), // aDef
		uint16(5), uint16(65535), // weapon
		uint8(1), uint8(1), // vTeam
		uint16(3), uint16(3), // vDef
		float32(120.5), float32(40), // damage
		float32(0), float32(0), // paralyze
		uint16(3), uint16(1), // hits
		float32(20), float32(0), // overkill: a pre-change stream, subtracted
	))
	e.record('S', packLE(uint32(90), uint16(1),
		uint16(12), uint16(3), uint8(1), uint32(30), uint32(90),
		float32(10), float32(160.5), uint16(2), uint8(0), float32(0.25)))
	e.record('S', packLE(uint32(3000), uint16(1),
		uint16(40), uint16(7), uint8(0), uint32(0), uint32(0xFFFFFF),
		float32(160.5), float32(0), uint16(1), uint8(100), float32(0)))
	e.record('V', packLE(uint32(60), uint8(1), uint8(2), uint8(0), uint8(1), uint16(2),
		uint16(12), uint16(40), uint16(0b1011), uint16(0b0011), uint16(0), uint16(0)))
	e.record('P', []byte(`{"f":300,"u":10,"r":[["Sim",1200.5],["Lua",80]]}`))
	e.record('P', []byte(`{"f":3000,"u":4,"final":true,"r":[["Sim",9000],["Lua",500]]}`))
	w, st := consumeBrep(t, e, snapshot.Meta{})

	if len(w.events) != 3 {
		t.Fatalf("events = %+v", w.events)
	}
	if c := w.events[0].Cause; c == nil || *c != (snapshot.EventCause{UnitID: 40, DefID: 7, Team: 0, WeaponDef: 5}) {
		t.Errorf("kill cause = %+v", c)
	}
	if w.events[1].Cause != nil {
		t.Errorf("an all-unknown cause must decode as none, got %+v", w.events[1].Cause)
	}
	if ev := w.events[2]; ev.Kind != snapshot.EventGiven || ev.Team != 0 || ev.Cause == nil || ev.Cause.Team != 2 {
		t.Errorf("given = %+v (cause %+v)", ev, ev.Cause)
	}

	if len(w.facts) != 1 || w.facts[0].Kind != snapshot.FactEnd || w.facts[0].Frame != 3000 {
		t.Fatalf("facts = %+v", w.facts)
	}
	var end snapshot.FactEndData
	if err := w.facts[0].Decode(&end); err != nil || len(end.Winners) != 1 || end.Winners[0] != 0 {
		t.Errorf("end = %+v (%v)", end, err)
	}

	wantD := snapshot.DamageWindow{Frame: 60, Rows: []snapshot.DamageRow{
		{AttackerTeam: 0, AttackerDef: 7, WeaponDef: 5, VictimTeam: 1, VictimDef: 3, Damage: 100.5, Hits: 3},
		{AttackerTeam: -1, AttackerDef: -1, WeaponDef: -1, VictimTeam: 1, VictimDef: 3, Damage: 40, Hits: 1},
	}}
	if len(w.damage) != 1 || w.damage[0].Frame != wantD.Frame || len(w.damage[0].Rows) != 2 ||
		w.damage[0].Rows[0] != wantD.Rows[0] || w.damage[0].Rows[1] != wantD.Rows[1] {
		t.Errorf("damage = %+v, want %+v", w.damage, wantD)
	}

	wantL := []snapshot.UnitLife{
		{UnitID: 12, DefID: 3, Team: 1, Born: 30, Died: 90, Dealt: 10, Taken: 160.5, Kills: 2, MinHealthPct: 0, XP: 0.25},
		{UnitID: 40, DefID: 7, Team: 0, Born: 0, Died: -1, Dealt: 160.5, Kills: 1, MinHealthPct: 100},
	}
	if len(w.lives) != 2 || w.lives[0] != wantL[0] || w.lives[1] != wantL[1] {
		t.Errorf("lives = %+v, want %+v", w.lives, wantL)
	}

	if len(w.visibility) != 1 {
		t.Fatalf("visibility = %+v", w.visibility)
	}
	v := w.visibility[0]
	if !v.Full || v.Frame != 60 || len(v.Allies) != 2 || len(v.Units) != 2 || v.Units[1] != 40 {
		t.Fatalf("visibility = %+v", v)
	}
	if los, radar := v.Sees(0, 1); los || !radar { // unit 12, side 1: bits 10
		t.Errorf("unit 12 side 1: los %v radar %v, want radar only", los, radar)
	}
	if los, radar := v.Sees(1, 0); !los || !radar {
		t.Errorf("unit 40 side 0: los %v radar %v, want both", los, radar)
	}

	if st.Facts != 1 || st.DamageWindows != 1 || st.Lives != 2 || st.Visibility != 1 {
		t.Errorf("stats = %+v", st)
	}
	if len(st.Profile) != 2 || st.Profile[0].Name != "Sim" || st.Profile[0].Ms != 9000 {
		t.Errorf("profile = %+v", st.Profile)
	}
	if len(st.ProfileSamples) != 2 || st.ProfileSamples[0] != (ProfileSample{Frame: 300, Units: 10, Ms: 1200.5, Name: "Sim"}) {
		t.Errorf("profile samples = %+v", st.ProfileSamples)
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
	stream := func() *bytes.Reader {
		e := newBrepEnc("BRSNAP READY\n")
		e.record('C', []byte(`{"f":60,"k":"chat","p":0,"d":"all","t":"from the widget"}`))
		return bytes.NewReader(e.buf.Bytes())
	}
	demo := []snapshot.Comm{
		{Frame: 61, Kind: snapshot.CommChat, PlayerID: 1, Dest: snapshot.DestAlly, Text: "from the demo"},
	}

	t.Run("replaces", func(t *testing.T) {
		w := &recordingWriter{}
		// ConsumeBrep never closes the writer; the caller does, and that is
		// when the replacement comms are written.
		rc := ReplaceComms(w, demo)
		if err := ConsumeBrep(stream(), snapshot.Meta{}, rc); err != nil {
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
		if err := ConsumeBrep(stream(), snapshot.Meta{}, ReplaceComms(w, nil)); err != nil {
			t.Fatal(err)
		}
		if len(w.comms) != 1 || w.comms[0].Text != "from the widget" {
			t.Errorf("comms = %+v, want the stream's", w.comms)
		}
	})
}
