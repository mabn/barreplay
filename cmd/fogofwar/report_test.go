package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mabn/barreplay/internal/resim"
)

func TestNewInstallIDIsUUIDv7(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	a, b := newInstallID(), newInstallID()
	if !re.MatchString(a) || a == b {
		t.Fatalf("ids %q %q", a, b)
	}
	// The first 48 bits are the time in milliseconds.
	ms := time.Now().UnixMilli()
	got := strings.ReplaceAll(a, "-", "")[:12]
	var v int64
	for _, c := range got {
		v = v<<4 | int64(strings.IndexRune("0123456789abcdef", c))
	}
	if d := ms - v; d < 0 || d > 5000 {
		t.Fatalf("time prefix %d vs now %d", v, ms)
	}
}

// A run is created in the queue, beats with its progress and ends with its
// stats, over the app's own routes.
func TestQueueJobReportsTheRun(t *testing.T) {
	var mu sync.Mutex
	var calls []map[string]any
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		json.Unmarshal(b, &m)
		mu.Lock()
		calls, paths = append(calls, m), append(paths, r.URL.Path)
		mu.Unlock()
		if r.URL.Path == "/api/app/jobs" {
			json.NewEncoder(w).Encode(map[string]string{"job": "app1"})
			return
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	t.Setenv("FOGOFWAR_SITE", srv.URL)
	old := reportEvery
	reportEvery = 20 * time.Millisecond
	defer func() { reportEvery = old }()

	a := NewApp(t.TempDir(), Config{InstallID: "0192aaaa-0000-7000-8000-000000000000", MinFreeMB: 512}, &logTee{})
	run := &jobRun{gameID: "abc", progress: &resim.Progress{}, stats: &resim.RunStats{}, started: time.Now(), auto: true}
	run.progress.SetPhase(resim.PhaseSimulating)
	q := a.startQueueJob(run, a.config())
	time.Sleep(100 * time.Millisecond)
	q.finish(&jobStats{TookSec: 1}, "", "")

	mu.Lock()
	defer mu.Unlock()
	if paths[0] != "/api/app/jobs" || calls[0]["installId"] != "0192aaaa-0000-7000-8000-000000000000" || calls[0]["gameId"] != "abc" {
		t.Fatalf("create = %s %v", paths[0], calls[0])
	}
	app := calls[0]["stats"].(map[string]any)["app"].(map[string]any)
	if app["name"] != "FogOfWar" || app["auto"] != true {
		t.Fatalf("app = %v", app)
	}
	if len(calls) < 3 || paths[1] != "/api/app/jobs/app1" || calls[1]["state"] != "processing" {
		t.Fatalf("beats = %v %v", paths, calls)
	}
	if p := calls[1]["progress"].(map[string]any); p["state"] != resim.PhaseSimulating {
		t.Fatalf("progress = %v", p)
	}
	last := calls[len(calls)-1]
	if last["state"] != "done" {
		t.Fatalf("final = %v", last)
	}
	st := last["stats"].(map[string]any)
	if st["host"] == nil || st["app"] == nil || st["phases"] == nil {
		t.Fatalf("final stats = %v", st)
	}
}

func TestNotePhaseTimesEachPhase(t *testing.T) {
	t0 := time.Unix(1000, 0)
	q := &queueJob{}
	q.notePhase("fetching demo", t0)
	q.notePhase("fetching demo", t0.Add(time.Second))
	q.notePhase("simulating", t0.Add(3*time.Second))
	q.notePhase("", t0.Add(10*time.Second))
	want := []phaseTime{{"fetching demo", 3}, {"simulating", 7}}
	if len(q.phases) != 2 || q.phases[0] != want[0] || q.phases[1] != want[1] {
		t.Fatalf("phases = %v", q.phases)
	}
}

// A run shorter than one report interval still leaves two readings — one as
// it starts and one as it ends — so its queue row has a chart rather than a
// dot (Marcin: "at least 2 data points").
func TestQueueJobBeatsAtStartAndEnd(t *testing.T) {
	var mu sync.Mutex
	var states []string
	var progress []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		json.Unmarshal(b, &m)
		if r.URL.Path == "/api/app/jobs" {
			json.NewEncoder(w).Encode(map[string]string{"job": "app1"})
			return
		}
		mu.Lock()
		states = append(states, fmt.Sprint(m["state"]))
		p, _ := m["progress"].(map[string]any)
		progress = append(progress, p)
		mu.Unlock()
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	t.Setenv("FOGOFWAR_SITE", srv.URL)
	old := reportEvery
	reportEvery = time.Hour
	defer func() { reportEvery = old }()

	a := NewApp(t.TempDir(), Config{InstallID: "0192aaaa-0000-7000-8000-000000000000"}, &logTee{})
	run := &jobRun{gameID: "abc", progress: &resim.Progress{}, stats: &resim.RunStats{}, started: time.Now()}
	run.progress.SetPhase(resim.PhaseLoading)
	q := a.startQueueJob(run, a.config())
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		n := len(states)
		mu.Unlock()
		if n >= 1 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	run.progress.SetPhase(resim.PhaseSimulating)
	q.finish(&jobStats{TookSec: 1}, "", "")

	mu.Lock()
	defer mu.Unlock()
	if len(states) != 3 || states[0] != "processing" || states[1] != "processing" || states[2] != "done" {
		t.Fatalf("reports = %v, want processing (start), processing (end), done", states)
	}
	if progress[0]["state"] != resim.PhaseLoading || progress[1]["state"] != resim.PhaseSimulating {
		t.Fatalf("readings = %v, want the start's phase then the end's", progress[:2])
	}
}
