package viz

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// writeJSONL writes a small capture to <dir>/<gameID>.jsonl and returns its path.
func writeJSONL(t *testing.T, dir, gameID string) string {
	t.Helper()
	w, err := snapshot.NewJSONLWriter(dir, gameID)
	if err != nil {
		t.Fatal(err)
	}
	meta := snapshot.Meta{
		GameID:      gameID,
		MapName:     "Test Map",
		SampleEvery: 30,
		UnitDefs: map[int32]snapshot.UnitDef{
			1: {DefID: 1, Name: "armcom", CanMove: true},                                       // mobile: no footprint
			2: {DefID: 2, Name: "corllt", XSize: 2, ZSize: 3, IsBuilding: true},                // building: 16x24 elmos
			3: {DefID: 3, Name: "armnanotct3", XSize: 12, ZSize: 12, IsBuilder: true},          // immobile builder (nano turret): footprint despite not IsBuilding
			4: {DefID: 4, Name: "armlab", XSize: 5, ZSize: 5, IsBuilding: true, CanMove: true}, // factory: reports CanMove but IsBuilding -> footprint
		},
		Teams: []snapshot.TeamInfo{
			{TeamID: 0, AllyTeam: 0, Side: "armada"},
			{TeamID: 1, AllyTeam: 1, Side: "cortex"},
		},
	}
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}
	frames := []snapshot.Frame{
		{Frame: 30, TimeSec: 1, Units: []snapshot.UnitState{
			{UnitID: 100, DefID: 1, Team: 0, Pos: snapshot.Vec3{X: 10, Y: 0, Z: 20}, Health: 3000, MaxHealth: 3000},
			{UnitID: 200, DefID: 2, Team: 1, Pos: snapshot.Vec3{X: -50, Y: 0, Z: 80}, Health: 400, MaxHealth: 800},
		}},
		{Frame: 60, TimeSec: 2, Units: []snapshot.UnitState{
			{UnitID: 100, DefID: 1, Team: 0, Pos: snapshot.Vec3{X: 12, Y: 0, Z: 22}, Health: 3000, MaxHealth: 3000},
		}},
	}
	for _, f := range frames {
		if err := w.WriteFrame(f); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.WriteEvent(snapshot.Event{Frame: 45, Kind: snapshot.EventDestroyed, UnitID: 200, DefID: 2, Team: 1}); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, gameID+".jsonl")
}

func TestLoadJSONL(t *testing.T) {
	dir := t.TempDir()
	path := writeJSONL(t, dir, "game123")

	rep, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Meta.GameID != "game123" || rep.Meta.MapName != "Test Map" {
		t.Errorf("meta not loaded: %+v", rep.Meta)
	}
	if len(rep.Frames) != 2 {
		t.Fatalf("got %d frames, want 2", len(rep.Frames))
	}
	if len(rep.Events) != 1 || rep.Events[0].Kind != snapshot.EventDestroyed {
		t.Fatalf("events not loaded: %+v", rep.Events)
	}
	if rep.Meta.UnitDefs[1].Name != "armcom" {
		t.Errorf("unitDefs not loaded: %+v", rep.Meta.UnitDefs)
	}
}

func TestToWirePacking(t *testing.T) {
	dir := t.TempDir()
	path := writeJSONL(t, dir, "g")
	rep, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	w := rep.toWire()

	if len(w.Frames) != 2 {
		t.Fatalf("frames: got %d want 2", len(w.Frames))
	}
	f0 := w.Frames[0]
	if f0.N != 2 || len(f0.U) != 2*unitStride {
		t.Fatalf("frame0: N=%d len(U)=%d want N=2 len=%d", f0.N, len(f0.U), 2*unitStride)
	}
	// First unit: id=100, def=1, team=0, x=10, z=20, hp=3000, maxHp=3000.
	want := []int32{100, 1, 0, 10, 20, 3000, 3000}
	for i, v := range want {
		if f0.U[i] != v {
			t.Errorf("U[%d]=%d want %d (full=%v)", i, f0.U[i], v, f0.U[:unitStride])
		}
	}
	// Bounds must cover both frames' units (x in [-50,12], z in [20,80]).
	if w.Bounds.MinX != -50 || w.Bounds.MaxX != 12 || w.Bounds.MinZ != 20 || w.Bounds.MaxZ != 80 {
		t.Errorf("bounds=%+v", w.Bounds)
	}
	if len(w.Teams) != 2 || w.Teams[0].Side != "armada" {
		t.Errorf("teams=%+v", w.Teams)
	}

	// Footprints: immobile units are included, in elmos (xsize/zsize * 8).
	if fp, ok := w.Footprints["corllt"]; !ok || fp.W != 16 || fp.H != 24 {
		t.Errorf("corllt footprint = %+v (ok=%v), want {W:16 H:24}", fp, ok)
	}
	// An immobile builder (nano turret) is not IsBuilding but still gets a footprint.
	if fp, ok := w.Footprints["armnanotct3"]; !ok || fp.W != 96 || fp.H != 96 {
		t.Errorf("armnanotct3 footprint = %+v (ok=%v), want {W:96 H:96}", fp, ok)
	}
	// A factory reports CanMove but is IsBuilding, so it gets a footprint.
	if fp, ok := w.Footprints["armlab"]; !ok || fp.W != 40 || fp.H != 40 {
		t.Errorf("armlab footprint = %+v (ok=%v), want {W:40 H:40}", fp, ok)
	}
	if _, ok := w.Footprints["armcom"]; ok {
		t.Errorf("armcom is mobile; should have no footprint, got %+v", w.Footprints["armcom"])
	}
}

func TestLoadBRSNAP(t *testing.T) {
	// A minimal raw widget stream, as internal/capture parses it.
	stream := strings.Join([]string{
		"BRSNAP D 1 armcom",
		"BRSNAP D 2 corllt",
		"BRSNAP T 0 0 armada",
		"BRSNAP T 1 1 cortex",
		"BRSNAP READY",
		"BRSNAP F 30 1.0 2",
		"BRSNAP U 100 1 0 10 5 20 3000 3000",
		"BRSNAP U 200 2 1 -50 5 80 400 800",
		"BRSNAP EV 45 destroyed 200 2 1",
		"",
	}, "\n")

	rep, err := loadBRSNAP(strings.NewReader(stream), "raw-game")
	if err != nil {
		t.Fatal(err)
	}
	if rep.Meta.GameID != "raw-game" {
		t.Errorf("gameID=%q", rep.Meta.GameID)
	}
	if rep.Meta.UnitDefs[1].Name != "armcom" || rep.Meta.UnitDefs[2].Name != "corllt" {
		t.Errorf("unitDefs=%+v", rep.Meta.UnitDefs)
	}
	if len(rep.Frames) != 1 || len(rep.Frames[0].Units) != 2 {
		t.Fatalf("frames=%+v", rep.Frames)
	}
	if len(rep.Events) != 1 || rep.Events[0].Kind != snapshot.EventDestroyed {
		t.Errorf("events=%+v", rep.Events)
	}
}

func TestUnitIcons(t *testing.T) {
	// Well-known BAR units should resolve to an icon that exists in the embedded
	// FS. defence_0_laser is shared by arm/cor light laser towers.
	cases := map[string]string{
		"armcom": "icons/armcom.png",
		"armllt": "icons/defence_0_laser.png",
		"corllt": "icons/defence_0_laser.png",
		"armmex": "icons/mex_t1.png",
	}
	for name, want := range cases {
		got, size, ok := unitIcon(name)
		if !ok || got != want {
			t.Errorf("unitIcon(%q)=(%q,%v,%v) want path %q", name, got, size, ok, want)
		}
		if size <= 0 {
			t.Errorf("unitIcon(%q) size=%v, want > 0", name, size)
		}
	}
	// The commander icon is meaningfully larger than a mex icon (per-type size).
	if _, comSize, _ := unitIcon("armcom"); comSize < 1.5 {
		t.Errorf("armcom size=%v, want ~1.8", comSize)
	}
	if _, _, ok := unitIcon("not_a_real_unit"); ok {
		t.Errorf("unitIcon(unknown) ok=true, want false")
	}
	// Scavenger variant should resolve to the inverted path.
	if got, _, ok := unitIcon("armcom_scav"); !ok || got != "icons/inverted/armcom.png" {
		t.Errorf("unitIcon(armcom_scav)=(%q,%v) want icons/inverted/armcom.png", got, ok)
	}
}

func TestToWireIncludesIcons(t *testing.T) {
	dir := t.TempDir()
	path := writeJSONL(t, dir, "g")
	rep, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	// The fixture's UnitDefs include armcom and corllt; both have icons.
	w := rep.toWire()
	if w.UnitIcons["armcom"].Path != "icons/armcom.png" || w.UnitIcons["armcom"].Size <= 0 {
		t.Errorf("armcom icon=%+v", w.UnitIcons["armcom"])
	}
	if w.UnitIcons["corllt"].Path != "icons/defence_0_laser.png" {
		t.Errorf("corllt icon=%+v", w.UnitIcons["corllt"])
	}
}

func TestUnitIconFor(t *testing.T) {
	// A def whose name is not itself an icontype key still gets an icon via its
	// IconType (the authoritative key), fixing the missing-icon case.
	if got, _, ok := unitIconFor("armcom", "made_up_unit_xyz"); !ok || got != "icons/armcom.png" {
		t.Errorf("unitIconFor(armcom, made_up)=(%q,%v) want icons/armcom.png", got, ok)
	}
	// Empty IconType falls back to the name lookup (old captures / name==key).
	if got, _, ok := unitIconFor("", "armcom"); !ok || got != "icons/armcom.png" {
		t.Errorf("unitIconFor(\"\", armcom)=(%q,%v) want icons/armcom.png", got, ok)
	}
	// An unknown IconType falls back to the name.
	if got, _, ok := unitIconFor("no_such_type", "corllt"); !ok || got != "icons/defence_0_laser.png" {
		t.Errorf("unitIconFor(bad, corllt)=(%q,%v) want icons/defence_0_laser.png", got, ok)
	}
	// Neither resolves -> not ok.
	if _, _, ok := unitIconFor("no_such_type", "no_such_unit"); ok {
		t.Errorf("unitIconFor(bad,bad) ok=true, want false")
	}
}

// toWire resolves an icon by IconType even when the unit's name is not an
// icontype key.
func TestToWireIconByType(t *testing.T) {
	rep := &Replay{Meta: snapshot.Meta{
		GameID: "g",
		UnitDefs: map[int32]snapshot.UnitDef{
			1: {DefID: 1, Name: "made_up_unit_xyz", IconType: "armcom"},
		},
	}}
	w := rep.toWire()
	if w.UnitIcons["made_up_unit_xyz"].Path != "icons/armcom.png" {
		t.Errorf("icon-by-type = %+v, want icons/armcom.png", w.UnitIcons["made_up_unit_xyz"])
	}
}

func TestNormalizeMapName(t *testing.T) {
	if got := normalizeMapName("Supreme Isthmus v2.1"); got != "supreme_isthmus_v2.1" {
		t.Errorf("normalizeMapName = %q", got)
	}
	if got := normalizeMapName("  All That Glitters  "); got != "all_that_glitters" {
		t.Errorf("normalizeMapName trims/lowers wrong: %q", got)
	}
}

func TestMapForName(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/maps/supreme_isthmus_v2.1":
			w.Write([]byte(`{"fileName":"supreme_isthmus_v2.1","width":24,"height":24}`))
		case "/maps/supreme_isthmus_v2.1/texture-mq.jpg":
			w.Header().Set("Content-Type", "image/jpeg")
			w.Write([]byte("JPEGDATA"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	oldBase := mapAPIBase
	mapAPIBase = srv.URL
	defer func() { mapAPIBase = oldBase }()
	mapMu.Lock()
	mapCache = map[string]*mapEntry{}
	mapMu.Unlock()

	e := mapForName("Supreme Isthmus v2.1")
	// 24 map units * 512 = 12288 elmos.
	if e.info.Width != 12288 || e.info.Height != 12288 {
		t.Errorf("dims = %dx%d, want 12288x12288", e.info.Width, e.info.Height)
	}
	if !e.info.Texture || string(e.texture) != "JPEGDATA" {
		t.Errorf("texture not fetched: %+v", e.info)
	}

	// A map the mock doesn't know: no dims, no texture, but no error.
	miss := mapForName("Nonexistent Map")
	if miss.info.Texture || miss.info.Width != 0 {
		t.Errorf("unknown map should be empty: %+v", miss.info)
	}
}

func TestListConfinesFiles(t *testing.T) {
	dir := t.TempDir()
	writeJSONL(t, dir, "a")
	writeJSONL(t, dir, "b")
	s := &Server{Dir: dir}
	infos, err := s.list()
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 2 {
		t.Fatalf("got %d infos want 2: %+v", len(infos), infos)
	}
	if infos[0].Format != "jsonl" {
		t.Errorf("format=%q", infos[0].Format)
	}
}
