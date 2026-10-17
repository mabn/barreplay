package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestPickAutoGame(t *testing.T) {
	s := func(v string) *string { return &v }
	games := []siteGame{
		{ID: "a1", Published: true},
		{ID: "b2", JobState: s("processing")},
		{ID: "c3", JobState: s("pending")},
		{ID: "d4"}, // tried here before
		{ID: "e5", JobState: s("error")},
		{ID: "f6"},
	}
	if got := pickAutoGame(games, map[string]bool{"d4": true}); got != "e5" {
		t.Fatalf("picked %q, want e5 (a failed site job is fair game)", got)
	}
	if got := pickAutoGame(games[:4], map[string]bool{"d4": true}); got != "" {
		t.Fatalf("picked %q from games that all have a replay or a job", got)
	}
}

func TestUploadBRP(t *testing.T) {
	body := []byte("BRP1\x06 not really a replay")
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/upload":
			gotBody, _ = io.ReadAll(r.Body)
			json.NewEncoder(w).Encode(map[string]string{"job": "j1", "gameId": "g"})
		case r.Method == http.MethodGet && r.URL.Path == "/api/jobs/j1":
			json.NewEncoder(w).Encode(map[string]string{"state": "done"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	t.Setenv("FOGOFWAR_SITE", srv.URL)

	p := filepath.Join(t.TempDir(), "g.brp")
	if err := os.WriteFile(p, body, 0o644); err != nil {
		t.Fatal(err)
	}
	var last int64
	job, err := uploadBRP(context.Background(), p, func(done, total int64) { last = done })
	if err != nil || job != "j1" {
		t.Fatalf("upload = %q, %v", job, err)
	}
	if string(gotBody) != string(body) || last != int64(len(body)) {
		t.Fatalf("sent %q, progress %d", gotBody, last)
	}
	if st, _, err := uploadJobState(context.Background(), "j1"); err != nil || st != "done" {
		t.Fatalf("state = %q, %v", st, err)
	}
	if replayURL("abc") != srv.URL+"/replays/abc" {
		t.Fatal(replayURL("abc"))
	}
}

func TestUploadBRPRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "not a .brp"})
	}))
	defer srv.Close()
	t.Setenv("FOGOFWAR_SITE", srv.URL)
	p := filepath.Join(t.TempDir(), "g.brp")
	os.WriteFile(p, []byte("x"), 0o644)
	if _, err := uploadBRP(context.Background(), p, nil); err == nil || err.Error() != "the site refused the upload: not a .brp" {
		t.Fatalf("err = %v", err)
	}
}
