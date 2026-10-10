package viz

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// writeLongBRP writes a capture spanning several chunks, with economy, so
// the rebuilt chunk offsets and the economy round trip are exercised.
func writeLongBRP(t *testing.T, dir string) string {
	t.Helper()
	w, err := snapshot.NewBRPWriter(dir, "long")
	if err != nil {
		t.Fatal(err)
	}
	meta := snapshot.Meta{
		GameID: "long", MapName: "Test Map", SampleEvery: 30,
		UnitDefs: map[int32]snapshot.UnitDef{
			1: {DefID: 1, Name: "armpw", HumanName: "Pawn", CanMove: true, Speed: 58, WeaponCount: 1, MetalCost: 50},
			2: {DefID: 2, Name: "armfus", IsBuilding: true, XSize: 10, ZSize: 10, MetalCost: 3600},
			3: {DefID: 3, Name: "armfig", CanMove: true, CanFly: true, Speed: 200, WeaponCount: 1, MetalCost: 80},
		},
		Teams:   []snapshot.TeamInfo{{TeamID: 0, AllyTeam: 0, Color: "#0000ff"}, {TeamID: 1, AllyTeam: 1}},
		Players: []snapshot.PlayerInfo{{PlayerID: 0, Name: "Ann", Team: 0}, {PlayerID: 1, Name: "Bob", Team: 1}},
	}
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 200; i++ {
		fr := snapshot.Frame{Frame: int32(i * 30), TimeSec: float32(i)}
		for u := int32(0); u < 5; u++ {
			fr.Units = append(fr.Units, snapshot.UnitState{UnitID: 10 + u, DefID: 1, Team: u % 2, Pos: snapshot.Vec3{X: float32(i*3) + float32(u), Z: float32(u * 100)}, Health: 100, MaxHealth: 100, BuildProgress: 1})
		}
		fr.Units = append(fr.Units, snapshot.UnitState{UnitID: 50, DefID: 2, Team: 1, Pos: snapshot.Vec3{X: 900, Z: 900}, Health: 10, MaxHealth: 5000, BuildProgress: float32(i%100) / 100, TargetID: int32(i % 3)})
		fr.Resources = []snapshot.TeamResource{{Team: 0, Metal: float32(i), MetalStorage: 1000, MetalIncome: 12, EnergyIncome: 300}, {Team: 1, Metal: 5, MetalIncome: 8}}
		if err := w.WriteFrame(fr); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.WriteEvent(snapshot.Event{Frame: 4500, Kind: snapshot.EventFinished, UnitID: 50, DefID: 2, Team: 1}); err != nil {
		t.Fatal(err)
	}
	if err := w.WriteComm(snapshot.Comm{Frame: 90, Kind: snapshot.CommChat, PlayerID: 0, Dest: snapshot.DestAll, Text: "gl"}); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "long.brp")
}

func dirFetcher(root string) PieceFetcher {
	return func(_ context.Context, key string) ([]byte, error) {
		b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(key)))
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return b, err
	}
}

// Rebuilding a replay from its published pieces must decode to the same
// frames, events, comms and economy as the .brp they were cut from.
func TestReadStaticBundleRoundTrip(t *testing.T) {
	brp := writeLongBRP(t, t.TempDir())
	out := t.TempDir()
	if _, err := WriteStaticBundle(brp, out); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(brp)
	if err != nil {
		t.Fatal(err)
	}
	orig, err := snapshot.ParseBRP(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}

	got, res, err := ReadStaticBundle(context.Background(), dirFetcher(out), "long")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Chunks) != len(orig.Chunks) || len(got.Chunks) < 3 {
		t.Fatalf("chunks = %d, want %d (>= 3)", len(got.Chunks), len(orig.Chunks))
	}
	for i := range orig.Chunks {
		want, err := orig.DecodeChunk(i)
		if err != nil {
			t.Fatal(err)
		}
		have, err := got.DecodeChunk(i)
		if err != nil {
			t.Fatalf("chunk %d: %v", i, err)
		}
		for j := range want {
			if !reflect.DeepEqual(want[j].Units, have[j].Units) {
				t.Fatalf("chunk %d frame %d units differ", i, j)
			}
			// The economy comes back separately, rounded to whole units.
			r := res[want[j].Frame]
			if len(r) != 2 || r[0].MetalIncome != 12 || r[0].Metal != float32(want[j].Frame/30) {
				t.Fatalf("frame %d economy = %+v", want[j].Frame, r)
			}
		}
	}
	we, _ := orig.Events()
	ge, err := got.Events()
	if err != nil || !reflect.DeepEqual(we, ge) {
		t.Errorf("events = %+v, %v; want %+v", ge, err, we)
	}
	wc, _ := orig.Comms()
	gc, err := got.Comms()
	if err != nil || !reflect.DeepEqual(wc, gc) {
		t.Errorf("comms = %+v, %v; want %+v", gc, err, wc)
	}
	// What the head keeps of the defs: the army cost, the footprint, names.
	if d := got.Meta.UnitDefs[1]; d.MetalCost != 50 || d.HumanName != "Pawn" || d.WeaponCount == 0 {
		t.Errorf("def 1 = %+v", d)
	}
	if d := got.Meta.UnitDefs[2]; d.MetalCost != 0 || !d.IsBuilding || d.XSize != 10 {
		t.Errorf("def 2 = %+v (no cost: armyCost prices armed mobile defs only)", d)
	}
	if d := got.Meta.UnitDefs[3]; !d.CanFly || got.Meta.UnitDefs[1].CanFly {
		t.Errorf("flight read off the icon: armfig %+v, armpw %+v", d, got.Meta.UnitDefs[1])
	}
	if len(got.Meta.Players) != 2 || got.Meta.Teams[0].Color != "#0000ff" {
		t.Errorf("roster = %+v / %+v", got.Meta.Players, got.Meta.Teams)
	}
}
