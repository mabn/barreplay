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

// The static bundle must be byte-for-byte what the dynamic server serves: the
// .brw head == /api/replay, each c<i> == /api/replay/chunk?i=<i>, a Range on
// c<i> == the &key=1 skim, and .resources == /api/replay/resources. That
// equivalence is the whole point — the viewer can't tell R2 from the Go server.
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

	// Head and resources: byte-identical to the server.
	if !bytes.Equal(read("replays/g.brw"), get("/api/replay?file=g.brp")) {
		t.Error("g.brw != /api/replay")
	}
	// The stored .resources is plain JSON (the host compresses it in transit); the
	// server sends it gzipped with Content-Encoding: gzip, which Go's HTTP client
	// auto-inflates — so both decode to the same bytes.
	if !bytes.Equal(read("replays/g.resources"), get("/api/replay/resources?file=g.brp")) {
		t.Error("g.resources != /api/replay/resources")
	}

	// One chunk file per chunk; full == chunk endpoint, and its leading keyLen
	// bytes == the keyframe skim.
	head, _ := parseWire(t, read("replays/g.brw"))
	if len(head.Chunks) == 0 {
		t.Fatal("head has no chunks")
	}
	for i, c := range head.Chunks {
		cf := read(filepath.Join("replays", "g", "c"+itoa(i)))
		if !bytes.Equal(cf, get("/api/replay/chunk?file=g.brp&i="+itoa(i))) {
			t.Errorf("c%d != chunk endpoint", i)
		}
		// The keyframe skim is a Range bytes=0-(keyLen-1) on the same file.
		if !bytes.Equal(cf[:c.KeyLen], get("/api/replay/chunk?file=g.brp&i="+itoa(i)+"&key=1")) {
			t.Errorf("c%d[:keyLen] != keyframe skim", i)
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
