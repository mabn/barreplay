package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

// mockWorker fakes the worker's job/stream API surface: one pending job whose
// archived stream it serves, recording every state transition.
type mockWorker struct {
	t       *testing.T
	job     ingestJob
	stream  []byte
	drained bool // pending queue empties after the first list

	mu          sync.Mutex
	transitions []string // "<state>[:<error>]"
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
		m.mu.Lock()
		drained := m.drained
		m.drained = true
		m.mu.Unlock()
		jobs := []ingestJob{}
		if !drained {
			jobs = append(jobs, m.job)
		}
		json.NewEncoder(w).Encode(jobs)
	})
	mux.HandleFunc("POST /api/jobs/", func(w http.ResponseWriter, r *http.Request) {
		if !authed(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct{ State, Error string }
		json.NewDecoder(r.Body).Decode(&body)
		m.mu.Lock()
		tr := body.State
		if body.Error != "" {
			tr += ":" + body.Error
		}
		m.transitions = append(m.transitions, tr)
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
			State:     "pending",
		},
		stream: []byte("BREPSTREAM 1\nBRSNAP GID feed5eed00000000000000000000beef\nBRSNAP READY\n"),
	}
}

func newDaemon(url, token string, process func(ctx context.Context, streamPath string) error) *daemon {
	return &daemon{indexURL: url, token: token, client: http.DefaultClient, process: process}
}

// The happy path: claim -> download -> process -> done, with the bearer token
// on every call and the stream delivered byte-for-byte under its gameId name.
func TestRunOnceProcessesJob(t *testing.T) {
	m := newMock(t)
	srv := httptest.NewServer(m.handler("s3cret"))
	t.Cleanup(srv.Close)

	var gotPath string
	var gotBytes []byte
	d := newDaemon(srv.URL, "s3cret", func(_ context.Context, streamPath string) error {
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
		if r.URL.Path != "/api/replays" {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(catalog)
	}))
	t.Cleanup(srv.Close)

	var ran []string
	r := &resimDaemon{
		indexURL: srv.URL,
		client:   http.DefaultClient,
		failed:   map[string]bool{},
		resim: func(_ context.Context, gameID string) error {
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

// A pipeline failure reports state=error with the message; the loop survives.
func TestRunOnceReportsFailure(t *testing.T) {
	m := newMock(t)
	srv := httptest.NewServer(m.handler(""))
	t.Cleanup(srv.Close)

	d := newDaemon(srv.URL, "", func(context.Context, string) error {
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
	d := newDaemon(srv.URL, "", func(context.Context, string) error {
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

	d := newDaemon(srv.URL, "wrong", func(context.Context, string) error { return nil })
	if _, err := d.runOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("err = %v, want a 401 listing error", err)
	}
	if len(m.transitions) != 0 {
		t.Errorf("transitions = %v, want none", m.transitions)
	}
}
