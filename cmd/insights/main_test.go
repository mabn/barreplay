package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mabn/barreplay/internal/insights"
	"github.com/mabn/barreplay/internal/viz"
	"github.com/mabn/barreplay/snapshot"
)

const gameID = "0123456789abcdef0123456789abcdef"
const rid = gameID + "-deadbeef"

// writeBRP writes a small two-sided capture.
func writeBRP(t *testing.T, dir string) string {
	t.Helper()
	w, err := snapshot.NewBRPWriter(dir, rid)
	if err != nil {
		t.Fatal(err)
	}
	meta := snapshot.Meta{
		GameID: gameID, MapName: "Test Map", SampleEvery: 30,
		UnitDefs: map[int32]snapshot.UnitDef{
			1: {DefID: 1, Name: "armpw", HumanName: "Pawn", CanMove: true, Speed: 58, WeaponCount: 1, MetalCost: 50},
			2: {DefID: 2, Name: "armfus", IsBuilding: true, XSize: 10, ZSize: 10, MetalCost: 3600},
		},
		Teams:   []snapshot.TeamInfo{{TeamID: 0, AllyTeam: 0}, {TeamID: 1, AllyTeam: 1}},
		Players: []snapshot.PlayerInfo{{PlayerID: 0, Name: "Ann", Team: 0}, {PlayerID: 1, Name: "Bob", Team: 1}},
	}
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 100; i++ {
		fr := snapshot.Frame{Frame: int32(i * 30), TimeSec: float32(i)}
		for u := int32(0); u < 4; u++ {
			fr.Units = append(fr.Units, snapshot.UnitState{UnitID: 10 + u, DefID: 1, Team: u % 2, Pos: snapshot.Vec3{X: float32(i), Z: float32(u * 100)}, Health: 100, MaxHealth: 100, BuildProgress: 1})
		}
		fr.Units = append(fr.Units, snapshot.UnitState{UnitID: 50, DefID: 2, Team: 1, Pos: snapshot.Vec3{X: 900, Z: 900}, Health: 5000, MaxHealth: 5000, BuildProgress: 1})
		fr.Resources = []snapshot.TeamResource{{Team: 0, MetalIncome: 12}, {Team: 1, MetalIncome: 8}}
		if err := w.WriteFrame(fr); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, rid+".brp")
}

// server serves a catalog with one row plus the bucket under root.
func server(t *testing.T, root string, view string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/replays" {
			rows := []map[string]any{}
			if id := r.URL.Query().Get("id"); id == "" || id == gameID {
				rows = append(rows, map[string]any{"id": gameID, "rid": rid, "view": view})
			}
			json.NewEncoder(w).Encode(rows)
			return
		}
		b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/"))))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	}))
}

func readInsights(t *testing.T, path string) insights.Insights {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var ins insights.Insights
	if err := json.Unmarshal(b, &ins); err != nil {
		t.Fatal(err)
	}
	return ins
}

func newRunner(srv *httptest.Server, out string) *runner {
	return &runner{indexURL: srv.URL, dataURL: srv.URL, http: srv.Client(), outDir: out}
}

// legacyDir holds a legacy bundle (.brw/.keys/.resources/c<n>, no insights)
// cut by the last encoder that wrote pieces from writeBRP's capture, beside
// that capture's .brp.
var legacyDir = filepath.Join("testdata", "legacy")

// legacyBucket copies the legacy bundle's pieces (not the .brp) into a bucket.
func legacyBucket(t *testing.T) string {
	t.Helper()
	bucket := t.TempDir()
	src := filepath.Join(legacyDir, "replays")
	err := filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(legacyDir, p)
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		dst := filepath.Join(bucket, rel)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dst, b, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return bucket
}

// A legacy replay (pieces only) is rebuilt, priced by army cost, and keeps
// the catalog row's view.
func TestRebuildsFromPieces(t *testing.T) {
	bucket := legacyBucket(t)
	srv := server(t, bucket, "ally")
	defer srv.Close()
	out := t.TempDir()
	if err := newRunner(srv, out).one(context.Background(), "https://bar-rts.com/replays/"+gameID); err != nil {
		t.Fatal(err)
	}
	ins := readInsights(t, filepath.Join(out, "replays", insights.FileName(rid)))
	if ins.CostCoverage != insights.CostArmy || ins.POV != insights.POVAlly || len(ins.Sides) != 2 {
		t.Errorf("cost/pov/sides = %s/%s/%d", ins.CostCoverage, ins.POV, len(ins.Sides))
	}
	if got := ins.Series.MetalIncome[0][2]; got != 12 {
		t.Errorf("side 0 metal income = %v, want 12 (from .resources)", got)
	}
}

// A revision whose .brp is in the bucket is read whole: full costs.
func TestPrefersTheBRP(t *testing.T) {
	bucket := t.TempDir()
	brp := writeBRP(t, filepath.Join(bucket, "replays"))
	if filepath.Base(brp) != rid+".brp" {
		t.Fatal(brp)
	}
	srv := server(t, bucket, "")
	defer srv.Close()
	out := t.TempDir()
	if err := newRunner(srv, out).one(context.Background(), rid); err != nil {
		t.Fatal(err)
	}
	ins := readInsights(t, filepath.Join(out, "replays", insights.FileName(rid)))
	if ins.CostCoverage != insights.CostFull || ins.POV != insights.POVFull {
		t.Errorf("cost/pov = %s/%s", ins.CostCoverage, ins.POV)
	}
}

// An existing insights file is not recomputed (and the replay not fetched)
// unless forced: publishing skips it, compute-only saves the published copy.
func TestSkipsPublished(t *testing.T) {
	bucket := t.TempDir()
	name := filepath.Join(bucket, "replays", insights.FileName(rid))
	os.MkdirAll(filepath.Dir(name), 0o755)
	os.WriteFile(name, []byte("{}"), 0o644)
	srv := server(t, bucket, "")
	defer srv.Close()
	out := t.TempDir()
	r := newRunner(srv, out)
	published := false
	r.publish = func(context.Context, string, string) error { published = true; return nil }
	if err := r.one(context.Background(), gameID); err != nil || published {
		t.Fatalf("skip: %v (published %v)", err, published)
	}
	r.publish = nil
	if err := r.one(context.Background(), gameID); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(out, "replays", insights.FileName(rid))); err != nil || string(b) != "{}" {
		t.Errorf("compute-only did not save the published file: %q, %v", b, err)
	}
	r.force = true
	if err := r.one(context.Background(), gameID); err == nil {
		t.Error("-force with no replay pieces should fail, not succeed")
	}
}

// -from/-to reach the catalog as its own date filter.
func TestCatalogRidsDateRange(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.RawQuery
		w.Write([]byte("[]"))
	}))
	defer srv.Close()
	rn := newRunner(srv, "")
	rn.from, rn.to = "2026-10-01", "1760000000"
	if _, err := rn.catalogRids(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got != "from=2026-10-01&limit=200&offset=0&to=1760000000" {
		t.Errorf("catalog query = %q", got)
	}
	for in, want := range map[string]bool{"2026-10-01": true, "1760000000": true, "2026-13-01": false, "yesterday": false} {
		if validDate(in) != want {
			t.Errorf("validDate(%q) = %v", in, !want)
		}
	}
}

func TestCatalogRids(t *testing.T) {
	srv := server(t, t.TempDir(), "")
	defer srv.Close()
	rids, err := newRunner(srv, "").catalogRids(context.Background())
	if err != nil || len(rids) != 1 || rids[0] != rid {
		t.Errorf("rids = %v, %v", rids, err)
	}
}

// A replay whose meta names no winner asks the BAR API, and its answer
// (ally teams) lands as a side index.
func TestWinnerFromAPI(t *testing.T) {
	brp := writeBRP(t, t.TempDir())
	out := t.TempDir()
	asked := ""
	r := &runner{outDir: out, localRid: rid, winners: func(_ context.Context, id string) ([]int32, error) {
		asked = id
		return []int32{1}, nil
	}}
	if err := r.one(context.Background(), brp); err != nil {
		t.Fatal(err)
	}
	ins := readInsights(t, filepath.Join(out, "replays", insights.FileName(rid)))
	if asked != gameID || ins.Winner != 1 {
		t.Errorf("asked %q, winner %d", asked, ins.Winner)
	}
	if ins.Swing == nil || len(ins.Swing.P) != len(ins.Series.T) {
		t.Errorf("swing = %+v", ins.Swing)
	}
}

// A local .brp is published under -rid when given.
func TestLocalWithRid(t *testing.T) {
	brp := writeBRP(t, t.TempDir())
	out := t.TempDir()
	r := &runner{outDir: out, localRid: gameID + "-01234567"}
	if err := r.one(context.Background(), brp); err != nil {
		t.Fatal(err)
	}
	ins := readInsights(t, filepath.Join(out, "replays", insights.FileName(gameID+"-01234567")))
	if ins.CostCoverage != insights.CostFull {
		t.Errorf("cost = %s", ins.CostCoverage)
	}
}

// The summary rebuilt from published pieces agrees with the one computed from
// the .brp they were cut from, on everything the pieces carry: only costs of
// unpriced defs (and the coverage/POV labels saying so) may differ.
func TestPiecesMatchBRP(t *testing.T) {
	bucket := legacyBucket(t)
	f, err := os.Open(filepath.Join(legacyDir, rid+".brp"))
	if err != nil {
		t.Fatal(err)
	}
	bf, err := snapshot.ParseBRP(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	in, _ := insights.FromBRP(bf)
	want, err := insights.Compute(in)
	if err != nil {
		t.Fatal(err)
	}
	pb, res, err := viz.ReadStaticBundle(context.Background(), func(_ context.Context, key string) ([]byte, error) {
		b, err := os.ReadFile(filepath.Join(bucket, filepath.FromSlash(key)))
		if os.IsNotExist(err) {
			return nil, viz.ErrNotFound
		}
		return b, err
	}, rid)
	if err != nil {
		t.Fatal(err)
	}
	pin, _ := insights.FromPieces(pb, res, insights.POVFull)
	got, err := insights.Compute(pin)
	if err != nil {
		t.Fatal(err)
	}
	same := func(name string, a, b any) {
		ja, _ := json.Marshal(a)
		jb, _ := json.Marshal(b)
		if string(ja) != string(jb) {
			t.Errorf("%s differs:\n brp:    %s\n pieces: %s", name, ja, jb)
		}
	}
	// Pieces price only armed mobile defs, so they cannot say what a side
	// owns; everything else must match.
	if got.Series.Value != nil {
		t.Error("a pieces rebuild reported owned value it cannot price")
	}
	want.Series.Value = nil
	same("series", want.Series, got.Series)
	same("sides", want.Sides, got.Sides)
	same("milestones", want.Milestones, got.Milestones)
	same("chat", want.Chat, got.Chat)
	same("bounds", want.Bounds, got.Bounds)
	same("death frames", want.Deaths.F, got.Deaths.F)
}
