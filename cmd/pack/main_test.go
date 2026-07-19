package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/viz"
	"github.com/mabn/barreplay/snapshot"
)

// fixtureGameID is the gameId inside internal/demofile's real sample demo.
const fixtureGameID = "836d486a5480a9e830be54db7d2c7be9"

// testStream is a minimal but well-formed widget stream: two frames 30 sim
// frames apart (so SampleEvery should be inferred as 30) and one event.
const testStream = `BRSNAP DEF {"id":1,"name":"armcom","humanName":"Armada Commander","maxHealth":3000}
BRSNAP T 0 0 armada #ff0000
BRSNAP READY
BRSNAP F 30 1.000 1
BRSNAP U 100 1 0 512.0 80.0 1024.0 3000.0 3000.0
BRSNAP F 60 2.000 1
BRSNAP U 100 1 0 512.0 80.0 1030.0 2900.0 3000.0
BRSNAP EV 58 destroyed 101 1 0
`

// mockBARClient serves the real .sdfz fixture behind a mock replay API, so the
// demo-metadata path runs end-to-end without the network.
func mockBARClient(t *testing.T) *barapi.Client {
	t.Helper()
	fixture, err := os.ReadFile(filepath.Join("..", "..", "internal", "demofile", "testdata", "sample_header.sdfz"))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/replays/"+fixtureGameID, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":"` + fixtureGameID + `","fileName":"sample.sdfz","engineVersion":"x","gameVersion":"y"}`))
	})
	mux.HandleFunc("/demos/sample.sdfz", func(w http.ResponseWriter, r *http.Request) {
		w.Write(fixture)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return barapi.New(barapi.WithBaseURLs(srv.URL, srv.URL+"/demos"))
}

// A .brsnap named after its gameId packs into a FULL .brp: map, versions and
// players seeded from the demo, sampling interval inferred from the stream.
func TestPackBRSNAPWithDemoMeta(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, fixtureGameID+".brsnap")
	if err := os.WriteFile(in, []byte(testStream), 0o644); err != nil {
		t.Fatal(err)
	}

	_, modOptions, err := pack(context.Background(), mockBARClient(t), in, dir, "", false, defaultTestPackOptions())
	if err != nil {
		t.Fatal(err)
	}
	meta, frames, events, err := readBRP(t, filepath.Join(dir, fixtureGameID+".brp"))
	if err != nil {
		t.Fatal(err)
	}
	if meta.GameID != fixtureGameID {
		t.Errorf("GameID = %q", meta.GameID)
	}
	if meta.MapName != "Isidis crack 1.1" {
		t.Errorf("MapName = %q, want the demo startscript's map", meta.MapName)
	}
	if meta.GameVersion == "" || meta.EngineVersion == "" {
		t.Errorf("versions not seeded: game %q engine %q", meta.GameVersion, meta.EngineVersion)
	}
	if len(meta.Players) == 0 {
		t.Error("players not seeded from the demo startscript")
	}
	if meta.SampleEvery != 30 {
		t.Errorf("SampleEvery = %d, want 30 (inferred from frame spacing)", meta.SampleEvery)
	}
	if len(frames) != 2 || len(events) != 1 {
		t.Errorf("frames/events = %d/%d, want 2/1", len(frames), len(events))
	}
	// The demo's raw modoptions ride back for the catalog PUT (never into the
	// .brp). The real fixture is a ranked game with everything else default, so
	// the derived settings are exactly {ranked: true}.
	if len(modOptions) == 0 {
		t.Fatal("modoptions not returned from the demo startscript")
	}
	if got := viz.SettingsFlags(modOptions); len(got) != 1 || got["ranked"] != true {
		t.Errorf("SettingsFlags(fixture modoptions) = %v, want map[ranked:true]", got)
	}
}

// -id overrides the file name as the gameId source.
func TestPackBRSNAPWithIDFlag(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "renamed-capture.brsnap")
	if err := os.WriteFile(in, []byte(testStream), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := pack(context.Background(), mockBARClient(t), in, dir, fixtureGameID, false, defaultTestPackOptions()); err != nil {
		t.Fatal(err)
	}
	meta, _, _, err := readBRP(t, filepath.Join(dir, "renamed-capture.brp"))
	if err != nil {
		t.Fatal(err)
	}
	if meta.MapName != "Isidis crack 1.1" {
		t.Errorf("MapName = %q", meta.MapName)
	}
	// The demo header's gameId is authoritative over the arbitrary file name.
	if meta.GameID != fixtureGameID {
		t.Errorf("GameID = %q", meta.GameID)
	}
}

// A file name that is not a gameId and no -id is a hard error (not a silent
// map-less .brp), pointing at -id / -no-demo.
func TestPackBRSNAPBadNameErrors(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "not-a-game-id.brsnap")
	if err := os.WriteFile(in, []byte(testStream), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, err := pack(context.Background(), mockBARClient(t), in, dir, "", false, defaultTestPackOptions())
	if err == nil || !strings.Contains(err.Error(), "-no-demo") {
		t.Fatalf("err = %v, want a gameId error mentioning the -no-demo escape hatch", err)
	}
}

// -no-demo keeps the old offline behaviour: a bare .brp, no network.
func TestPackBRSNAPNoDemo(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "not-a-game-id.brsnap")
	if err := os.WriteFile(in, []byte(testStream), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := pack(context.Background(), nil, in, dir, "", true, defaultTestPackOptions()); err != nil {
		t.Fatal(err)
	}
	meta, _, _, err := readBRP(t, filepath.Join(dir, "not-a-game-id.brp"))
	if err != nil {
		t.Fatal(err)
	}
	if meta.MapName != "" || len(meta.Players) != 0 {
		t.Errorf("no-demo pack should have no demo metadata, got map %q, %d players", meta.MapName, len(meta.Players))
	}
	if meta.GameID != "not-a-game-id" {
		t.Errorf("GameID = %q", meta.GameID)
	}
	if meta.SampleEvery != 30 {
		t.Errorf("SampleEvery = %d, want 30 (inferred)", meta.SampleEvery)
	}
}

func TestInferSampleEvery(t *testing.T) {
	fr := func(frames ...int32) []snapshot.Frame {
		out := make([]snapshot.Frame, len(frames))
		for i, f := range frames {
			out[i].Frame = f
		}
		return out
	}
	for _, tc := range []struct {
		frames []snapshot.Frame
		want   int32
	}{
		{fr(), 0},
		{fr(30), 0},
		{fr(30, 60, 90), 30},
		{fr(0, 15, 30), 15},
		{fr(30, 90, 120), 30}, // a gap doesn't inflate the interval
	} {
		if got := inferSampleEvery(tc.frames); got != tc.want {
			t.Errorf("inferSampleEvery(%v) = %d, want %d", tc.frames, got, tc.want)
		}
	}
}

// -stats on a packed .brp prints the section table and the per-def breakdown,
// with unit names resolved from the meta.
func TestPrintStats(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "not-a-game-id.brsnap")
	if err := os.WriteFile(in, []byte(testStream), 0o644); err != nil {
		t.Fatal(err)
	}
	brpPath, _, err := pack(context.Background(), nil, in, dir, "", true, defaultTestPackOptions())
	if err != nil {
		t.Fatal(err)
	}

	var buf strings.Builder
	if err := printStats(&buf, brpPath); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, want := range []string{
		"section",
		"K keyframes",
		"F frames",
		"top 1 unit defs",
		"armcom (Armada Commander)",
		"frame framing overhead",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("stats output missing %q:\n%s", want, out)
		}
	}
}

func readBRP(t *testing.T, path string) (snapshot.Meta, []snapshot.Frame, []snapshot.Event, error) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	return snapshot.ReadBRP(f)
}

// defaultTestPackOptions mirrors the CLI's flag defaults.
func defaultTestPackOptions() packOptions {
	return packOptions{commandsMode: "build"}
}
