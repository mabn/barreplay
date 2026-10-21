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
	plain := map[string]any{"ranked": true}
	games := []siteGame{
		{ID: "a1", Published: true, Settings: plain},
		{ID: "b2", JobState: s("processing"), Settings: plain},
		{ID: "c3", JobState: s("pending"), Settings: plain},
		{ID: "d4", Settings: plain}, // tried here before
		{ID: "m1", Settings: map[string]any{"ranked": true, "mods": true}},
		{ID: "m2", Settings: map[string]any{"lava": true, "mods": true}},
		{ID: "u1"}, // settings unknown: may be modded
		{ID: "e5", JobState: s("error"), Settings: map[string]any{"unranked": true}},
		{ID: "f6", Settings: plain},
	}
	if got := pickAutoGame(games, map[string]bool{"d4": true}); got != "e5" {
		t.Fatalf("picked %q, want e5 (unmodded; a failed site job is fair game)", got)
	}
	if got := pickAutoGame(games[:7], map[string]bool{"d4": true}); got != "" {
		t.Fatalf("picked %q from games that are modded or have a replay or a job", got)
	}
}

func TestGameTags(t *testing.T) {
	got := gameTags(map[string]any{"ranked": true, "lava": true, "mods": true, "noAir": true, "quickStart": "enabled", "zombies": "hard", "newFlag": "x"})
	want := []Tag{{"ranked", "ranked"}, {"lava", "lava"}, {"zombies", "zombies: hard"}, {"quickStart", "quick start"}, {"newFlag", "newFlag: x"}}
	if len(got) != len(want) {
		t.Fatalf("tags %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("tags %v, want %v", got, want)
		}
	}
	if m := gameTags(map[string]any{"mods": true}); len(m) != 1 || m[0].Label != "mods" {
		t.Fatalf("mods alone: %v", m)
	}
}

func TestUploadBRP(t *testing.T) {
	body := []byte("BRP1\x06 not really a replay")
	var gotBody []byte
	var gotInstall, gotAppJob string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/upload":
			gotBody, _ = io.ReadAll(r.Body)
			gotInstall = r.URL.Query().Get("install")
			gotAppJob = r.URL.Query().Get("appJob")
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
	job, err := uploadBRP(context.Background(), p, "0192-test", "0192-run", func(done, total int64) { last = done })
	if err != nil || job != "j1" {
		t.Fatalf("upload = %q, %v", job, err)
	}
	if gotInstall != "0192-test" || gotAppJob != "0192-run" {
		t.Fatalf("install = %q, appJob = %q", gotInstall, gotAppJob)
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
	if _, err := uploadBRP(context.Background(), p, "", "", nil); err == nil || err.Error() != "the site refused the upload: not a .brp" {
		t.Fatalf("err = %v", err)
	}
}
