package packer

import (
	"os"
	"reflect"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// viewBRP writes a capture whose frames hold the given units at the given
// sim frames and parses it back.
func viewBRP(t *testing.T, meta snapshot.Meta, frames []snapshot.Frame) *snapshot.BRPFile {
	t.Helper()
	dir := t.TempDir()
	w, err := snapshot.NewBRPWriter(dir, "g")
	if err != nil {
		t.Fatal(err)
	}
	meta.GameID, meta.SampleEvery = "g", 30
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}
	for _, fr := range frames {
		if err := w.WriteFrame(fr); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(dir + "/g.brp")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	bf, err := snapshot.ParseBRP(f)
	if err != nil {
		t.Fatal(err)
	}
	return bf
}

func TestViewFromFrames(t *testing.T) {
	meta := snapshot.Meta{
		UnitDefs: map[int32]snapshot.UnitDef{
			1: {DefID: 1, Name: "armcom"},
			2: {DefID: 2, Name: "corcom"},
			3: {DefID: 3, Name: "armpw_scav"},
		},
		Teams: []snapshot.TeamInfo{
			{TeamID: 0, AllyTeam: 0, Side: "armada"},
			{TeamID: 1, AllyTeam: 0, Side: "armada"},
			{TeamID: 2, AllyTeam: 1, Side: "cortex"},
			{TeamID: 3, AllyTeam: 2, Side: "armada"}, // scavengers
			{TeamID: 4, AllyTeam: 3},                 // Gaia: no faction
		},
	}
	unit := func(id, def, team int32) snapshot.UnitState {
		return snapshot.UnitState{UnitID: id, DefID: def, Team: team, Health: 10, MaxHealth: 10}
	}
	frame := func(f int32, us ...snapshot.UnitState) snapshot.Frame {
		return snapshot.Frame{Frame: f, TimeSec: float32(f) / 30, Units: us}
	}
	cases := []struct {
		name   string
		frames []snapshot.Frame
		want   ViewCheck
	}{
		{"both sides at the start", []snapshot.Frame{
			frame(30, unit(1, 1, 0), unit(2, 1, 1), unit(3, 2, 2)),
		}, ViewCheck{View: "full", Sides: []int32{0, 1}}},
		{"one side", []snapshot.Frame{
			frame(30, unit(1, 1, 0), unit(2, 1, 1)),
			frame(60, unit(1, 1, 0), unit(2, 1, 1)),
		}, ViewCheck{View: "ally", Ally: 0, Sides: []int32{0}}},
		{"radar blips, scavengers and Gaia are no side", []snapshot.Frame{
			frame(30, unit(1, 2, 2), unit(2, 0, 0), unit(3, 3, 3), unit(4, 1, 4)),
		}, ViewCheck{View: "ally", Ally: 1, Sides: []int32{1}}},
		{"an enemy seen after 10 s does not count", []snapshot.Frame{
			frame(300, unit(1, 1, 0)),
			frame(330, unit(1, 1, 0), unit(2, 2, 2)),
		}, ViewCheck{View: "ally", Ally: 0, Sides: []int32{0}}},
		{"capture starting late", []snapshot.Frame{
			frame(9000, unit(1, 1, 0), unit(2, 2, 2)),
		}, ViewCheck{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := ViewFromFrames(viewBRP(t, meta, c.frames))
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestUploadView(t *testing.T) {
	spectator := snapshot.Meta{Recorder: &snapshot.RecorderInfo{Spectator: true}}
	player := snapshot.Meta{Recorder: &snapshot.RecorderInfo{AllyTeam: 1}}
	ally := func(v string, a *int32) string {
		if a == nil {
			return v
		}
		return v + "/" + string(rune('0'+*a))
	}
	cases := []struct {
		name string
		meta snapshot.Meta
		vc   ViewCheck
		want string
	}{
		{"frames say full, capture says player", player, ViewCheck{View: "full"}, "full"},
		{"frames say one side, capture says spectator", spectator, ViewCheck{View: "ally", Ally: 0}, "ally/0"},
		{"inconclusive keeps a one-sided claim", player, ViewCheck{}, ""},
		{"inconclusive does not believe a full claim", spectator, ViewCheck{}, "unknown"},
		{"inconclusive does not believe a re-sim claim", snapshot.Meta{Resim: true}, ViewCheck{}, "unknown"},
	}
	for _, c := range cases {
		if got := ally(UploadView(c.meta, c.vc)); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
