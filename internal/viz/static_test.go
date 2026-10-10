package viz

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// The static bundle is the viewer's whole backend: the .brw head and
// .resources must be exactly what the wire encoders produce, the .brp a byte
// copy of the capture, and the head's ranges must slice that copy into the
// stored keyframes and delta chunks — never a re-encode.
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
	brpBytes := read("replays/g.brp")
	src, err := os.ReadFile(brp)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(brpBytes, src) {
		t.Error("g.brp != the source .brp")
	}
	for _, gone := range []string{"replays/g.keys", "replays/g"} {
		if _, err := os.Stat(filepath.Join(out, gone)); !os.IsNotExist(err) {
			t.Errorf("%s: the split pieces must no longer be written", gone)
		}
	}

	// The head's ranges, applied to the published .brp, are exactly the stored
	// K section and each chunk's delta bytes — what the viewer Range-reads.
	head, _ := parseWire(t, read("replays/g.brw"))
	if head.Keys == nil {
		t.Fatal("head has no keys range")
	}
	if !bytes.Equal(brpBytes[head.Keys.Off:head.Keys.Off+head.Keys.Len], bf.Sections[snapshot.SecKeyframes]) {
		t.Error("keys range != the stored K section")
	}
	if len(head.Chunks) == 0 {
		t.Fatal("head has no chunks")
	}
	fsec := bf.Sections[snapshot.SecFrames]
	for i, c := range head.Chunks {
		fc := bf.Chunks[i]
		if c.Len == 0 {
			if c.Off != 0 {
				t.Errorf("c%d: single-frame chunk has an offset", i)
			}
			continue
		}
		if !bytes.Equal(brpBytes[c.Off:c.Off+c.Len], fsec[fc.FOff:fc.FOff+fc.FLen]) {
			t.Errorf("c%d range != the stored delta byte range", i)
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
