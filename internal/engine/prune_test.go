package engine

import (
	"bytes"
	"compress/gzip"
	"crypto/md5"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// pruneFixture builds a data dir: two game packages sharing one pool file,
// three maps, two demos, two engines, and the leftovers a crash leaves.
func pruneFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	put := func(rel string, size int, age time.Duration) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
		at := time.Now().Add(-age)
		os.Chtimes(p, at, at)
	}
	pool := func(name string) string {
		s := md5.Sum([]byte(name))
		return hex.EncodeToString(s[:])
	}
	pkg := func(rel string, age time.Duration, files ...string) {
		var raw bytes.Buffer
		for _, f := range files {
			raw.WriteByte(byte(len(f)))
			raw.WriteString(f)
			s := md5.Sum([]byte(f))
			raw.Write(s[:])
			raw.Write(make([]byte, 8))
		}
		var gz bytes.Buffer
		zw := gzip.NewWriter(&gz)
		zw.Write(raw.Bytes())
		zw.Close()
		put(rel, 0, age)
		os.WriteFile(filepath.Join(dir, rel), gz.Bytes(), 0o644)
		at := time.Now().Add(-age)
		os.Chtimes(filepath.Join(dir, rel), at, at)
	}
	for _, f := range []string{"shared", "old", "new", "orphan"} {
		h := pool(f)
		put("pool/"+h[:2]+"/"+h[2:]+".gz", 1000, 0)
	}
	pkg("packages/aaa.sdp", 10*time.Hour, "shared", "old")
	pkg("packages/bbb.sdp", time.Hour, "shared", "new")
	put("packages/ccc.sdp.incomplete", 500, 0)
	put("LuaUI/Config/barreplay/x.brepstream", 700, 0)
	put("maps/a.sd7", 2000, 9*time.Hour)
	put("maps/b.sd7", 2000, 8*time.Hour)
	put("maps/c.sd7", 2000, 2*time.Hour)
	put("demos/1.sdfz", 100, 20*time.Hour)
	put("demos/2.sdfz", 100, time.Hour)
	put("engine/old/spring-headless", 3000, 7*time.Hour)
	put("engine/new/spring-headless", 3000, time.Hour)
	os.Chtimes(filepath.Join(dir, "engine/old"), time.Now().Add(-7*time.Hour), time.Now().Add(-7*time.Hour))
	return dir
}

func TestPruneDataDirRemovesLeftoversOnly(t *testing.T) {
	dir := pruneFixture(t)
	res, err := PruneDataDir(dir, PruneOptions{Limit: 1 << 40})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"packages/ccc.sdp.incomplete", "LuaUI/Config/barreplay/x.brepstream", "pool (1 unused files)"}
	if !reflect.DeepEqual(res.Removed, want) {
		t.Fatalf("removed %q, want %q", res.Removed, want)
	}
	if res.Before-res.After != 500+700+1000 {
		t.Fatalf("freed %d", res.Before-res.After)
	}
}

func TestPruneDataDirOldestFirstKeepsNewest(t *testing.T) {
	dir := pruneFixture(t)
	res, err := PruneDataDir(dir, PruneOptions{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"packages/ccc.sdp.incomplete", "LuaUI/Config/barreplay/x.brepstream", "pool (1 unused files)",
		"demos/1.sdfz",
		"packages/aaa.sdp", "pool (1 unused files)",
		"maps/a.sd7", "maps/b.sd7", "engine/old",
	}
	if !reflect.DeepEqual(res.Removed, want) {
		t.Fatalf("removed %q,\nwant %q", res.Removed, want)
	}
	for _, keep := range []string{"packages/bbb.sdp", "maps/c.sd7", "demos/2.sdfz", "engine/new/spring-headless"} {
		if _, err := os.Stat(filepath.Join(dir, keep)); err != nil {
			t.Errorf("%s was removed", keep)
		}
	}
	got, _ := dirSize(dir)
	if got != res.After {
		t.Fatalf("After = %d, on disk %d", res.After, got)
	}
}

func TestPruneDataDirStopsAtLimitAndKeepsEngines(t *testing.T) {
	dir := pruneFixture(t)
	before, _ := dirSize(dir)
	// Leftovers free 2200; then the demo 100, the old package (+ its pool
	// file 1000), and map a's 2000 brings it under.
	fi, _ := os.Stat(filepath.Join(dir, "packages", "aaa.sdp"))
	limit := before - 2200 - 100 - fi.Size() - 1000 - 2000
	res, err := PruneDataDir(dir, PruneOptions{Limit: limit, KeepEngines: []string{"old"}})
	if err != nil {
		t.Fatal(err)
	}
	last := res.Removed[len(res.Removed)-1]
	if last != "maps/a.sd7" || res.After > limit {
		t.Fatalf("removed %q, after %d > %d", res.Removed, res.After, limit)
	}
	res, _ = PruneDataDir(dir, PruneOptions{Limit: 1, KeepEngines: []string{"old"}})
	for _, r := range res.Removed {
		if r == "engine/old" {
			t.Fatal("removed a kept engine")
		}
	}
}

func TestPruneDataDirSparesPoolWhenAPackageIsUnreadable(t *testing.T) {
	dir := pruneFixture(t)
	os.WriteFile(filepath.Join(dir, "packages", "zzz.sdp"), []byte("not gzip"), 0o644)
	res, _ := PruneDataDir(dir, PruneOptions{Limit: 1 << 40})
	for _, r := range res.Removed {
		if r == "pool (1 unused files)" {
			t.Fatal("cleaned the pool with an unreadable package")
		}
	}
}
