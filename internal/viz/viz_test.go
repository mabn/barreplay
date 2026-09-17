package viz

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// parseWire splits a BRW payload into tag->payload and decodes the head.
func parseWire(t *testing.T, payload []byte) (wireHead, map[byte][]byte) {
	t.Helper()
	version, sections, err := snapshot.ReadContainer(bytes.NewReader(payload), snapshot.BRWMagic)
	if err != nil {
		t.Fatal(err)
	}
	if version != snapshot.BRPVersion {
		t.Fatalf("wire version = %d, want %d", version, snapshot.BRPVersion)
	}
	secs := map[byte][]byte{}
	for _, s := range sections {
		secs[s.Tag] = s.Payload
	}
	gz, err := gzip.NewReader(bytes.NewReader(secs[snapshot.SecHead]))
	if err != nil {
		t.Fatal(err)
	}
	headJSON, err := io.ReadAll(gz)
	if err != nil {
		t.Fatal(err)
	}
	var head wireHead
	if err := json.Unmarshal(headJSON, &head); err != nil {
		t.Fatal(err)
	}
	return head, secs
}

// writeBRP writes a small two-frame capture to <dir>/<gameID>.brp.
func writeBRP(t *testing.T, dir, gameID string) string {
	t.Helper()
	w, err := snapshot.NewBRPWriter(dir, gameID)
	if err != nil {
		t.Fatal(err)
	}
	meta := snapshot.Meta{
		GameID:      gameID,
		MapName:     "Test Map",
		SampleEvery: 30,
		UnitDefs: map[int32]snapshot.UnitDef{
			1: {DefID: 1, Name: "armcom", HumanName: "Armada Commander", CanMove: true},        // mobile: no footprint
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
			{UnitID: 100, DefID: 1, Team: 0, Pos: snapshot.Vec3{X: 10, Y: 0, Z: 20}, Health: 3000, MaxHealth: 3000, VelX: 2, VelZ: -1},
			{UnitID: 200, DefID: 2, Team: 1, Pos: snapshot.Vec3{X: -50, Y: 0, Z: 80}, Health: 400, MaxHealth: 800},
		}},
		{Frame: 60, TimeSec: 2, Units: []snapshot.UnitState{
			{UnitID: 100, DefID: 1, Team: 0, Pos: snapshot.Vec3{X: 12, Y: 0, Z: 22}, Health: 3000, MaxHealth: 3000},
			{UnitID: 300, DefID: 1, Team: 7, Pos: snapshot.Vec3{X: 500, Y: 0, Z: 600}, Health: 100, MaxHealth: 100}, // team 7 not in Meta.Teams
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
	return filepath.Join(dir, gameID+".brp")
}

// The head payload must carry everything the viewer needs before any frame
// data arrives: bounds, the full team roster (including teams only seen in
// frames), footprints, and the chunk index. The E and C sections ride along
// byte-for-byte from the stored file, and no frame data does.
func TestWirePayload(t *testing.T) {
	dir := t.TempDir()
	path := writeBRP(t, dir, "g")

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	bf, err := snapshot.ParseBRP(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := brpWirePayload(bf)
	if err != nil {
		t.Fatal(err)
	}
	head, secs := parseWire(t, payload)

	// Head basics.
	if head.GameID != "g" || head.MapName != "Test Map" || head.SampleEvery != 30 {
		t.Errorf("head = %+v", head)
	}
	if head.UnitDefs[1] != "armcom" {
		t.Errorf("unitDefs = %+v", head.UnitDefs)
	}
	// Human names ride alongside the internal ones (the viewer labels units with
	// them); a def whose capture recorded none is simply absent, so the front-end
	// falls back to the internal name.
	if head.UnitNames[1] != "Armada Commander" {
		t.Errorf("unitNames[1] = %q, want %q", head.UnitNames[1], "Armada Commander")
	}
	if _, ok := head.UnitNames[2]; ok {
		t.Errorf("unitNames = %+v, want no entry for a def with no human name", head.UnitNames)
	}
	// Bounds cover both frames' units: x in [-50, 500], z in [20, 600].
	if head.Bounds.MinX != -50 || head.Bounds.MaxX != 500 || head.Bounds.MinZ != 20 || head.Bounds.MaxZ != 600 {
		t.Errorf("bounds = %+v", head.Bounds)
	}
	// Team 7 appears only in a frame; the head must still list it.
	found := false
	for _, tm := range head.Teams {
		if tm.TeamID == 7 {
			found = true
		}
	}
	if len(head.Teams) != 3 || !found {
		t.Errorf("teams = %+v", head.Teams)
	}

	// Footprints: immobile units are included, in elmos (xsize/zsize * 8).
	if fp, ok := head.Footprints["corllt"]; !ok || fp.W != 16 || fp.H != 24 {
		t.Errorf("corllt footprint = %+v (ok=%v), want {W:16 H:24}", fp, ok)
	}
	// An immobile builder (nano turret) is not IsBuilding but still gets a footprint.
	if fp, ok := head.Footprints["armnanotct3"]; !ok || fp.W != 96 || fp.H != 96 {
		t.Errorf("armnanotct3 footprint = %+v (ok=%v), want {W:96 H:96}", fp, ok)
	}
	// A factory reports CanMove but is IsBuilding, so it gets a footprint.
	if fp, ok := head.Footprints["armlab"]; !ok || fp.W != 40 || fp.H != 40 {
		t.Errorf("armlab footprint = %+v (ok=%v), want {W:40 H:40}", fp, ok)
	}
	if _, ok := head.Footprints["armcom"]; ok {
		t.Errorf("armcom is mobile; should have no footprint")
	}

	// Chunk index mirrors the file's: kLen is the keyframe's RAW length in the
	// decompressed keys stream, len the delta bytes.
	if head.FrameCount != 2 || len(head.Chunks) != 1 {
		t.Fatalf("frameCount=%d chunks=%+v", head.FrameCount, head.Chunks)
	}
	if head.Chunks[0].Frame != 30 || head.Chunks[0].Count != 2 ||
		head.Chunks[0].KLen != bf.Chunks[0].KLen || head.Chunks[0].Len != bf.Chunks[0].FLen {
		t.Errorf("wire chunk = %+v, file chunk = %+v", head.Chunks[0], bf.Chunks[0])
	}

	// E and C sections pass through byte-for-byte; no frame data in the head
	// payload.
	if !bytes.Equal(secs[snapshot.SecEvents], bf.Sections[snapshot.SecEvents]) {
		t.Errorf("wire E section is not the stored one")
	}
	if len(bf.Sections[snapshot.SecComms]) == 0 {
		t.Fatal("stored file has no comms section")
	}
	if !bytes.Equal(secs[snapshot.SecComms], bf.Sections[snapshot.SecComms]) {
		t.Errorf("wire C section is not the stored one")
	}
	if _, ok := secs[snapshot.SecFrames]; ok {
		t.Errorf("head payload must not contain a frames section")
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

func TestHeadIncludesIcons(t *testing.T) {
	meta := snapshot.Meta{
		GameID: "g",
		UnitDefs: map[int32]snapshot.UnitDef{
			1: {DefID: 1, Name: "armcom"},
			2: {DefID: 2, Name: "corllt"},
		},
	}
	head := buildHead(meta, defaultBounds(), nil)
	if head.UnitIcons["armcom"].Path != "icons/armcom.png" || head.UnitIcons["armcom"].Size <= 0 {
		t.Errorf("armcom icon=%+v", head.UnitIcons["armcom"])
	}
	if head.UnitIcons["corllt"].Path != "icons/defence_0_laser.png" {
		t.Errorf("corllt icon=%+v", head.UnitIcons["corllt"])
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

// The head resolves an icon by IconType even when the unit's name is not an
// icontype key.
func TestHeadIconByType(t *testing.T) {
	meta := snapshot.Meta{
		GameID: "g",
		UnitDefs: map[int32]snapshot.UnitDef{
			1: {DefID: 1, Name: "made_up_unit_xyz", IconType: "armcom"},
		},
	}
	head := buildHead(meta, defaultBounds(), nil)
	if head.UnitIcons["made_up_unit_xyz"].Path != "icons/armcom.png" {
		t.Errorf("icon-by-type = %+v, want icons/armcom.png", head.UnitIcons["made_up_unit_xyz"])
	}
}

// The head must carry the player roster, and brpResourcesJSON must return
// each sampled frame's per-team economy (the .brp X stream, which the frame
// chunk path never fetches) so the sidebar player list can draw its bars.
func TestPlayersAndResources(t *testing.T) {
	dir := t.TempDir()
	w, err := snapshot.NewBRPWriter(dir, "g")
	if err != nil {
		t.Fatal(err)
	}
	meta := snapshot.Meta{
		GameID: "g", SampleEvery: 30,
		Teams: []snapshot.TeamInfo{{TeamID: 0, AllyTeam: 0}, {TeamID: 1, AllyTeam: 1}},
		Players: []snapshot.PlayerInfo{
			{PlayerID: 0, Name: "Alice", Team: 0, CountryCode: "us", Rank: 5, Skill: 31.2},
			{PlayerID: 2, Name: "Watcher", Team: 0, Spectator: true},
		},
	}
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}
	if err := w.WriteFrame(snapshot.Frame{
		Frame: 30, TimeSec: 1,
		Units: []snapshot.UnitState{{UnitID: 1, DefID: 1, Team: 0, Health: 1, MaxHealth: 1}},
		Resources: []snapshot.TeamResource{
			{Team: 0, Metal: 314, Energy: 14700, MetalStorage: 1000, EnergyStorage: 20000, MetalIncome: 12.5, EnergyIncome: 850},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	f, err := os.Open(filepath.Join(dir, "g.brp"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	bf, err := snapshot.ParseBRP(f)
	if err != nil {
		t.Fatal(err)
	}

	// Players ride the head payload.
	head := buildHead(bf.Meta, defaultBounds(), bf.FrameTeams)
	if len(head.Players) != 2 {
		t.Fatalf("players: got %d want 2 (%+v)", len(head.Players), head.Players)
	}
	if p := head.Players[0]; p.Name != "Alice" || p.Country != "us" || p.Rank != 5 || p.Skill != 31.2 {
		t.Errorf("player0=%+v", p)
	}
	if !head.Players[1].Spectator {
		t.Errorf("player1 should be a spectator: %+v", head.Players[1])
	}

	// Resources body: a JSON array, one {f, r} per sampled frame.
	raw, err := brpResourcesJSON(bf)
	if err != nil {
		t.Fatal(err)
	}
	var arr []wireResFrame
	if err := json.Unmarshal(raw, &arr); err != nil {
		t.Fatal(err)
	}
	if len(arr) != 1 || arr[0].F != 30 {
		t.Fatalf("resource frames = %+v", arr)
	}
	// [team, metal, energy, mStore, eStore, mInc, eInc]; income 12.5 -> 13 (rounded
	// from the format's 1/10 quantization).
	want := []int32{0, 314, 14700, 1000, 20000, 13, 850}
	if len(arr[0].R) != resourceStride {
		t.Fatalf("R len=%d want %d (%v)", len(arr[0].R), resourceStride, arr[0].R)
	}
	for i, v := range want {
		if arr[0].R[i] != v {
			t.Errorf("R[%d]=%d want %d (full=%v)", i, arr[0].R[i], v, arr[0].R)
		}
	}
}

// BuildCatalogEntry is the row the packer PUTs into the worker's catalog, so
// it must produce the Durable Object table's shape (nullable stats, a null
// start time for a capture without one) from each .brp's meta record.
func TestCatalog(t *testing.T) {
	dir := t.TempDir()
	writeBRP(t, dir, "nostart") // StartUnix 0 -> null start, sorts last

	// A second capture WITH a start time and a 2v1 roster, sampled to frame 90.
	w, err := snapshot.NewBRPWriter(dir, "recent")
	if err != nil {
		t.Fatal(err)
	}
	if err := w.WriteMeta(snapshot.Meta{
		GameID:      "recent",
		MapName:     "Hooked 1.1.1",
		StartUnix:   1_752_000_000,
		SampleEvery: 30,
		UnitDefs:    map[int32]snapshot.UnitDef{1: {DefID: 1, Name: "armcom"}},
		Teams: []snapshot.TeamInfo{
			{TeamID: 0, AllyTeam: 0, Side: "armada"},
			{TeamID: 1, AllyTeam: 0, Side: "cortex"},
			{TeamID: 2, AllyTeam: 1, Side: "armada"},
			{TeamID: 3, AllyTeam: 2}, // Gaia: no side, no player -> not a playing slot
		},
		Players: []snapshot.PlayerInfo{
			{PlayerID: 0, Name: "low", Team: 0, Skill: 12.5},
			{PlayerID: 1, Name: "high", Team: 1, Skill: 30},
			{PlayerID: 2, Name: "solo", Team: 2, Skill: 20},
			{PlayerID: 3, Name: "watcher", Team: 0, Spectator: true},
		},
		Recorder: &snapshot.RecorderInfo{PlayerID: 2, AllyTeam: 1},
		Widget:   &snapshot.WidgetInfo{Version: "1.7.0", Sha: widgetSHA, Date: "2026-08-16"},
	}); err != nil {
		t.Fatal(err)
	}
	for _, fr := range []int32{30, 60, 90} {
		u := []snapshot.UnitState{{UnitID: 1, DefID: 1, Team: 0, Pos: snapshot.Vec3{X: 1}, Health: 1, MaxHealth: 1}}
		if err := w.WriteFrame(snapshot.Frame{Frame: fr, TimeSec: float32(fr) / 30, Units: u}); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	entry := func(id string) CatalogEntry {
		t.Helper()
		path := filepath.Join(dir, id+".brp")
		f, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		bf, err := snapshot.ParseBRP(f)
		if err != nil {
			t.Fatal(err)
		}
		fi, err := f.Stat()
		if err != nil {
			t.Fatal(err)
		}
		return BuildCatalogEntry(id, bf, fi.Size())
	}

	r := entry("recent")
	if r.ID != "recent" {
		t.Errorf("recent id = %q", r.ID)
	}
	if r.StartUnix == nil || *r.StartUnix != 1_752_000_000 {
		t.Errorf("recent startUnix = %v", r.StartUnix)
	}
	if r.Map == nil || *r.Map != "Hooked 1.1.1" {
		t.Errorf("recent map = %v", r.Map)
	}
	if r.GameSize == nil || *r.GameSize != "2v1" {
		t.Errorf("recent gameSize = %v", r.GameSize)
	}
	if r.DurationSec == nil || *r.DurationSec != 3 { // last frame 90 / 30 fps
		t.Errorf("recent durationSec = %v", r.DurationSec)
	}
	if r.SizeBytes == nil || *r.SizeBytes <= 0 {
		t.Errorf("recent sizeBytes = %v", r.SizeBytes)
	}
	// Players: per ally team, best OS first, spectators excluded.
	if len(r.Players) != 2 ||
		r.Players[0].Ally != 0 || r.Players[0].Count != 2 ||
		len(r.Players[0].Players) != 2 || r.Players[0].Players[0].Name != "high" || r.Players[0].Players[1].Name != "low" ||
		r.Players[1].Ally != 1 || r.Players[1].Count != 1 || len(r.Players[1].Players) != 1 || r.Players[1].Players[0].Name != "solo" {
		t.Errorf("recent players = %+v", r.Players)
	}
	if r.UploaderAlly == nil || *r.UploaderAlly != 1 {
		t.Errorf("recent uploaderAlly = %v, want 1", r.UploaderAlly)
	}
	// The widget build that recorded the capture, carried from the stream's
	// GAME line through Meta into the row the catalog stores.
	if r.WidgetVersion == nil || *r.WidgetVersion != "1.7.0" ||
		r.WidgetSha == nil || *r.WidgetSha != widgetSHA ||
		r.WidgetDate == nil || *r.WidgetDate != "2026-08-16" {
		t.Errorf("recent widget = %v/%v/%v", str(r.WidgetVersion), str(r.WidgetSha), str(r.WidgetDate))
	}

	n := entry("nostart")
	if n.StartUnix != nil {
		t.Errorf("nostart startUnix = %v, want null", *n.StartUnix)
	}
	if n.GameSize == nil || *n.GameSize != "1v1" {
		t.Errorf("nostart gameSize = %v", n.GameSize)
	}
	if n.DurationSec == nil || *n.DurationSec != 2 { // last frame 60 / 30 fps
		t.Errorf("nostart durationSec = %v", n.DurationSec)
	}
	// A capture whose stream named no widget must send nothing rather than
	// empty strings: the worker's upsert COALESCEs these columns, so a blank
	// would overwrite a known build with one that never existed.
	if n.WidgetVersion != nil || n.WidgetSha != nil || n.WidgetDate != nil {
		t.Errorf("nostart widget = %v/%v/%v, want all nil", str(n.WidgetVersion), str(n.WidgetSha), str(n.WidgetDate))
	}
}

// widgetSHA is a plausible git SHA for the catalog's widget-provenance fields.
const widgetSHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736"

// str renders a nullable catalog string for a failure message.
func str(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

// The chevron rank rides the catalog roster next to the OS, and its whole
// difficulty is that 0 is a real level (an account with under five hours)
// while the .brp meta cannot tell a recorded 0 from a field it never wrote.
// So a player the startscript named reports their rank even when it is 0, and
// a player known only from the widget's own P line reports nothing at all.
func TestCatalogPlayerRank(t *testing.T) {
	teams := []snapshot.TeamInfo{{TeamID: 0, AllyTeam: 0}}
	groups := catalogPlayers(snapshot.Meta{
		Teams: teams,
		Players: []snapshot.PlayerInfo{
			{PlayerID: 0, Name: "veteran", Team: 0, Skill: 30, Rank: 5, AccountID: "1"},
			{PlayerID: 1, Name: "newcomer", Team: 0, Skill: 16.67, Rank: 0, AccountID: "2"},
			{PlayerID: 2, Name: "unrated", Team: 0, Rank: 3},
			{PlayerID: 3, Name: "widgetonly", Team: 0},
		},
	})
	if len(groups) != 1 {
		t.Fatalf("groups = %d, want 1", len(groups))
	}
	want := map[string]string{
		"veteran":    "5",
		"newcomer":   "0", // a level, not a silence
		"unrated":    "3", // a rank alone still proves the startscript
		"widgetonly": "<nil>",
	}
	for _, p := range groups[0].Players {
		got := "<nil>"
		if p.Rank != nil {
			got = strconv.Itoa(int(*p.Rank))
		}
		if got != want[p.Name] {
			t.Errorf("%s rank = %s, want %s", p.Name, got, want[p.Name])
		}
	}
}

func TestGameSizeSpec(t *testing.T) {
	cases := []struct {
		allies []int32
		gaia   bool // append a Gaia-like team (no side, no player) in its own ally team
		want   string
	}{
		{nil, false, ""},
		{[]int32{0, 1}, false, "1v1"},
		{[]int32{0, 0, 1, 1, 1}, false, "3v2"},
		{[]int32{0, 1, 2}, false, "1v1v1"},
		// The engine's neutral Gaia team must never surface as an extra "v1".
		{[]int32{0, 1}, true, "1v1"},
		{[]int32{0, 0, 1, 1, 1}, true, "3v2"},
		{nil, true, ""},
	}
	for _, c := range cases {
		teams := make([]snapshot.TeamInfo, len(c.allies))
		for i, a := range c.allies {
			teams[i] = snapshot.TeamInfo{TeamID: int32(i), AllyTeam: a, Side: "armada"}
		}
		if c.gaia {
			teams = append(teams, snapshot.TeamInfo{TeamID: int32(len(teams)), AllyTeam: 99})
		}
		if got := GameSizeSpec(teams); got != c.want {
			t.Errorf("GameSizeSpec(%v, gaia=%v) = %q, want %q", c.allies, c.gaia, got, c.want)
		}
	}
}

// SettingsFlags emits only true / non-default values — a fully-default
// modoptions bag (or nil) yields nil, and each tracked option maps to its
// catalog key.
func TestSettingsFlags(t *testing.T) {
	if got := SettingsFlags(nil); got != nil {
		t.Errorf("SettingsFlags(nil) = %v, want nil", got)
	}
	defaults := map[string]string{
		"map_waterislava": "0", "scavunitsforplayers": "0",
		"experimentalextraunits": "0", "unit_restrictions_nonukes": "0",
		"unit_restrictions_noendgamelrpc": "0", "unit_restrictions_nolrpc": "0",
		"unit_restrictions_noair": "0", "quick_start": "default",
		"commanderbuildersenabled": "disabled",
		"zombies":                  "disabled", "ruins": "scav_only",
		"tweakdefs": "", "tweakdefs1": "", "tweakunits": "", "tweakunits9": "",
	}
	if got := SettingsFlags(defaults); got != nil {
		t.Errorf("all-default modoptions = %v, want nil", got)
	}

	cases := []struct {
		mo   map[string]string
		key  string
		want any
	}{
		{map[string]string{"ranked_game": "1"}, "ranked", true},
		{map[string]string{"map_waterislava": "1"}, "lava", true},
		{map[string]string{"scavunitsforplayers": "1"}, "scavUnits", true},
		{map[string]string{"experimentalextraunits": "1"}, "extraUnits", true},
		{map[string]string{"unit_restrictions_nonukes": "1"}, "noNukes", true},
		{map[string]string{"unit_restrictions_noendgamelrpc": "1"}, "noEndgameLrpc", true},
		{map[string]string{"unit_restrictions_nolrpc": "1"}, "noLrpc", true},
		{map[string]string{"unit_restrictions_noair": "1"}, "noAir", true},
		{map[string]string{"tweakdefs": "Zm9v"}, "mods", true},
		{map[string]string{"tweakdefs7": "Zm9v"}, "mods", true},
		{map[string]string{"tweakunits": "Zm9v"}, "mods", true},
		{map[string]string{"tweakunits3": "Zm9v"}, "mods", true},
		{map[string]string{"quick_start": "enabled"}, "quickStart", "enabled"},
		{map[string]string{"commanderbuildersenabled": "enabled_all"}, "comBuilders", "enabled_all"},
		// An explicitly unranked lobby is the one "off" worth a badge.
		{map[string]string{"ranked_game": "0"}, "unranked", true},
		// zombies: "normal" is the plain on-state, harder tiers keep the name.
		{map[string]string{"zombies": "normal"}, "zombies", true},
		{map[string]string{"zombies": "nightmare"}, "zombies", "nightmare"},
		// ruins: "scav_only" is the lobby default, only "enabled" is notable.
		{map[string]string{"ruins": "enabled"}, "ruins", true},
	}
	for _, c := range cases {
		got := SettingsFlags(c.mo)
		if len(got) != 1 || got[c.key] != c.want {
			t.Errorf("SettingsFlags(%v) = %v, want {%s: %v}", c.mo, got, c.key, c.want)
		}
	}

	// Combination: several flags at once, defaults still silent.
	got := SettingsFlags(map[string]string{
		"ranked_game": "1", "map_waterislava": "1", "tweakunits2": "x",
		"quick_start": "disabled", "commanderbuildersenabled": "disabled",
	})
	want := map[string]any{"ranked": true, "lava": true, "mods": true}
	if len(got) != len(want) || got["ranked"] != true || got["lava"] != true || got["mods"] != true {
		t.Errorf("combined = %v, want %v", got, want)
	}
}
