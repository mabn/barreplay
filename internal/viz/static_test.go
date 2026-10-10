package viz

import (
	"bytes"
	"encoding/json"
	"flag"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// -update rewrites the committed files this package generates for the viewer
// (the icon table and the viewer test fixture):
//
//	go test ./internal/viz -run 'IconTypes|ViewerFixture' -update
var update = flag.Bool("update", false, "rewrite generated files (icontypes.json, viewer fixture)")

// A bundle is the .brp alone, byte-for-byte when the capture already carries
// its section layout, and index.json lists it beside an older bundle that
// still has only its .brw head.
func TestStaticBundleIsTheBRP(t *testing.T) {
	src := t.TempDir()
	brp := writeBRP(t, src, "g")
	out := t.TempDir()
	id, err := WriteStaticBundle(brp, out)
	if err != nil {
		t.Fatal(err)
	}
	if id != "g" {
		t.Fatalf("id = %q", id)
	}
	want, _ := os.ReadFile(brp)
	got, err := os.ReadFile(filepath.Join(out, "replays", "g.brp"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Error("published .brp differs from the capture")
	}
	entries, _ := os.ReadDir(filepath.Join(out, "replays"))
	if len(entries) != 1 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("bundle holds %v, want only g.brp", names)
	}

	// An older bundle in the same mirror (head + split pieces, no .brp).
	old := filepath.Join(out, "replays")
	os.WriteFile(filepath.Join(old, "old.brw"), make([]byte, 10), 0o644)
	os.WriteFile(filepath.Join(old, "old.resources"), make([]byte, 5), 0o644)
	os.MkdirAll(filepath.Join(old, "old"), 0o755)
	os.WriteFile(filepath.Join(old, "old", "c0"), make([]byte, 7), 0o644)
	n, err := WriteIndex(out)
	if err != nil {
		t.Fatal(err)
	}
	var idx []StaticReplay
	b, _ := os.ReadFile(filepath.Join(out, "index.json"))
	if err := json.Unmarshal(b, &idx); err != nil {
		t.Fatal(err)
	}
	if n != 2 || len(idx) != 2 || idx[0].File != "g" || idx[0].Size != int64(len(want)) ||
		idx[1].File != "old" || idx[1].Size != 22 {
		t.Errorf("index = %+v", idx)
	}
}

// The viewer's icon table is generated from icontypes.lua and committed; this
// keeps it current (and is how it is regenerated: run with -update).
func TestIconTypesJSONUpToDate(t *testing.T) {
	got, err := IconTypesJSON()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("bardata", "icons", "icontypes.json")
	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is stale: regenerate with go test ./internal/viz -run IconTypes -update", path)
	}
	var table map[string]struct {
		P string  `json:"p"`
		S float64 `json:"s"`
	}
	if err := json.Unmarshal(got, &table); err != nil {
		t.Fatal(err)
	}
	if table["armcom"].P != "icons/armcom.png" || table["armcom"].S < 1.5 ||
		table["armcom_scav"].P != "icons/inverted/armcom.png" || table["corllt"].P != "icons/defence_0_laser.png" {
		t.Errorf("armcom=%+v armcom_scav=%+v corllt=%+v", table["armcom"], table["armcom_scav"], table["corllt"])
	}
}

// viewerFixtureDir holds the .brp the worker's node tests decode with app.js's
// own functions, plus the economy Go decodes from it — the pin that keeps the
// JS economy decoder in lockstep with snapshot/brp.go.
var viewerFixtureDir = filepath.Join("..", "..", "worker", "tests", "fixtures")

// writeViewerFixture writes a capture exercising everything app.js derives
// from a .brp: two chunks, a team seen only in frames, every footprint rule,
// an armed mobile def, a human name, an icon resolved by iconType, players,
// events, comms and an economy with values that round both ways.
func writeViewerFixture(t *testing.T, dir string) string {
	t.Helper()
	w, err := snapshot.NewBRPWriter(dir, "viewer")
	if err != nil {
		t.Fatal(err)
	}
	meta := snapshot.Meta{
		GameID: "viewer", EngineVersion: "2025.06.24", GameVersion: "BAR test-1",
		MapName: "Test Map", SampleEvery: 30,
		UnitDefs: map[int32]snapshot.UnitDef{
			1: {DefID: 1, Name: "armcom", HumanName: "Armada Commander", CanMove: true, Speed: 37, WeaponCount: 3, MetalCost: 2700},
			2: {DefID: 2, Name: "corllt", HumanName: "corllt", XSize: 2, ZSize: 3, IsBuilding: true, WeaponCount: 1, MetalCost: 85},
			3: {DefID: 3, Name: "armnanotct3", XSize: 12, ZSize: 12, IsBuilder: true},
			4: {DefID: 4, Name: "armlab", XSize: 5, ZSize: 5, IsBuilding: true, CanMove: true},
			5: {DefID: 5, Name: "armpw", CanMove: true, Speed: 58, WeaponCount: 1, MetalCost: 46.4},
			6: {DefID: 6, Name: "made_up_unit_xyz", IconType: "armcom", CanMove: true},
		},
		Teams: []snapshot.TeamInfo{
			{TeamID: 0, AllyTeam: 0, Side: "armada", PlayerName: "alice", Color: "#ff0000"},
			{TeamID: 1, AllyTeam: 1, Side: "cortex", Color: "#0000ff"},
		},
		Players: []snapshot.PlayerInfo{
			{PlayerID: 0, Name: "alice", Team: 0, CountryCode: "PL", Rank: 3, Skill: 22.5},
			{PlayerID: 1, Name: "bob", Team: 1},
			{PlayerID: 2, Name: "spec", Team: 0, Spectator: true},
		},
	}
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}
	// 70 samples: two chunks (64 + 6), team 7 appearing only in frames, and
	// four samples skipped after the 50th — sampling is not always uniform,
	// so nothing may derive a sample's frame from its position.
	for i := 0; i < 70; i++ {
		f := int32(30 * (i + 1))
		if i >= 50 {
			f += 120
		}
		fr := snapshot.Frame{Frame: f, TimeSec: float32(f) / 30, Units: []snapshot.UnitState{
			{UnitID: 100, DefID: 1, Team: 0, Pos: snapshot.Vec3{X: float32(10 + i), Z: 20}, Health: 3000, MaxHealth: 3000, VelX: 1.0 / 30},
			{UnitID: 200, DefID: 2, Team: 1, Pos: snapshot.Vec3{X: -50, Z: 80}, Health: 400, MaxHealth: 800},
		}}
		if i >= 40 {
			fr.Units = append(fr.Units, snapshot.UnitState{UnitID: 300, DefID: 5, Team: 7, Pos: snapshot.Vec3{X: 500, Z: 600}, Health: 100, MaxHealth: 100})
		}
		if i%3 != 2 { // some frames carry no economy at all
			fr.Resources = []snapshot.TeamResource{
				{Team: 0, Metal: 1000.25 + float32(i), Energy: 500, MetalStorage: 1500, EnergyStorage: 6000, MetalIncome: 2.25, EnergyIncome: 105.5},
				{Team: 1, Metal: 900 - float32(i)*3.3, Energy: 400, MetalStorage: 1500, EnergyStorage: 6000, MetalIncome: 1.9, EnergyIncome: -3.5},
			}
		}
		if err := w.WriteFrame(fr); err != nil {
			t.Fatal(err)
		}
	}
	for _, e := range []snapshot.Event{
		{Frame: 45, Kind: snapshot.EventCreated, UnitID: 200, DefID: 2, Team: 1},
		{Frame: 1335, Kind: snapshot.EventCreated, UnitID: 300, DefID: 5, Team: 7},
	} {
		if err := w.WriteEvent(e); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []snapshot.Comm{
		{Frame: 33, Kind: snapshot.CommChat, PlayerID: 0, Dest: snapshot.DestAlly, Text: "push"},
		{Frame: 40, Kind: snapshot.CommPoint, PlayerID: 1, X: 500, Z: 600, Text: "here"},
	} {
		if err := w.WriteComm(c); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "viewer.brp")
}

// economyJSON is what the viewer's economy decoder must produce for a file:
// one record per sample, in order — its sim frame and [team, metal, energy,
// mStore, eStore, mInc, eInc, ...], each value rounded half away from zero,
// null for a sample that recorded no economy.
func economyJSON(t *testing.T, path string) []byte {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	bf, err := snapshot.ParseBRP(f)
	if err != nil {
		t.Fatal(err)
	}
	r := func(v float32) int64 { return int64(math.Round(float64(v))) }
	type rec struct {
		F int32   `json:"f"`
		R []int64 `json:"r"`
	}
	out := []rec{}
	for i := range bf.Chunks {
		frames, err := bf.DecodeChunk(i)
		if err != nil {
			t.Fatal(err)
		}
		for _, fr := range frames {
			e := rec{F: fr.Frame}
			for _, x := range fr.Resources {
				e.R = append(e.R, int64(x.Team), r(x.Metal), r(x.Energy), r(x.MetalStorage), r(x.EnergyStorage), r(x.MetalIncome), r(x.EnergyIncome))
			}
			out = append(out, e)
		}
	}
	b, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	return append(b, '\n')
}

// The committed viewer fixture must be what the writer produces today (the
// writer is deterministic), so the JS tests always exercise the current format.
func TestViewerFixtureUpToDate(t *testing.T) {
	path := writeViewerFixture(t, t.TempDir())
	brp, _ := os.ReadFile(path)
	econ := economyJSON(t, path)
	files := map[string][]byte{"viewer.brp": brp, "viewer.economy.json": econ}
	for name, got := range files {
		dst := filepath.Join(viewerFixtureDir, name)
		if *update {
			if err := os.MkdirAll(viewerFixtureDir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(dst, got, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		want, err := os.ReadFile(dst)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s is stale: regenerate with go test ./internal/viz -run ViewerFixture -update", dst)
		}
	}
}
