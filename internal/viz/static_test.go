package viz

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// The static bundle is the viewer's whole backend: the .brw head, the .keys
// stream, each delta chunk c<i>, and .resources must be exactly what the wire
// encoders produce and what the stored .brp holds — a byte copy, never a
// re-encode.
func TestStaticBundleMatchesWire(t *testing.T) {
	dir := t.TempDir()
	brp := writeBRP(t, dir, "g")

	f, err := os.Open(brp)
	if err != nil {
		t.Fatal(err)
	}
	bf, err := snapshot.ParseBRP(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	wantHead, err := brpWirePayload(bf)
	if err != nil {
		t.Fatal(err)
	}
	wantRes, err := brpResourcesJSON(bf)
	if err != nil {
		t.Fatal(err)
	}

	// Pack the capture into a static bundle.
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

	if !bytes.Equal(read("replays/g.brw"), wantHead) {
		t.Error("g.brw != brpWirePayload")
	}
	if !bytes.Equal(read("replays/g.resources"), wantRes) {
		t.Error("g.resources != brpResourcesJSON")
	}
	if !bytes.Equal(read("replays/g.keys"), bf.Sections[snapshot.SecKeyframes]) {
		t.Error("g.keys != the stored K section")
	}

	// One chunk file per chunk with delta bytes; file == the stored byte range.
	head, _ := parseWire(t, read("replays/g.brw"))
	if len(head.Chunks) == 0 {
		t.Fatal("head has no chunks")
	}
	fsec := bf.Sections[snapshot.SecFrames]
	for i, c := range head.Chunks {
		if c.Len == 0 {
			if _, err := os.Stat(filepath.Join(out, "replays", "g", "c"+itoa(i))); !os.IsNotExist(err) {
				t.Errorf("c%d: single-frame chunk must have no delta file", i)
			}
			continue
		}
		cf := read(filepath.Join("replays", "g", "c"+itoa(i)))
		fc := bf.Chunks[i]
		if !bytes.Equal(cf, fsec[fc.FOff:fc.FOff+fc.FLen]) {
			t.Errorf("c%d != the stored delta byte range", i)
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
