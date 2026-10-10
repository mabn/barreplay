package packer

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/insights"
	"github.com/mabn/barreplay/snapshot"
)

// gid is a real-shaped game id: the BAR API client refuses anything else.
const gid = "0123456789abcdef0123456789abcdef"

func TestReplayMonth(t *testing.T) {
	for _, tc := range []struct {
		unix int64
		want string
	}{
		{1791655167, "2026-10"},
		// 23:30 UTC on Oct 31 is November in Warsaw, but the folder is UTC.
		{1793489400, "2026-10"},
		{1793491200, "2026-11"},
		{0, ""},
		{-5, ""},
	} {
		if got := ReplayMonth(tc.unix); got != tc.want {
			t.Errorf("ReplayMonth(%d) = %q, want %q", tc.unix, got, tc.want)
		}
	}
}

func TestIsMainRid(t *testing.T) {
	for rid, want := range map[string]bool{
		"2026-10/abc":          true,
		"undated/abc":          true,
		"abc":                  true, // -rev=false, before month folders
		"2026-10/abc-1a2b3c4d": false,
		"abc-1a2b3c4d":         false,
		"2026-10/abcd":         false,
	} {
		if got := IsMainRid(rid, "abc"); got != want {
			t.Errorf("IsMainRid(%q) = %v, want %v", rid, got, want)
		}
	}
}

func TestCapturesAllTeams(t *testing.T) {
	spec := &snapshot.RecorderInfo{Spectator: true}
	player := &snapshot.RecorderInfo{AllyTeam: 1}
	for _, tc := range []struct {
		name string
		m    snapshot.Meta
		view string
		want bool
	}{
		{"spectator upload", snapshot.Meta{Recorder: spec}, "", true},
		{"player upload", snapshot.Meta{Recorder: player}, "", false},
		{"re-sim", snapshot.Meta{Resim: true}, "", true},
		// No recorder and no re-sim mark: an uploader stream older than the
		// recorder record. It must not take the main name on a guess.
		{"says nothing", snapshot.Meta{}, "", false},
		{"declared full", snapshot.Meta{}, "full", true},
		{"declared ally beats the capture", snapshot.Meta{Resim: true}, "ally", false},
		{"declared unknown", snapshot.Meta{Recorder: spec}, "unknown", false},
	} {
		if got := CapturesAllTeams(tc.m, tc.view); got != tc.want {
			t.Errorf("%s: CapturesAllTeams = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// fakeWorker is a dev worker with a bucket that honours If-None-Match: *, a
// catalog GET answering one row, and the catalog PUT.
type fakeWorker struct {
	mu      sync.Mutex
	objects map[string]bool
	row     string // the GET /api/replays body; "" answers []
	puts    []string
	catalog map[string]any
}

func (f *fakeWorker) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/replays":
		if f.row == "" {
			w.Write([]byte(`[]`))
		} else {
			w.Write([]byte(f.row))
		}
	case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/replays/"):
		key := strings.TrimPrefix(r.URL.Path, "/")
		if r.Header.Get("If-None-Match") == "*" && f.objects[key] {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		f.objects[key] = true
		f.puts = append(f.puts, key)
		w.Write([]byte(`{"ok":true}`))
	case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/api/replays/"):
		b, _ := io.ReadAll(r.Body)
		f.catalog = map[string]any{}
		json.Unmarshal(b, &f.catalog)
		w.Write([]byte(`{"ok":true}`))
	default:
		http.NotFound(w, r)
	}
}

// publishFull packs the test stream and publishes it as a full view through a
// fake dev worker, returning what landed.
func publishFull(t *testing.T, f *fakeWorker, o UploadOptions) {
	t.Helper()
	dir := t.TempDir()
	in := filepath.Join(dir, gid+".brepstream")
	if err := os.WriteFile(in, []byte(testStream), 0o644); err != nil {
		t.Fatal(err)
	}
	brpPath, _, err := Pack(context.Background(), nil, in, dir, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if f.objects == nil {
		f.objects = map[string]bool{}
	}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	t.Cleanup(srv.Close)
	t.Setenv("R2_ACCESS_KEY_ID", "")
	t.Setenv("R2_SECRET_ACCESS_KEY", "")
	o.Target, o.WorkerDir, o.IndexURL = "local", filepath.Join(dir, "does-not-exist"), srv.URL
	if o.Rev == "" {
		o.Rev = "1a2b3c4d"
	}
	if err := UploadStatic(context.Background(), brpPath, o); err != nil {
		t.Fatal(err)
	}
	sort.Strings(f.puts)
}

func TestUploadStaticFullViewTakesMain(t *testing.T) {
	f := &fakeWorker{}
	publishFull(t, f, UploadOptions{View: "full"})
	want := []string{"replays/undated/" + gid + ".brp", "replays/undated/" + gid + ".insights" + fmt.Sprint(insights.Version) + ".json"}
	if fmt.Sprint(f.puts) != fmt.Sprint(want) {
		t.Errorf("puts = %v, want %v", f.puts, want)
	}
	if f.catalog["rid"] != "undated/"+gid || f.catalog["rev"] != "1a2b3c4d" {
		t.Errorf("catalog rid/rev = %v/%v, want undated/<gid> and 1a2b3c4d", f.catalog["rid"], f.catalog["rev"])
	}
}

// The month comes from the BAR API when the capture has no start time.
func TestUploadStaticMonthFromBarAPI(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":"0123456789abcdef0123456789abcdef","fileName":"x.sdfz","startTime":"2026-09-30T23:59:00.000Z"}`))
	}))
	t.Cleanup(api.Close)
	f := &fakeWorker{}
	publishFull(t, f, UploadOptions{View: "full", BarAPI: barapi.New(barapi.WithBaseURLs(api.URL, api.URL))})
	if len(f.puts) == 0 || f.puts[0] != "replays/2026-09/"+gid+".brp" {
		t.Errorf("puts = %v, want the main under 2026-09", f.puts)
	}
}

// A main the catalog does not know about (a race, or a row never written) is
// never overwritten: the conditional PUT is refused and the full view lands
// suffixed.
func TestUploadStaticMainTakenFallsBackToSuffix(t *testing.T) {
	f := &fakeWorker{objects: map[string]bool{"replays/undated/" + gid + ".brp": true}}
	publishFull(t, f, UploadOptions{View: "full"})
	want := []string{"replays/undated/" + gid + "-1a2b3c4d.brp", "replays/undated/" + gid + "-1a2b3c4d.insights" + fmt.Sprint(insights.Version) + ".json"}
	if fmt.Sprint(f.puts) != fmt.Sprint(want) {
		t.Errorf("puts = %v, want %v", f.puts, want)
	}
	if f.catalog["rid"] != "undated/"+gid+"-1a2b3c4d" {
		t.Errorf("catalog rid = %v", f.catalog["rid"])
	}
}

// With a main in the catalog, a different full view is suffixed without even
// trying the main key; identical bytes upload nothing and re-register the main.
func TestUploadStaticExistingMain(t *testing.T) {
	row := `[{"id":"` + gid + `","rid":"2026-10/` + gid + `","uploads":[{"rid":"2026-10/` + gid + `","ally":null,"rev":"%s"}]}]`

	f := &fakeWorker{row: fmt.Sprintf(row, "99999999")}
	publishFull(t, f, UploadOptions{View: "full"})
	want := []string{"replays/undated/" + gid + "-1a2b3c4d.brp", "replays/undated/" + gid + "-1a2b3c4d.insights" + fmt.Sprint(insights.Version) + ".json"}
	if fmt.Sprint(f.puts) != fmt.Sprint(want) {
		t.Errorf("different bytes: puts = %v, want %v", f.puts, want)
	}

	f = &fakeWorker{row: fmt.Sprintf(row, "1a2b3c4d")}
	publishFull(t, f, UploadOptions{View: "full"})
	if len(f.puts) != 0 {
		t.Errorf("identical bytes: puts = %v, want none", f.puts)
	}
	if f.catalog["rid"] != "2026-10/"+gid {
		t.Errorf("identical bytes: catalog rid = %v, want the main", f.catalog["rid"])
	}
}

// A one-sided capture never looks for or takes the main name.
func TestUploadStaticAllyStaysSuffixed(t *testing.T) {
	f := &fakeWorker{}
	publishFull(t, f, UploadOptions{View: "ally"})
	if len(f.puts) == 0 || f.puts[0] != "replays/undated/"+gid+"-1a2b3c4d.brp" {
		t.Errorf("puts = %v, want the suffixed name", f.puts)
	}
}
