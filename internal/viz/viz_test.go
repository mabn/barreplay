package viz

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// writeBRP writes a small two-frame capture to <dir>/<gameID>.brp and returns
// its path.
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
			1: {DefID: 1, Name: "armcom", CanMove: true},
			2: {DefID: 2, Name: "corllt", XSize: 2, ZSize: 3, IsBuilding: true},
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
			{UnitID: 100, DefID: 1, Team: 0, Pos: snapshot.Vec3{X: 10, Z: 20}, Health: 3000, MaxHealth: 3000, VelX: 2, VelZ: -1},
			{UnitID: 200, DefID: 2, Team: 1, Pos: snapshot.Vec3{X: -50, Z: 80}, Health: 400, MaxHealth: 800},
		}},
		{Frame: 60, TimeSec: 2, Units: []snapshot.UnitState{
			{UnitID: 100, DefID: 1, Team: 0, Pos: snapshot.Vec3{X: 12, Z: 22}, Health: 3000, MaxHealth: 3000},
		}},
	}
	for _, f := range frames {
		if err := w.WriteFrame(f); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, gameID+".brp")
}

// The viewer reads a .brp directly, so the server only needs to list the
// captures and stream each file with Range support (plus the icon table). This
// checks the listing shape, the full/partial file transfers, the traversal
// guard, and the icon-table endpoint.
func TestServeReplays(t *testing.T) {
	dir := t.TempDir()
	path := writeBRP(t, dir, "g")
	// A non-.brp file must be invisible to the listing.
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	fileBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer((&Server{Dir: dir}).Handler())
	defer srv.Close()

	// /index.json lists only the .brp, keyed by gameId (no extension).
	resp, err := http.Get(srv.URL + "/index.json")
	if err != nil {
		t.Fatal(err)
	}
	var infos []replayInfo
	if err := json.NewDecoder(resp.Body).Decode(&infos); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(infos) != 1 || infos[0].File != "g" || infos[0].GameID != "g" || infos[0].Size != int64(len(fileBytes)) {
		t.Fatalf("index = %+v (file size %d)", infos, len(fileBytes))
	}

	// Full file transfer: bytes must match the stored .brp exactly.
	full, resp := get(t, srv.URL+"/replays/g.brp", "")
	if resp.StatusCode != 200 || !bytes.Equal(full, fileBytes) {
		t.Fatalf("full GET: status %d, %d bytes (want %d)", resp.StatusCode, len(full), len(fileBytes))
	}
	if resp.Header.Get("Accept-Ranges") != "bytes" {
		t.Errorf("no Accept-Ranges header")
	}

	// Range request: the browser reads meta/chunks as byte ranges.
	part, resp := get(t, srv.URL+"/replays/g.brp", "bytes=0-9")
	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("range GET status = %d, want 206", resp.StatusCode)
	}
	if !bytes.Equal(part, fileBytes[:10]) {
		t.Errorf("range 0-9 mismatch")
	}

	// Traversal / non-.brp names are rejected; a missing file is a 404.
	for _, tc := range []struct {
		path string
		want int
	}{
		{"/replays/sub/x.brp", http.StatusBadRequest}, // a path separator in the name
		{"/replays/notes.txt", http.StatusBadRequest}, // not a .brp
		{"/replays/missing.brp", http.StatusNotFound},
	} {
		r, err := http.Get(srv.URL + tc.path)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode != tc.want {
			t.Errorf("GET %s: status %d, want %d", tc.path, r.StatusCode, tc.want)
		}
	}

	// The icon table the browser fetches to resolve unit icons.
	icons, resp := get(t, srv.URL+"/icontypes.json", "")
	if resp.StatusCode != 200 {
		t.Fatalf("/icontypes.json status %d", resp.StatusCode)
	}
	var table map[string]struct {
		P string  `json:"p"`
		S float64 `json:"s"`
	}
	if err := json.Unmarshal(icons, &table); err != nil {
		t.Fatal(err)
	}
	if table["armcom"].P != "icons/armcom.png" || table["armcom"].S <= 0 {
		t.Errorf("armcom icon = %+v", table["armcom"])
	}
}

func get(t *testing.T, url, rangeHdr string) ([]byte, *http.Response) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	if rangeHdr != "" {
		req.Header.Set("Range", rangeHdr)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return b, resp
}

// IconTableJSON dumps every icontype (incl. the synthesised _scav variants) that
// has a bitmap on disk, so the browser can resolve icons itself.
func TestIconTableJSON(t *testing.T) {
	b, err := IconTableJSON()
	if err != nil {
		t.Fatal(err)
	}
	var table map[string]struct {
		P string  `json:"p"`
		S float64 `json:"s"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	// Well-known units resolve to a bitmap that exists in the embedded FS.
	if table["armcom"].P != "icons/armcom.png" {
		t.Errorf("armcom = %+v", table["armcom"])
	}
	if table["armllt"].P != "icons/defence_0_laser.png" {
		t.Errorf("armllt = %+v", table["armllt"])
	}
	// The scavenger variant points at the inverted path.
	if table["armcom_scav"].P != "icons/inverted/armcom.png" {
		t.Errorf("armcom_scav = %+v", table["armcom_scav"])
	}
	// The commander icon is meaningfully larger than 1 (per-type size preserved).
	if table["armcom"].S < 1.5 {
		t.Errorf("armcom size = %v, want ~1.8", table["armcom"].S)
	}
}
