package barapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

const sampleJSON = `{
  "id": "836d486a5480a9e830be54db7d2c7be9",
  "fileName": "2026-07-04_02-18-43-561_Isidis crack 1.1_2025.06.24.sdfz",
  "engineVersion": "2025.06.24",
  "gameVersion": "Beyond All Reason test-30541-1efcf40",
  "durationMs": 716233,
  "Map": { "scriptName": "Isidis crack 1.1", "fileName": "isidis_crack_1.1" }
}`

func TestParseGameID(t *testing.T) {
	const want = "836d486a5480a9e830be54db7d2c7be9"
	cases := []string{
		want,
		"836D486A5480A9E830BE54DB7D2C7BE9",
		"https://www.beyondallreason.info/replays?gameId=" + want,
		"https://api.bar-rts.com/replays/" + want,
	}
	for _, in := range cases {
		got, err := ParseGameID(in)
		if err != nil {
			t.Errorf("ParseGameID(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("ParseGameID(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := ParseGameID("not-a-replay"); err == nil {
		t.Error("expected error for junk input")
	}
}

func TestDownloadURLEscaping(t *testing.T) {
	c := New()
	got := c.DownloadURL("2026-07-04_02-18-43-561_Isidis crack 1.1_2025.06.24.sdfz")
	want := storageBase + "/2026-07-04_02-18-43-561_Isidis%20crack%201.1_2025.06.24.sdfz"
	if got != want {
		t.Errorf("DownloadURL:\n got %s\nwant %s", got, want)
	}
}

func TestResolveAndDownload(t *testing.T) {
	const demoBody = "PRETEND-SDFZ-BYTES"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/replays/836d486a5480a9e830be54db7d2c7be9":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(sampleJSON))
		case r.URL.Path == "/demos/2026-07-04_02-18-43-561_Isidis crack 1.1_2025.06.24.sdfz":
			// Go's test server decodes %20 back to spaces before matching.
			_, _ = w.Write([]byte(demoBody))
		default:
			http.Error(w, "not found: "+r.URL.Path, http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := New(WithBaseURLs(srv.URL, srv.URL+"/demos"))
	ctx := context.Background()

	rep, err := c.Resolve(ctx, "https://www.beyondallreason.info/replays?gameId=836d486a5480a9e830be54db7d2c7be9")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if rep.EngineVersion != "2025.06.24" {
		t.Errorf("EngineVersion = %q", rep.EngineVersion)
	}
	if rep.MapName() != "Isidis crack 1.1" {
		t.Errorf("MapName = %q", rep.MapName())
	}

	dir := t.TempDir()
	path, err := c.Download(ctx, rep, dir)
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if got := filepath.Base(path); got != rep.FileName {
		t.Errorf("downloaded base = %q, want %q", got, rep.FileName)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != demoBody {
		t.Errorf("body = %q, want %q", b, demoBody)
	}
}
