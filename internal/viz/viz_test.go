package viz

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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
// frames), footprints, and the chunk index. The E section and every chunk
// must be served byte-for-byte from the stored file.
func TestServeBRP(t *testing.T) {
	dir := t.TempDir()
	path := writeBRP(t, dir, "g")

	srv := httptest.NewServer((&Server{Dir: dir}).Handler())
	defer srv.Close()

	get := func(url string) ([]byte, *http.Response) {
		t.Helper()
		resp, err := http.Get(srv.URL + url)
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s: status %d: %s", url, resp.StatusCode, b)
		}
		return b, resp
	}

	payload, resp := get("/replays/g.brw")
	if resp.Header.Get("ETag") == "" {
		t.Error("no ETag on head payload")
	}
	head, secs := parseWire(t, payload)

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	bf, err := snapshot.ParseBRP(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}

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
		t.Errorf("served E section is not the stored one")
	}
	if len(bf.Sections[snapshot.SecComms]) == 0 {
		t.Fatal("stored file has no comms section")
	}
	if !bytes.Equal(secs[snapshot.SecComms], bf.Sections[snapshot.SecComms]) {
		t.Errorf("served C section is not the stored one")
	}
	if _, ok := secs[snapshot.SecFrames]; ok {
		t.Errorf("head payload must not contain a frames section")
	}

	// Chunk endpoint serves the stored delta byte range; the keys endpoint the
	// stored K section — both byte-for-byte.
	c := bf.Chunks[0]
	fsec := bf.Sections[snapshot.SecFrames]
	full, _ := get("/replays/g/c0")
	if !bytes.Equal(full, fsec[c.FOff:c.FOff+c.FLen]) {
		t.Errorf("chunk 0 is not the stored byte range")
	}
	keys, _ := get("/replays/g.keys")
	if !bytes.Equal(keys, bf.Sections[snapshot.SecKeyframes]) {
		t.Errorf("keys is not the stored K section")
	}

	// Out-of-range chunk and bad ids are rejected.
	if resp, err := http.Get(srv.URL + "/replays/g/c9"); err != nil || resp.StatusCode != http.StatusBadRequest {
		t.Errorf("chunk c9: %v %v", resp.StatusCode, err)
	} else {
		resp.Body.Close()
	}
	if resp, err := http.Get(srv.URL + "/replays/..%2Fg.brw"); err != nil || resp.StatusCode == http.StatusOK {
		t.Errorf("traversal name served: %v %v", resp.StatusCode, err)
	} else {
		resp.Body.Close()
	}

	// ETag revalidation: a matching If-None-Match yields 304 with no body.
	req, _ := http.NewRequest("GET", srv.URL+"/replays/g/c0", nil)
	req.Header.Set("If-None-Match", resp.Header.Get("ETag"))
	r304, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r304.Body.Close()
	if r304.StatusCode != http.StatusNotModified {
		t.Errorf("revalidation status = %d, want 304", r304.StatusCode)
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

// The head must carry the player roster, and brpResourcesPayload must return
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

	// Resources payload: gzipped JSON, one {f, r} per sampled frame.
	gz, err := brpResourcesPayload(bf)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(zr)
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

// The listing shows only .brp files; legacy formats are invisible to the UI.
func TestListBRPOnly(t *testing.T) {
	dir := t.TempDir()
	writeBRP(t, dir, "a")
	writeBRP(t, dir, "b")
	if err := os.WriteFile(filepath.Join(dir, "legacy.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "raw.brsnap"), []byte("BRSNAP READY\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{Dir: dir}
	infos, err := s.list()
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 2 || infos[0].File != "a" || infos[1].File != "b" {
		t.Fatalf("got %+v, want just a and b", infos)
	}
}

// The catalog endpoint must serve the same JSON shape as the worker's Durable
// Object table (nullable stats, newest game first, no-start rows last) with
// the stats derived from each .brp's meta record.
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

	srv := httptest.NewServer((&Server{Dir: dir}).Handler())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/api/replays")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	var entries []CatalogEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].ID != "recent" || entries[1].ID != "nostart" {
		t.Fatalf("want [recent nostart], got %+v", entries)
	}

	r := entries[0]
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

	n := entries[1]
	if n.StartUnix != nil {
		t.Errorf("nostart startUnix = %v, want null", *n.StartUnix)
	}
	if n.GameSize == nil || *n.GameSize != "1v1" {
		t.Errorf("nostart gameSize = %v", n.GameSize)
	}
	if n.DurationSec == nil || *n.DurationSec != 2 { // last frame 60 / 30 fps
		t.Errorf("nostart durationSec = %v", n.DurationSec)
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

// TestIndexHTMLDataOrigin pins the __DATA_ORIGIN__ contract this server shares
// with the Vite build. The deployed viewer fetches replay pieces from the R2
// bucket's own hostname (stamped into the placeholder at build time); this
// server IS the origin for its files, so it must blank the placeholder — an
// unsubstituted one would send the viewer looking for a literal host.
//
// It also guards the shape of the emitted line. Both substituters do a plain
// textual replace, so a placeholder token that collided with the global's name
// would be rewritten into `window.https://... =`: invalid JS that nothing else
// in the build or the test suite would notice.
func TestIndexHTMLDataOrigin(t *testing.T) {
	srv := httptest.NewServer((&Server{Dir: t.TempDir()}).Handler())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	html := string(b)

	if want := `window.__DATA_BASE__ = "";`; !strings.Contains(html, want) {
		t.Errorf("served index.html does not assign an empty data origin (want %q)", want)
	}
	for _, tok := range []string{"__DATA_ORIGIN__", "__ASSET_REV__"} {
		if strings.Contains(html, tok) {
			t.Errorf("served index.html still contains the unsubstituted placeholder %s", tok)
		}
	}
}

// TestFingerprintedAssets pins the contract between index.html and this server:
// the entry references its subresources by their content-hashed names, so those
// exact URLs must resolve. A mismatch would leave the viewer with no script and
// no stylesheet — a blank page, not a degraded one.
func TestFingerprintedAssets(t *testing.T) {
	srv := httptest.NewServer((&Server{Dir: t.TempDir()}).Handler())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	// Pull the URLs the entry actually asks for rather than reconstructing
	// them, so this fails if either side's naming scheme moves.
	refs := regexp.MustCompile(`/(?:app|style)\.[0-9a-f]{8}\.(?:js|css)`).FindAllString(string(b), -1)
	if len(refs) != 2 {
		t.Fatalf("index.html references %d fingerprinted subresources, want 2: %v", len(refs), refs)
	}
	for _, ref := range refs {
		r, err := http.Get(srv.URL + ref)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != 200 {
			t.Errorf("GET %s: status %d", ref, r.StatusCode)
		}
		if len(body) == 0 {
			t.Errorf("GET %s: empty body", ref)
		}
	}
}

// TestFavicon guards the tab icon's plumbing: the embed pattern in
// worker/assets.go and the route that serves it. A missing embed is the easy
// mistake here and shows up only as a 404 in a browser tab nobody is watching.
func TestFavicon(t *testing.T) {
	srv := httptest.NewServer((&Server{Dir: t.TempDir()}).Handler())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/favicon.svg")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET /favicon.svg: status %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "image/svg+xml" {
		t.Errorf("content-type = %q, want image/svg+xml", got)
	}
	if !strings.HasPrefix(string(b), "<svg") {
		t.Errorf("body is not an SVG (starts %q)", string(b[:min(8, len(b))]))
	}

	// index.html must actually reference it, or the file ships dead.
	page, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	html, _ := io.ReadAll(page.Body)
	page.Body.Close()
	if !strings.Contains(string(html), `href="/favicon.svg"`) {
		t.Error("index.html does not reference /favicon.svg")
	}
}
