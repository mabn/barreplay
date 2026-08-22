package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mabn/barreplay/internal/engine"
	"github.com/mabn/barreplay/internal/packer"
	"github.com/mabn/barreplay/internal/resim"
)

// mockWorker fakes the worker's job/stream API surface: one pending upload job
// whose archived stream it serves, any number of queued re-sims, and a record
// of every state transition. GET /api/jobs serves ONE kind, like the real
// route, so a daemon asking for the wrong one gets nothing.
type mockWorker struct {
	t       *testing.T
	job     ingestJob
	resim   []ingestJob // queued re-sim jobs, served under ?kind=resim
	stream  []byte
	drained bool // the upload queue empties after the first list

	mu           sync.Mutex
	transitions  []string        // "<state>[:<error>]", or "claim"
	claimed      map[string]bool // job id -> taken (a second claim is a 409)
	statsSeen    []jobStats      // the processing record of every report that carried one
	progressSeen []jobProgress   // the live reading of every healthcheck that carried one
}

func (m *mockWorker) handler(token string) http.Handler {
	mux := http.NewServeMux()
	authed := func(r *http.Request) bool {
		return token == "" || r.Header.Get("Authorization") == "Bearer "+token
	}
	mux.HandleFunc("GET /api/jobs", func(w http.ResponseWriter, r *http.Request) {
		if !authed(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		kind := r.URL.Query().Get("kind")
		if kind == "" {
			kind = kindUpload
		}
		jobs := []ingestJob{}
		m.mu.Lock()
		if kind == kindResim {
			for _, j := range m.resim {
				if !m.claimed[j.ID] {
					jobs = append(jobs, j)
				}
			}
		} else if !m.drained {
			m.drained = true
			jobs = append(jobs, m.job)
		}
		m.mu.Unlock()
		json.NewEncoder(w).Encode(jobs)
	})
	mux.HandleFunc("POST /api/jobs/", func(w http.ResponseWriter, r *http.Request) {
		if !authed(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			State, Error string
			Claim        bool
			Stats        *jobStats
			Progress     *jobProgress
		}
		json.NewDecoder(r.Body).Decode(&body)
		id := strings.TrimPrefix(r.URL.Path, "/api/jobs/")
		m.mu.Lock()
		if body.Claim {
			if m.claimed[id] {
				m.mu.Unlock()
				http.Error(w, "job already claimed", http.StatusConflict)
				return
			}
			if m.claimed == nil {
				m.claimed = map[string]bool{}
			}
			m.claimed[id] = true
			m.transitions = append(m.transitions, "claim")
			m.mu.Unlock()
			w.Write([]byte(`{"ok":true}`))
			return
		}
		tr := body.State
		if body.Error != "" {
			tr += ":" + body.Error
		}
		m.transitions = append(m.transitions, tr)
		if body.Stats != nil {
			m.statsSeen = append(m.statsSeen, *body.Stats)
		}
		if body.Progress != nil {
			m.progressSeen = append(m.progressSeen, *body.Progress)
		}
		m.mu.Unlock()
		w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("GET /api/streams/", func(w http.ResponseWriter, r *http.Request) {
		if !authed(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/"+m.job.GameID+"/1700000000000-a0.brepstream") {
			http.NotFound(w, r)
			return
		}
		w.Write(m.stream)
	})
	return mux
}

func newMock(t *testing.T) *mockWorker {
	return &mockWorker{
		t: t,
		job: ingestJob{
			ID:        "job-1",
			GameID:    "feed5eed00000000000000000000beef",
			StreamKey: "streams/feed5eed00000000000000000000beef/1700000000000-a0.brepstream",
			Kind:      kindUpload,
			State:     "pending",
		},
		stream:  []byte("BREPSTREAM 1\nBRSNAP GID feed5eed00000000000000000000beef\nBRSNAP READY\n"),
		claimed: map[string]bool{},
	}
}

func newDaemon(url, token string, process func(ctx context.Context, streamPath string, st *jobStats) error) *daemon {
	return &daemon{
		workerAPI: workerAPI{indexURL: url, token: token, client: http.DefaultClient},
		process:   process,
	}
}

// The happy path: claim -> download -> process -> done, with the bearer token
// on every call and the stream delivered byte-for-byte under its gameId name.
func TestRunOnceProcessesJob(t *testing.T) {
	m := newMock(t)
	srv := httptest.NewServer(m.handler("s3cret"))
	t.Cleanup(srv.Close)

	var gotPath string
	var gotBytes []byte
	d := newDaemon(srv.URL, "s3cret", func(_ context.Context, streamPath string, _ *jobStats) error {
		gotPath = streamPath
		b, err := os.ReadFile(streamPath)
		gotBytes = b
		return err
	})
	n, err := d.runOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("attempted %d jobs, want 1", n)
	}
	if want := m.job.GameID + ".brepstream"; !strings.HasSuffix(gotPath, want) {
		t.Errorf("stream path %q, want basename %q (packer keys the replay off it)", gotPath, want)
	}
	if string(gotBytes) != string(m.stream) {
		t.Errorf("downloaded stream differs from the archive")
	}
	if got := strings.Join(m.transitions, ","); got != "processing,done" {
		t.Errorf("transitions = %q, want processing,done", got)
	}
}

// The -resim worker's candidate selection and failure memory, driven through
// a mock catalog. A game is re-simulated only while its current upload is
// one-sided and no full-view (ally-null) revision exists; a failed game is
// skipped on later rounds.
func TestResimDaemonRunOnce(t *testing.T) {
	// Catalog: "onesided" needs a resim; "spect" (no uploaderAlly) and
	// "hasfull" (an ally-null revision exists) don't; "broken" will fail.
	catalog := []map[string]any{
		{"id": "onesided", "uploaderAlly": 1, "uploads": []map[string]any{{"rid": "onesided-11111111", "ally": 1}}},
		{"id": "spect", "uploaderAlly": nil, "uploads": []map[string]any{{"rid": "spect-11111111", "ally": nil}}},
		{"id": "hasfull", "uploaderAlly": 0, "uploads": []map[string]any{
			{"rid": "hasfull-11111111", "ally": 0}, {"rid": "hasfull-22222222", "ally": nil},
		}},
		{"id": "broken", "uploaderAlly": 0, "uploads": []map[string]any{{"rid": "broken-11111111", "ally": 0}}},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/replays":
			json.NewEncoder(w).Encode(catalog)
		case "/api/jobs": // nothing requested by hand; the scan is all there is
			json.NewEncoder(w).Encode([]ingestJob{})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	var ran []string
	r := &resimDaemon{
		workerAPI: workerAPI{indexURL: srv.URL, client: http.DefaultClient},
		failed:    map[string]bool{},
		resim: func(_ context.Context, gameID string, _ *jobStats, _ *resim.Progress) error {
			ran = append(ran, gameID)
			if gameID == "broken" {
				return errors.New("no engine")
			}
			// A successful publish retires the candidate in the real catalog;
			// mirror that so the next round sees it done.
			for _, row := range catalog {
				if row["id"] == gameID {
					row["uploads"] = append(row["uploads"].([]map[string]any),
						map[string]any{"rid": gameID + "-fefefefe", "ally": nil})
				}
			}
			return nil
		},
	}
	n, err := r.runOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 || strings.Join(ran, ",") != "onesided,broken" {
		t.Fatalf("round 1: attempted %d (%v), want onesided,broken", n, ran)
	}
	// Round 2: onesided is retired by its publish, broken is remembered.
	ran = nil
	if n, err = r.runOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n != 0 || len(ran) != 0 {
		t.Fatalf("round 2: attempted %d (%v), want none", n, ran)
	}
}

// A re-sim requested by hand (the landing page's paste box) is claimed, run
// and reported done — and the catalog scan still happens in the same round, so
// a queued request does not starve the automatic candidates.
func TestResimDaemonDrainsQueue(t *testing.T) {
	m := newMock(t)
	m.resim = []ingestJob{{ID: "rj-1", GameID: "aaaa0000000000000000000000000001", Kind: kindResim, State: "pending"}}
	catalog := []map[string]any{
		{"id": "onesided", "uploaderAlly": 1, "uploads": []map[string]any{{"rid": "onesided-11111111", "ally": 1}}},
	}
	mux := http.NewServeMux()
	mux.Handle("/api/jobs", m.handler(""))
	mux.Handle("/api/jobs/", m.handler(""))
	mux.HandleFunc("/api/replays", func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(catalog)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	var ran []string
	r := &resimDaemon{
		workerAPI: workerAPI{indexURL: srv.URL, client: http.DefaultClient},
		failed:    map[string]bool{},
		resim: func(_ context.Context, gameID string, _ *jobStats, _ *resim.Progress) error {
			ran = append(ran, gameID)
			return nil
		},
	}
	n, err := r.runOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 || strings.Join(ran, ",") != "aaaa0000000000000000000000000001,onesided" {
		t.Fatalf("attempted %d (%v), want the queued game first then the scan", n, ran)
	}
	if got := strings.Join(m.transitions, ","); got != "claim,done" {
		t.Errorf("transitions = %q, want claim,done", got)
	}
}

// The processing record rides the terminal report — on SUCCESS and on FAILURE
// alike. Forty minutes of engine time that ended badly is the run whose
// timings and engine log are most worth keeping.
func TestResimDaemonReportsStats(t *testing.T) {
	for _, tc := range []struct {
		name  string
		rerr  error
		state string
	}{
		{"published", nil, "done"},
		{"failed", errors.New("desynced"), "error:desynced"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newMock(t)
			m.resim = []ingestJob{{ID: "rj-1", GameID: "aaaa0000000000000000000000000001", Kind: kindResim, State: "pending"}}
			mux := http.NewServeMux()
			mux.Handle("/api/jobs", m.handler(""))
			mux.Handle("/api/jobs/", m.handler(""))
			mux.HandleFunc("/api/replays", func(w http.ResponseWriter, _ *http.Request) {
				json.NewEncoder(w).Encode([]map[string]any{})
			})
			srv := httptest.NewServer(mux)
			t.Cleanup(srv.Close)

			r := &resimDaemon{
				workerAPI: workerAPI{indexURL: srv.URL, client: http.DefaultClient},
				failed:    map[string]bool{},
				resim: func(_ context.Context, _ string, st *jobStats, _ *resim.Progress) error {
					// What resimPublish copies out of resim.RunStats.
					st.fromRunStats(resim.RunStats{
						EngineSec: 2431, LoadSec: 41, SimSec: 2390,
						Frames: 100170, Samples: 3339, SpeedUp: 1.4,
						GameSec: 3339, EngineVersion: "2026.07.04",
						Infolog: engine.InfologSummary{Bytes: 48 << 20, LastFrame: 100170, Desyncs: 0, Warnings: 118},
					})
					st.SizeReport = "sections: ...\n"
					return tc.rerr
				},
			}
			if _, err := r.runOnce(context.Background()); err != nil {
				t.Fatal(err)
			}
			if got := strings.Join(m.transitions, ","); got != "claim,"+tc.state {
				t.Fatalf("transitions = %q, want claim,%s", got, tc.state)
			}
			if len(m.statsSeen) != 1 {
				t.Fatalf("reports carrying stats = %d, want 1", len(m.statsSeen))
			}
			s := m.statsSeen[0]
			if s.ResimSec != 2431 || s.LoadSec != 41 || s.Frames != 100170 || s.EngineVersion != "2026.07.04" {
				t.Errorf("stats = %+v, want the run's own figures", s)
			}
			if s.Infolog == nil || s.Infolog.Warnings != 118 || s.Infolog.Desyncs != 0 {
				t.Errorf("infolog = %+v, want the engine log summary (zero desyncs included)", s.Infolog)
			}
			if s.SizeReport == "" {
				t.Error("the size report did not ride along")
			}
			if s.TookSec <= 0 {
				t.Error("TookSec was not measured")
			}
		})
	}
}

// A queued re-sim that fails reports the message onto its own job row — that
// is what the requester reads on the queue page — and does NOT go into the
// catalog scan's failure memory, so re-requesting it retries.
func TestResimDaemonQueuedFailure(t *testing.T) {
	m := newMock(t)
	m.resim = []ingestJob{{ID: "rj-1", GameID: "aaaa0000000000000000000000000001", Kind: kindResim, State: "pending"}}
	mux := http.NewServeMux()
	mux.Handle("/api/jobs", m.handler(""))
	mux.Handle("/api/jobs/", m.handler(""))
	mux.HandleFunc("/api/replays", func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	r := &resimDaemon{
		workerAPI: workerAPI{indexURL: srv.URL, client: http.DefaultClient},
		failed:    map[string]bool{},
		resim: func(context.Context, string, *jobStats, *resim.Progress) error {
			return errors.New("no engine")
		},
	}
	if _, err := r.runOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(m.transitions, ","); got != "claim,error:no engine" {
		t.Errorf("transitions = %q, want claim,error:no engine", got)
	}
	if len(r.failed) != 0 {
		t.Errorf("failed = %v, want empty (the job row carries the failure)", r.failed)
	}
}

// A worker too old to filter by kind hands every pending job to whoever asks.
// The upload loop must leave a re-sim alone — untouched, not failed, so the
// daemon that can actually run it still finds it pending.
func TestUploadDaemonSkipsResimJobs(t *testing.T) {
	m := newMock(t)
	m.job = ingestJob{ID: "rj-1", GameID: "aaaa0000000000000000000000000001", Kind: kindResim, State: "pending"}
	srv := httptest.NewServer(m.handler(""))
	t.Cleanup(srv.Close)

	processed := false
	d := newDaemon(srv.URL, "", func(context.Context, string, *jobStats) error {
		processed = true
		return nil
	})
	n, err := d.runOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if processed || n != 0 {
		t.Errorf("attempted %d, processed=%v; want the resim job left alone", n, processed)
	}
	if len(m.transitions) != 0 {
		t.Errorf("transitions = %v, want none — the job must stay pending", m.transitions)
	}
}

// A re-sim runs for far longer than the worker's stale window, so it
// healthchecks. The terminal report must be the LAST word: a beat still in
// flight when done lands would put the row back to processing forever.
func TestResimDaemonHeartbeats(t *testing.T) {
	old := healthcheckEvery
	healthcheckEvery = 5 * time.Millisecond
	t.Cleanup(func() { healthcheckEvery = old })

	m := newMock(t)
	m.resim = []ingestJob{{ID: "rj-1", GameID: "aaaa0000000000000000000000000001", Kind: kindResim, State: "pending"}}
	mux := http.NewServeMux()
	mux.Handle("/api/jobs", m.handler(""))
	mux.Handle("/api/jobs/", m.handler(""))
	mux.HandleFunc("/api/replays", func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	r := &resimDaemon{
		workerAPI: workerAPI{indexURL: srv.URL, client: http.DefaultClient},
		failed:    map[string]bool{},
		resim: func(ctx context.Context, _ string, _ *jobStats, _ *resim.Progress) error {
			// Hold the "engine run" until the beats are visibly flowing.
			for {
				m.mu.Lock()
				beats := 0
				for _, tr := range m.transitions {
					if tr == "processing" {
						beats++
					}
				}
				m.mu.Unlock()
				if beats >= 2 {
					return nil
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(time.Millisecond):
				}
			}
		},
	}
	if _, err := r.runOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.transitions) < 4 || m.transitions[0] != "claim" {
		t.Fatalf("transitions = %v, want claim then beats then done", m.transitions)
	}
	if last := m.transitions[len(m.transitions)-1]; last != "done" {
		t.Errorf("last transition = %q, want done — a late heartbeat undid the report", last)
	}
}

// Every healthcheck carries what the run is doing right now, read at the moment
// the beat goes out rather than when the loop started — which is the whole
// point: a re-sim reports the same job row for the better part of an hour, and
// a snapshot taken once would freeze at "fetching demo".
func TestResimDaemonHealthchecksCarryProgress(t *testing.T) {
	old := healthcheckEvery
	healthcheckEvery = 5 * time.Millisecond
	t.Cleanup(func() { healthcheckEvery = old })

	m := newMock(t)
	m.resim = []ingestJob{{ID: "rj-1", GameID: "aaaa0000000000000000000000000001", Kind: kindResim, State: "pending"}}
	mux := http.NewServeMux()
	mux.Handle("/api/jobs", m.handler(""))
	mux.Handle("/api/jobs/", m.handler(""))
	mux.HandleFunc("/api/replays", func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	r := &resimDaemon{
		workerAPI: workerAPI{indexURL: srv.URL, client: http.DefaultClient},
		failed:    map[string]bool{},
		resim: func(ctx context.Context, _ string, _ *jobStats, pr *resim.Progress) error {
			// Two readings, a phase apart: the beats must show the second one,
			// not the first.
			pr.SetPhase(resim.PhaseStartingEngine)
			if !waitForBeats(ctx, m, 2) {
				return ctx.Err()
			}
			pr.SetPhase(resim.PhaseSimulating)
			if !waitForBeats(ctx, m, 5) {
				return ctx.Err()
			}
			return nil
		},
	}
	if _, err := r.runOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.progressSeen) < 3 {
		t.Fatalf("progress reports = %d, want every beat to carry one", len(m.progressSeen))
	}
	if got := m.progressSeen[0].State; got != resim.PhaseStartingEngine {
		t.Errorf("first beat's state = %q, want %q", got, resim.PhaseStartingEngine)
	}
	last := m.progressSeen[len(m.progressSeen)-1]
	if last.State != resim.PhaseSimulating {
		t.Errorf("last beat's state = %q, want %q — the beat re-reads the run",
			last.State, resim.PhaseSimulating)
	}
}

// The wire conversion, which is where the field mapping and the rounding live.
// A percentage with fourteen decimals is bytes on every beat and reads no
// better; the ETA goes to whole seconds for the same reason.
func TestProgressOf(t *testing.T) {
	got := progressOf(resim.ProgressState{
		Phase: resim.PhaseSimulating, Frame: 43000, TotalFrames: 100170,
		Percent: 42.926524, ETASec: 840.77, SimFPS: 68.249, RSSBytes: 3 << 30, CPUPercent: 612.51,
	})
	want := jobProgress{
		State: resim.PhaseSimulating, Frame: 43000, TotalFrames: 100170,
		Percent: 42.9, EtaSec: 840, SimFps: 68.2, RssBytes: 3 << 30, CpuPct: 612.5,
	}
	if *got != want {
		t.Errorf("progressOf = %+v, want %+v", *got, want)
	}
	// A phase with nothing to measure reports its name and nothing else, which
	// is what keeps the JSON (and the queue page) free of zeroes that would
	// read as measurements.
	if got := progressOf(resim.ProgressState{Phase: resim.PhaseFetchingDemo}); *got != (jobProgress{State: resim.PhaseFetchingDemo}) {
		t.Errorf("progressOf(early phase) = %+v, want just the phase", *got)
	}
	if resimProgress(nil) != nil {
		t.Error("resimProgress(nil) must be nil — the catalog scan has no job row to report onto")
	}
}

// waitForBeats blocks until the mock has recorded n "processing" transitions.
func waitForBeats(ctx context.Context, m *mockWorker, n int) bool {
	for {
		m.mu.Lock()
		beats := 0
		for _, tr := range m.transitions {
			if tr == "processing" {
				beats++
			}
		}
		m.mu.Unlock()
		if beats >= n {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(time.Millisecond):
		}
	}
}

// A pipeline failure reports state=error with the message; the loop survives.
func TestRunOnceReportsFailure(t *testing.T) {
	m := newMock(t)
	srv := httptest.NewServer(m.handler(""))
	t.Cleanup(srv.Close)

	d := newDaemon(srv.URL, "", func(context.Context, string, *jobStats) error {
		return errors.New("demo exploded")
	})
	if _, err := d.runOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(m.transitions, ","); got != "processing,error:demo exploded" {
		t.Errorf("transitions = %q", got)
	}
}

// A missing archive object (404) is a job error, not a crash, and the process
// hook never runs.
func TestRunOnceDownloadFailure(t *testing.T) {
	m := newMock(t)
	m.job.StreamKey = "streams/" + m.job.GameID + "/gone.brepstream"
	srv := httptest.NewServer(m.handler(""))
	t.Cleanup(srv.Close)

	processed := false
	d := newDaemon(srv.URL, "", func(context.Context, string, *jobStats) error {
		processed = true
		return nil
	})
	if _, err := d.runOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if processed {
		t.Error("process ran despite the download failing")
	}
	if len(m.transitions) != 2 || m.transitions[0] != "processing" || !strings.HasPrefix(m.transitions[1], "error:downloading") {
		t.Errorf("transitions = %v", m.transitions)
	}
}

// A wrong token is a queue-level error the caller sees (nothing to retry into
// error states — the daemon simply cannot talk to the worker).
func TestRunOnceUnauthorized(t *testing.T) {
	m := newMock(t)
	srv := httptest.NewServer(m.handler("s3cret"))
	t.Cleanup(srv.Close)

	d := newDaemon(srv.URL, "wrong", func(context.Context, string, *jobStats) error { return nil })
	if _, err := d.runOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("err = %v, want a 401 listing error", err)
	}
	if len(m.transitions) != 0 {
		t.Errorf("transitions = %v, want none", m.transitions)
	}
}

// A published replay is followed by the same size report `pack -stats`
// prints, and it goes to stderr so the tee'd log file keeps it. A .brp that
// cannot be measured is a warning, never a failure — the publish it belongs to
// has already succeeded by then.
func TestReportStats(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "abc123.brsnap")
	if err := os.WriteFile(in, []byte(statsCapture), 0o644); err != nil {
		t.Fatal(err)
	}
	brpPath, _, err := packer.Pack(context.Background(), nil, in, dir, "", true)
	if err != nil {
		t.Fatal(err)
	}

	if out := captureStderr(t, func() { reportStats(brpPath) }); !strings.Contains(out, "armcom") ||
		!strings.Contains(out, "top 1 unit defs") {
		t.Errorf("stats report missing the per-def breakdown:\n%s", out)
	}
	if out := captureStderr(t, func() { reportStats(filepath.Join(dir, "gone.brp")) }); !strings.Contains(out, "stats for") {
		t.Errorf("an unreadable .brp should warn, got %q", out)
	}
}

const statsCapture = `BRSNAP DEF {"id":1,"name":"armcom","humanName":"Armada Commander","maxHealth":3000}
BRSNAP T 0 0 armada #ff0000
BRSNAP READY
BRSNAP F 30 1.000 1
BRSNAP U 100 1 0 512.0 80.0 1024.0 3000.0 3000.0
BRSNAP F 60 2.000 1
BRSNAP U 100 1 0 512.0 80.0 1030.0 2900.0 3000.0
`

// captureStderr runs fn with os.Stderr redirected into a pipe and returns what
// it wrote — the same swap teeStderr performs in production.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stderr
	os.Stderr = w
	done := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	fn()
	os.Stderr = orig
	w.Close()
	return <-done
}
