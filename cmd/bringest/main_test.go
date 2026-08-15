package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/mabn/barreplay/snapshot"
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
	return &daemon{
		indexURL: url, token: token, client: http.DefaultClient,
		process: func(ctx context.Context, streamPath string) (bool, error) {
			return false, process(ctx, streamPath)
		},
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

// -resim wiring: a one-sided publish triggers the resim hook AFTER the done
// report; a resim failure stays a log line (the job is already done). A
// process reporting oneSided=false, or a daemon without the hook, never
// resims.
func TestRunOnceResim(t *testing.T) {
	cases := []struct {
		name      string
		oneSided  bool
		resimErr  error
		hook      bool
		wantResim bool
	}{
		{"one-sided with hook", true, nil, true, true},
		{"one-sided, resim fails", true, errors.New("no engine"), true, true},
		{"full-view capture", false, nil, true, false},
		{"no hook (flag off)", true, nil, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := newMock(t)
			srv := httptest.NewServer(m.handler(""))
			t.Cleanup(srv.Close)

			var resimGame string
			var doneBeforeResim bool
			d := &daemon{
				indexURL: srv.URL, client: http.DefaultClient,
				process: func(context.Context, string) (bool, error) { return c.oneSided, nil },
			}
			if c.hook {
				d.resim = func(_ context.Context, gameID string) error {
					resimGame = gameID
					m.mu.Lock()
					doneBeforeResim = len(m.transitions) == 2 && m.transitions[1] == "done"
					m.mu.Unlock()
					return c.resimErr
				}
			}
			if _, err := d.runOnce(context.Background()); err != nil {
				t.Fatal(err)
			}
			if got := resimGame != ""; got != c.wantResim {
				t.Fatalf("resim ran = %v, want %v", got, c.wantResim)
			}
			if c.wantResim {
				if resimGame != m.job.GameID {
					t.Errorf("resim gameID = %q, want %q", resimGame, m.job.GameID)
				}
				if !doneBeforeResim {
					t.Errorf("resim ran before the done report (transitions %v)", m.transitions)
				}
			}
			// The job outcome is done in every case — resim never fails a job.
			if got := strings.Join(m.transitions, ","); got != "processing,done" {
				t.Errorf("transitions = %q, want processing,done", got)
			}
		})
	}
}

// One-sided means: the capture's meta names a PLAYING recorder. Spectator
// recordings and re-sim captures (no recorder at all) are full-view already.
func TestCaptureIsOneSided(t *testing.T) {
	write := func(t *testing.T, rec *snapshot.RecorderInfo) string {
		dir := t.TempDir()
		w, err := snapshot.NewBRPWriter(dir, "g")
		if err != nil {
			t.Fatal(err)
		}
		if err := w.WriteMeta(snapshot.Meta{GameID: "g", SampleEvery: 30, Recorder: rec}); err != nil {
			t.Fatal(err)
		}
		if err := w.Close(); err != nil {
			t.Fatal(err)
		}
		return filepath.Join(dir, "g.brp")
	}
	if !captureIsOneSided(write(t, &snapshot.RecorderInfo{PlayerID: 3, AllyTeam: 1})) {
		t.Error("playing recorder: want one-sided")
	}
	if captureIsOneSided(write(t, &snapshot.RecorderInfo{PlayerID: 3, Spectator: true})) {
		t.Error("spectator recorder: want full view")
	}
	if captureIsOneSided(write(t, nil)) {
		t.Error("no recorder (re-sim): want full view")
	}
	if captureIsOneSided(filepath.Join(t.TempDir(), "missing.brp")) {
		t.Error("unreadable file: want false")
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
