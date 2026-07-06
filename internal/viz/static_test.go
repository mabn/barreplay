package viz

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// The static bundle must be byte-for-byte what the dynamic server serves at
// the same URLs: .brw head, .keys, each delta chunk c<i>, and .resources.
// That equivalence is the whole point — the viewer can't tell R2 from the Go
// server.
func TestStaticBundleMatchesServer(t *testing.T) {
	dir := t.TempDir()
	brp := writeBRP(t, dir, "g")

	// Dynamic server responses (the reference bytes).
	srv := httptest.NewServer((&Server{Dir: dir}).Handler())
	defer srv.Close()
	get := func(url string) []byte {
		t.Helper()
		resp, err := http.Get(srv.URL + url)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s: %d: %s", url, resp.StatusCode, b)
		}
		return b
	}

	// Pack the same capture into a static bundle.
	out := t.TempDir()
	id, err := WriteStaticBundle(brp, out)
	if err != nil {
		t.Fatal(err)
	}
	if id != "g" {
		t.Fatalf("gameId = %q, want g", id)
	}
	n, err := WriteIndex(out)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("index has %d replays, want 1", n)
	}
	read := func(rel string) []byte {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(out, rel))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	// Head, resources and keys: byte-identical to the server (the URL scheme is
	// shared, so the static object IS the endpoint's response body).
	if !bytes.Equal(read("replays/g.brw"), get("/replays/g.brw")) {
		t.Error("g.brw != /replays/g.brw")
	}
	// The stored .resources is plain JSON (the host compresses it in transit); the
	// server sends it gzipped with Content-Encoding: gzip, which Go's HTTP client
	// auto-inflates — so both decode to the same bytes.
	if !bytes.Equal(read("replays/g.resources"), get("/replays/g.resources")) {
		t.Error("g.resources != /replays/g.resources")
	}
	if !bytes.Equal(read("replays/g.keys"), get("/replays/g.keys")) {
		t.Error("g.keys != /replays/g.keys")
	}

	// One chunk file per chunk with delta bytes; file == chunk endpoint.
	head, _ := parseWire(t, read("replays/g.brw"))
	if len(head.Chunks) == 0 {
		t.Fatal("head has no chunks")
	}
	for i, c := range head.Chunks {
		if c.Len == 0 {
			if _, err := os.Stat(filepath.Join(out, "replays", "g", "c"+itoa(i))); !os.IsNotExist(err) {
				t.Errorf("c%d: single-frame chunk must have no delta file", i)
			}
			continue
		}
		cf := read(filepath.Join("replays", "g", "c"+itoa(i)))
		if !bytes.Equal(cf, get("/replays/g/c"+itoa(i))) {
			t.Errorf("c%d != chunk endpoint", i)
		}
	}

	// index.json is valid and points at the bundle key.
	var idx []StaticReplay
	if err := json.Unmarshal(read("index.json"), &idx); err != nil {
		t.Fatal(err)
	}
	if len(idx) != 1 || idx[0].File != "g" || idx[0].GameID != "g" || idx[0].Size <= 0 {
		t.Fatalf("index.json = %+v", idx)
	}
}

func itoa(i int) string { return string(rune('0' + i)) } // single-digit chunk indices in the test
