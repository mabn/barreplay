package capture

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

var update = flag.Bool("update", false, "rewrite the harness golden dumps from the current fixtures")

// TestHarnessGolden pins the Lua encoder <-> Go decoder lockstep:
// tools/brep-harness/harness.lua runs the REAL widget
// (assets/lua/replay_uploader.lua) over one deterministic simulated game, once
// as the live uploader and once as the re-simulation sampler, and this test
// decodes each .brepstream and compares everything the decoder hands a writer
// — meta, every frame's units and resources, events, comms, game facts,
// hits, unit ends, visibility, profiler readings — against a
// committed golden dump, line by line.
//
// After a widget or decoder change, regenerate the fixtures (see the harness
// header) and run `go test -run TestHarnessGolden -update`. The golden diff is
// then exactly the change in what gets recorded; read it before committing.
func TestHarnessGolden(t *testing.T) {
	for _, name := range []string{"harness", "harness_resim", "harness_sandboxed"} {
		t.Run(name, func(t *testing.T) {
			got := harnessDump(t, "testdata/"+name+".brepstream")
			golden := "testdata/" + name + ".golden.txt.gz"
			if *update {
				var buf bytes.Buffer
				gz, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
				gz.Write(got)
				gz.Close()
				if err := os.WriteFile(golden, buf.Bytes(), 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			f, err := os.Open(golden)
			if err != nil {
				t.Fatalf("open golden (run with -update to create it): %v", err)
			}
			defer f.Close()
			zr, err := gzip.NewReader(f)
			if err != nil {
				t.Fatal(err)
			}
			want, err := io.ReadAll(zr)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, want) {
				gl, wl := strings.Split(string(got), "\n"), strings.Split(string(want), "\n")
				for i := 0; i < len(gl) || i < len(wl); i++ {
					var g, w string
					if i < len(gl) {
						g = gl[i]
					}
					if i < len(wl) {
						w = wl[i]
					}
					if g != w {
						t.Fatalf("decoded %s differs from %s at line %d:\n got: %s\nwant: %s", name, golden, i+1, g, w)
					}
				}
			}
		})
	}
}

// The harness scripts what each mode must and must not record; these pin the
// headline facts so a regenerated golden cannot quietly lose them.
func TestHarnessRecordsWhatEachModeOwes(t *testing.T) {
	live := decodeHarness(t, "testdata/harness.brepstream")
	resim := decodeHarness(t, "testdata/harness_resim.brepstream")

	// Comms: the harness scripts console lines that must NOT be recorded
	// (engine noise, the widget's own heartbeat echo, an unknown speaker, and
	// the "added point" line duplicating a MapDrawCmd), so a parser that got
	// greedier shows up as extra comms here.
	kinds := map[snapshot.CommKind]int{}
	for _, c := range live.w.comms {
		kinds[c.Kind]++
	}
	if kinds[snapshot.CommChat] != 9 || kinds[snapshot.CommPoint] != 3 ||
		kinds[snapshot.CommLine] != 2 || kinds[snapshot.CommErase] != 1 {
		t.Errorf("live comm kinds: %v", kinds)
	}

	// The live uploader records no analysis: a playing client is handed no
	// killer, and the damage/visibility recording is the re-sim's.
	if len(live.w.hits)+len(live.w.unitEnds)+len(live.w.visibility) != 0 {
		t.Errorf("live capture recorded analysis: %d hits, %d unit ends, %d visibility",
			len(live.w.hits), len(live.w.unitEnds), len(live.w.visibility))
	}
	for _, e := range live.w.events {
		if e.Kind == snapshot.EventDestroyed && e.Cause != nil {
			t.Errorf("live capture has a killer: %+v", e)
		}
	}
	if live.w.meta.Recorder == nil || live.w.meta.Widget == nil {
		t.Error("live capture must name its recorder and widget build")
	}

	if resim.w.meta.Recorder != nil || resim.w.meta.Widget != nil {
		t.Error("re-sim capture must name no recorder and no widget build")
	}
	kills := 0
	for _, e := range resim.w.events {
		if e.Kind == snapshot.EventDestroyed && e.Cause != nil && e.Cause.UnitID >= 0 {
			kills++
		}
	}
	if kills == 0 {
		t.Error("re-sim capture recorded no killers")
	}
	factKinds := map[string]int{}
	for _, f := range resim.w.facts {
		factKinds[f.Kind]++
	}
	for _, k := range []string{snapshot.FactEnd, snapshot.FactTeamDied, snapshot.FactPlayerLeft, snapshot.FactWeaponDefs, snapshot.FactTeamStats} {
		if factKinds[k] == 0 {
			t.Errorf("re-sim capture has no %q fact (facts: %v)", k, factKinds)
		}
	}
	if len(resim.w.hits) == 0 || len(resim.w.unitEnds) == 0 || len(resim.w.visibility) == 0 {
		t.Errorf("re-sim analysis: %d hits, %d unit ends, %d visibility", len(resim.w.hits), len(resim.w.unitEnds), len(resim.w.visibility))
	}
	// The widget draws no conclusions: the damage it used to sum and the
	// lives it used to total are computed from the hits by internal/combat.
	if len(resim.w.damage)+len(resim.w.lives) != 0 {
		t.Errorf("re-sim wrote derived records: %d damage windows, %d lives", len(resim.w.damage), len(resim.w.lives))
	}
	if len(resim.st.Profile) == 0 || len(resim.st.ProfileSamples) == 0 {
		t.Error("re-sim capture recorded no profiler readings")
	}
	// A re-simulation records a unit at 0 hp for as long as the engine lists
	// it before its destroyed event (a crashing aircraft — the viewer draws
	// it grey): unit 144 crashes at sample 60 and is destroyed at 63.
	for _, f := range []int32{60 * 30, 62 * 30} {
		if u, ok := unitAt(resim.w.frames, f, 144); !ok || u.Health != 0 || u.MaxHealth <= 0 {
			t.Errorf("unit 144 at frame %d: %+v (present %v), want it at 0 hp", f, u, ok)
		}
	}
	// ...and once that event is in the stream it is gone, as it always was.
	if _, ok := unitAt(resim.w.frames, 64*30, 144); ok {
		t.Error("unit 144 outlived its destroyed event")
	}

	checkHarnessProjectiles(t, live, resim)
	checkHarnessShields(t, live, resim)
}

// checkHarnessShields pins the protocol-6 Q records against the harness's
// shield stub (GetUnitShieldState): both modes record them, only the shield
// defs' units appear, and a row is written only when the reading moved.
func checkHarnessShields(t *testing.T, live, resim decodedHarness) {
	t.Helper()
	for name, d := range map[string]decodedHarness{"live": live, "resim": resim} {
		if len(d.w.shields) == 0 {
			t.Errorf("%s capture recorded no shield readings", name)
			continue
		}
		last := map[int32]snapshot.Shield{}
		off := 0
		for _, s := range d.w.shields {
			if !s.Enabled {
				off++
			}
			if p, ok := last[s.Unit]; ok && s.Frame == p.Frame+30 && p.Power == s.Power && p.Enabled == s.Enabled {
				t.Errorf("%s: unit %d rewrote an unchanged reading at frame %d", name, s.Unit, s.Frame)
			}
			last[s.Unit] = s
		}
		if off == 0 {
			t.Errorf("%s: no switched-off shield recorded", name)
		}
	}
}

// checkHarnessProjectiles pins the protocol-5 records against the harness's
// projectile script (tools/brep-harness/harness.lua, projectileScript), which
// covers every way a track can end and both kinds of blast.
func checkHarnessProjectiles(t *testing.T, live, resim decodedHarness) {
	t.Helper()
	if n := len(live.w.projectiles) + len(live.w.blasts); n != 0 {
		t.Errorf("live capture recorded %d projectile records; they are the re-sim's", n)
	}
	tracks := map[[2]int32]snapshot.Projectile{} // (id, birth): ids are recycled
	for _, p := range resim.w.projectiles {
		tracks[[2]int32{p.ID, p.Birth}] = p
	}
	if len(tracks) != 11 {
		t.Errorf("re-sim recorded %d tracks, want 11", len(tracks))
	}
	check := func(id, birth int32, class, end, flags uint8) snapshot.Projectile {
		t.Helper()
		p, ok := tracks[[2]int32{id, birth}]
		if !ok {
			t.Errorf("no track for projectile %d born at %d", id, birth)
			return p
		}
		if p.Class != class || p.EndKind != end || p.Flags != flags {
			t.Errorf("track %d@%d: class %d end %d flags %d, want %d %d %d",
				id, birth, p.Class, p.EndKind, p.Flags, class, end, flags)
		}
		return p
	}
	check(7001, 610, snapshot.ProjArtillery, snapshot.TrackExploded, 0)
	// The same id fired again, deleted with no explosion: the sweep closes it.
	check(7001, 1210, snapshot.ProjArtillery, snapshot.TrackVanished, 0)
	nuke := check(7002, 1500, snapshot.ProjNuke, snapshot.TrackExploded, snapshot.TrackEngaged|snapshot.TrackIntercepted)
	if len(nuke.Path) == 0 || nuke.Path[0].DF != 10 {
		t.Errorf("nuke path %+v: a strategic track is sampled every 10 frames", nuke.Path)
	}
	amd := check(7003, 1560, snapshot.ProjAntiNuke, snapshot.TrackExploded, 0)
	if amd.TargetType != 'p' || amd.Target != 7002 {
		t.Errorf("anti-nuke target %c %d, want the nuke 7002", amd.TargetType, amd.Target)
	}
	check(7004, 2400, snapshot.ProjNuke, snapshot.TrackExploded, 0) // not intercepted
	check(7005, 4150, snapshot.ProjArtillery, snapshot.TrackOpen, 0)
	// A homing long-range AA missile: tracked, its path sampled like a
	// strategic track's.
	aa := check(7006, 700, snapshot.ProjAA, snapshot.TrackExploded, 0)
	if len(aa.Path) == 0 || aa.Path[0].DF != 10 {
		t.Errorf("AA missile path %+v: a homing AA track is sampled every 10 frames", aa.Path)
	}
	// A volley gun with a windup: the shells leave 75 frames after the
	// reload frame moved, each one still found and tracked.
	for k, birth := range []int32{3075, 3078, 3081} {
		if p := check(7101+int32(k), birth, snapshot.ProjArtillery, snapshot.TrackExploded, 0); p.Owner != 506 {
			t.Errorf("volley shell %d owned by %d, want 506", k, p.Owner)
		}
	}
	beam := check(8000, 1800, snapshot.ProjBeam, snapshot.TrackExploded, 0)
	if beam.End != 1844 {
		t.Errorf("beam ended at %d, want its last hit at 1844", beam.End)
	}
	var dfs []int32
	for _, pt := range beam.Path {
		dfs = append(dfs, pt.DF)
	}
	if want := []int32{0, 5, 15, 20, 25, 30, 35, 40, 44}; !reflect.DeepEqual(dfs, want) {
		t.Errorf("beam hit points at %v, want %v (frames 10-14 hit nothing, 30 jumped, 44 is the last)", dfs, want)
	}

	kinds := map[uint8]int{}
	for _, b := range resim.w.blasts {
		kinds[b.Kind]++
		if b.Kind == snapshot.BlastUnit && (b.Unit != 505 || b.Team != 1 || b.Weapon != 11) {
			t.Errorf("unit blast %+v, want the fusion 505 of team 1 (weapon 11)", b)
		}
	}
	if kinds[snapshot.BlastUnit] != 1 || kinds[snapshot.BlastStray] != 2 || len(resim.w.blasts) != 3 {
		t.Errorf("blast kinds %v, want 1 unit blast and 2 cluster sub-munitions", kinds)
	}
	stock := 0
	for _, f := range resim.w.facts {
		if f.Kind == "stock" {
			stock++
		}
	}
	if stock != 6 {
		t.Errorf("%d stock facts, want 6", stock)
	}
}

func unitAt(frames []snapshot.Frame, frame, id int32) (snapshot.UnitState, bool) {
	for _, f := range frames {
		if f.Frame == frame {
			for _, u := range f.Units {
				if u.UnitID == id {
					return u, true
				}
			}
		}
	}
	return snapshot.UnitState{}, false
}

type decodedHarness struct {
	w  *recordingWriter
	st *Stats
}

func decodeHarness(t *testing.T, path string) decodedHarness {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w := &recordingWriter{}
	var st Stats
	if err := ConsumeBrepStats(f, snapshot.Meta{}, w, &st); err != nil {
		t.Fatalf("ConsumeBrep(%s): %v", path, err)
	}
	return decodedHarness{w: w, st: &st}
}

// harnessDump renders a decoded capture as one line per record, so a golden
// diff points at exactly what changed.
func harnessDump(t *testing.T, path string) []byte {
	t.Helper()
	d := decodeHarness(t, path)
	var buf bytes.Buffer
	out := bufio.NewWriter(&buf)
	line := func(tag string, v any) {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(out, "%s %s\n", tag, b)
	}
	m := *d.w.meta
	defs := m.UnitDefs
	m.UnitDefs = nil
	line("META", m)
	for id := int32(0); id < 1<<16; id++ {
		if def, ok := defs[id]; ok {
			line("DEF", def)
		}
	}
	for _, f := range d.w.frames {
		fmt.Fprintf(out, "F %d t=%g units=%d\n", f.Frame, f.TimeSec, len(f.Units))
		for _, u := range f.Units {
			fmt.Fprintf(out, "U %d def=%d team=%d x=%g z=%g hp=%g/%g v=%g,%g build=%g target=%d\n",
				u.UnitID, u.DefID, u.Team, u.Pos.X, u.Pos.Z, u.Health, u.MaxHealth, u.VelX, u.VelZ, u.BuildProgress, u.TargetID)
		}
		for _, r := range f.Resources {
			line("R", r)
		}
	}
	for _, e := range d.w.events {
		line("E", e)
	}
	for _, c := range d.w.comms {
		line("C", c)
	}
	for _, f := range d.w.facts {
		line("G", f)
	}
	for _, x := range d.w.damage {
		line("D", x)
	}
	for _, l := range d.w.lives {
		line("S", l)
	}
	for _, h := range d.w.hits {
		line("H", h)
	}
	for _, u := range d.w.unitEnds {
		line("UE", u)
	}
	for _, v := range d.w.visibility {
		line("V", v)
	}
	for _, p := range d.w.projectiles {
		line("RT", p)
	}
	for _, b := range d.w.blasts {
		line("B", b)
	}
	for _, s := range d.w.shields {
		line("Q", s)
	}
	line("PROF", d.st.Profile)
	line("PROFD", d.st.ProfileSamples)
	out.Flush()
	return buf.Bytes()
}
