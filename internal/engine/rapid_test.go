package engine

import (
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func gzipBytes(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestSearchVersions(t *testing.T) {
	idx := "byar:git:abc123def0,md5a,,Beyond All Reason test-1-abc123d\n" +
		"byar:git:9876543210,md5b,,Beyond All Reason test-2-9876543\n"
	tag, md5, ok, err := searchVersions(bytes.NewReader(gzipBytes(t, idx)), "Beyond All Reason test-2-9876543")
	if err != nil || !ok || tag != "byar:git:9876543210" || md5 != "md5b" {
		t.Fatalf("searchVersions = %q md5=%q ok=%v err=%v", tag, md5, ok, err)
	}
	if _, _, ok, _ := searchVersions(bytes.NewReader(gzipBytes(t, idx)), "Nope"); ok {
		t.Error("should not match an absent springname")
	}
}

// TestResolveRapidGameTagCaches verifies the cache is written, reused on a hit,
// and refreshed exactly once on a miss.
func TestResolveRapidGameTagCaches(t *testing.T) {
	const springname = "Beyond All Reason test-1-abc123d"
	body := gzipBytes(t, "byar:git:abc123def0,md5,,"+springname+"\n")

	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/byar/versions.gz" {
			http.NotFound(w, r)
			return
		}
		atomic.AddInt32(&hits, 1)
		w.Write(body)
	}))
	defer srv.Close()

	dir := t.TempDir()
	e := &Engine{cfg: Config{DataDir: dir, RapidRepoMaster: srv.URL + "/repos.gz"}}
	ctx := context.Background()

	// 1. Cold cache -> one download, resolves (with md5).
	if tag, md5, ok := e.resolveRapidGameTag(ctx, springname); !ok || tag != "byar:git:abc123def0" || md5 != "md5" {
		t.Fatalf("cold lookup: tag=%q md5=%q ok=%v", tag, md5, ok)
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("cold lookup should download once, got %d", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "cache", "versions.gz")); err != nil {
		t.Fatalf("cache file not written: %v", err)
	}

	// 2. Same build again -> served from cache, no new download.
	if tag, _, ok := e.resolveRapidGameTag(ctx, springname); !ok || tag != "byar:git:abc123def0" {
		t.Fatalf("cached lookup: tag=%q ok=%v", tag, ok)
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("cache hit must not re-download, got %d downloads", got)
	}

	// 3. Unknown build absent from the cache -> exactly one refresh, still absent.
	if _, _, ok := e.resolveRapidGameTag(ctx, "Beyond All Reason test-2-deadbee"); ok {
		t.Fatal("unknown build should not resolve")
	}
	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Fatalf("cache miss must refresh once, got %d downloads", got)
	}
}
