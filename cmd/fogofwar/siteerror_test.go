package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUserAgentOnEveryRequest(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.UserAgent())
		w.Write([]byte(`{"games":[]}`))
	}))
	defer srv.Close()
	t.Setenv("FOGOFWAR_SITE", srv.URL)
	installUserAgent()

	if _, err := fetchSiteGames(context.Background(), 10); err != nil {
		t.Fatal(err)
	}
	// Any client, not only the default one (barapi has its own).
	c := &http.Client{}
	resp, err := c.Get(srv.URL + "/x")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	want := "FogOfWar/" + version
	for i, ua := range got {
		if !strings.HasPrefix(ua, want+" ") {
			t.Fatalf("request %d sent User-Agent %q, want it to start with %q", i, ua, want)
		}
	}
	if len(got) != 2 {
		t.Fatalf("%d requests seen, want 2", len(got))
	}
}

func TestSiteErrorOnWorkPoll(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUpgradeRequired)
		w.Write([]byte(`{"error":"Please upgrade FogOfWar to 0.3.0","url":"https://replay.fogofwar.dev/setup"}`))
	}))
	defer srv.Close()
	t.Setenv("FOGOFWAR_SITE", srv.URL)

	_, err := fetchSiteGames(context.Background(), 10)
	var se *siteError
	if !errors.As(err, &se) {
		t.Fatalf("error %v is not a siteError", err)
	}
	if se.Status != http.StatusUpgradeRequired || se.Message != "Please upgrade FogOfWar to 0.3.0" || se.URL != "https://replay.fogofwar.dev/setup" {
		t.Fatalf("siteError %+v", se)
	}
	if !se.upgrade() {
		t.Fatal("426 should read as an upgrade request")
	}
}

func TestSiteErrorWithoutMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "<html>bad gateway</html>", http.StatusBadGateway)
	}))
	defer srv.Close()
	t.Setenv("FOGOFWAR_SITE", srv.URL)

	_, err := fetchSiteGames(context.Background(), 10)
	var se *siteError
	if err == nil || errors.As(err, &se) {
		t.Fatalf("a bare 502 must be a plain error, not a message from the site: %v", err)
	}
}

func TestAutoStepShowsSiteMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUpgradeRequired)
		w.Write([]byte(`{"error":"Please upgrade FogOfWar","url":"https://replay.fogofwar.dev/setup"}`))
	}))
	defer srv.Close()
	t.Setenv("FOGOFWAR_SITE", srv.URL)

	a := NewApp(t.TempDir(), Config{Stored: Stored{AutoReplay: true}}, &logTee{})
	a.autoStep()
	if a.siteMsg == nil || a.siteMsg.Message != "Please upgrade FogOfWar" {
		t.Fatalf("siteMsg %+v", a.siteMsg)
	}
	if !strings.HasPrefix(a.autoNote, "Paused by replay.fogofwar.dev") {
		t.Fatalf("autoNote %q does not say the site paused it", a.autoNote)
	}
	if !a.cfg.AutoReplay {
		t.Fatal("a site message must not switch auto-replay off; it resumes once the site lets it")
	}
}
