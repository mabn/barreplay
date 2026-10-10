package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/mabn/barreplay/internal/insights"
	"github.com/mabn/barreplay/internal/packer"
)

// countingBucket serves a one-row catalog naming rowRid plus the files under
// root, and counts the bucket reads that found something.
type countingBucket struct {
	*httptest.Server
	mu   sync.Mutex
	hits []string // paths answered 200
}

func newCountingBucket(t *testing.T, root, rowRid string) *countingBucket {
	t.Helper()
	cb := &countingBucket{}
	cb.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/replays" {
			json.NewEncoder(w).Encode([]map[string]any{{"id": gameID, "rid": rowRid}})
			return
		}
		b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/"))))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		cb.mu.Lock()
		cb.hits = append(cb.hits, r.URL.Path)
		cb.mu.Unlock()
		w.Write(b)
	}))
	t.Cleanup(cb.Close)
	return cb
}

// downloads returns the paths downloaded since the last call.
func (cb *countingBucket) downloads() []string {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	h := cb.hits
	cb.hits = nil
	return h
}

// A month-folder main replay (PR #83's replays/<YYYY-MM>/<gameId>.brp): the
// first run downloads its .brp, and neither collecting the published file nor
// recomputing it downloads anything again.
func TestCacheReusesDownloads(t *testing.T) {
	monthRid := "2026-10/" + gameID
	bucket := t.TempDir()
	brp := writeBRP(t, t.TempDir())
	b, err := os.ReadFile(brp)
	if err != nil {
		t.Fatal(err)
	}
	key := filepath.Join(bucket, "replays", "2026-10", gameID+".brp")
	os.MkdirAll(filepath.Dir(key), 0o755)
	os.WriteFile(key, b, 0o644)
	srv := newCountingBucket(t, bucket, monthRid)
	cache := t.TempDir()
	run := func(out string, publish bool, force bool) *runner {
		r := &runner{indexURL: srv.URL, dataURL: srv.URL, http: srv.Client(), outDir: out, force: force, cache: &objectCache{dir: cache}}
		if publish {
			r.publish = func(context.Context, string, string) error { return nil }
		}
		if err := r.one(context.Background(), gameID); err != nil {
			t.Fatal(err)
		}
		return r
	}

	run("", true, false)
	if got := srv.downloads(); len(got) != 1 || got[0] != "/replays/2026-10/"+gameID+".brp" {
		t.Fatalf("first run downloaded %v, want just the .brp", got)
	}
	for _, k := range []string{"replays/2026-10/" + gameID + ".brp", "replays/" + insights.FileName(monthRid)} {
		if _, err := os.Stat(filepath.Join(cache, filepath.FromSlash(k))); err != nil {
			t.Errorf("not cached: %s (%v)", k, err)
		}
	}

	out := t.TempDir()
	r := run(out, false, false)
	if got := srv.downloads(); len(got) != 0 {
		t.Errorf("collecting the published file downloaded %v", got)
	}
	if _, err := os.Stat(filepath.Join(out, "replays", insights.FileName(monthRid))); err != nil {
		t.Errorf("compute-only did not save the cached file: %v", err)
	}
	if r.cache.hits != 1 {
		t.Errorf("cache hits = %d, want 1", r.cache.hits)
	}

	run(t.TempDir(), false, true)
	if got := srv.downloads(); len(got) != 0 {
		t.Errorf("-force recompute downloaded %v", got)
	}
}

// An old replay rebuilt from its pieces: a second run downloads none of them.
func TestCacheReusesPieces(t *testing.T) {
	srv := newCountingBucket(t, legacyBucket(t), rid)
	cache := t.TempDir()
	for i := 0; i < 2; i++ {
		r := &runner{indexURL: srv.URL, dataURL: srv.URL, http: srv.Client(), outDir: t.TempDir(), force: true, cache: &objectCache{dir: cache}}
		if err := r.one(context.Background(), gameID); err != nil {
			t.Fatal(err)
		}
		got := srv.downloads()
		if i == 0 && len(got) < 3 {
			t.Fatalf("first run downloaded only %v", got)
		}
		if i == 1 && len(got) != 0 {
			t.Errorf("second run downloaded %v", got)
		}
	}
}

// -j shares one cache between the replays in flight: they race on the same
// keys without tearing a file or losing a count, and the next run downloads
// nothing.
func TestCacheUnderParallelRuns(t *testing.T) {
	bucket := t.TempDir()
	writeBRP(t, filepath.Join(bucket, "replays"))
	srv := newCountingBucket(t, bucket, rid)
	cache := t.TempDir()
	args := []string{rid, rid, rid, rid, rid, rid, rid, rid}
	for i := 0; i < 2; i++ {
		r := &runner{indexURL: srv.URL, dataURL: srv.URL, http: srv.Client(), force: true, cache: &objectCache{dir: cache}}
		r.publish = func(context.Context, string, string) error { return nil }
		if failed := r.each(context.Background(), args, 4); failed != 0 {
			t.Fatalf("run %d: %d failed", i, failed)
		}
		got := srv.downloads()
		if i == 0 && len(got) == 0 {
			t.Fatal("first run downloaded nothing")
		}
		if i == 1 {
			if len(got) != 0 {
				t.Errorf("second run downloaded %v", got)
			}
			// Every replay read its .brp from disk and stored its summary.
			if r.cache.hits != len(args) || r.cache.stored != len(args) {
				t.Errorf("hits %d, stored %d; want %d each", r.cache.hits, r.cache.stored, len(args))
			}
		}
	}
	left, _ := filepath.Glob(filepath.Join(cache, "replays", ".part-*"))
	if len(left) != 0 {
		t.Errorf("temporary files left behind: %v", left)
	}
}

// A summary that failed to publish is not remembered as published.
func TestCacheSkipsFailedPublish(t *testing.T) {
	bucket := t.TempDir()
	writeBRP(t, filepath.Join(bucket, "replays"))
	srv := newCountingBucket(t, bucket, rid)
	cache := t.TempDir()
	r := &runner{indexURL: srv.URL, dataURL: srv.URL, http: srv.Client(), cache: &objectCache{dir: cache}}
	r.publish = func(context.Context, string, string) error { return errors.New("down") }
	if err := r.one(context.Background(), gameID); err == nil {
		t.Fatal("want the publish error")
	}
	if _, err := os.Stat(filepath.Join(cache, "replays", insights.FileName(rid))); !os.IsNotExist(err) {
		t.Errorf("unpublished summary cached (%v)", err)
	}
}

func TestCacheKeys(t *testing.T) {
	c := &objectCache{dir: "/c"}
	for _, k := range []string{"", "/replays/x.brp", "../x", "replays/../../x", "replays//x", "replays/./x", ".", "..", "replays/../x"} {
		if p := c.file(k); p != "" {
			t.Errorf("file(%q) = %q, want refused", k, p)
		}
	}
	if p := c.file("replays/2026-10/" + gameID + ".brp"); p != filepath.Join("/c", "replays", "2026-10", gameID+".brp") {
		t.Errorf("month key -> %q", p)
	}
	var none *objectCache
	if _, ok := none.get("replays/x"); ok {
		t.Error("nil cache hit")
	}
	none.put("replays/x", []byte("x")) // must not panic

	r2, _ := packer.LookupTarget("r2")
	local, _ := packer.LookupTarget("local")
	if d := cacheDir("", r2); d != "" {
		t.Errorf("empty -cache = %q", d)
	}
	if d := cacheDir("auto", local); d != "" {
		t.Errorf("auto caches the simulator: %q", d)
	}
	if d := cacheDir("/x", r2); d != filepath.Join("/x", "cdn-bar.fogofwar.dev") {
		t.Errorf("r2 dir = %q", d)
	}
	if d := cacheDir("/x", local); d != filepath.Join("/x", "127.0.0.1_5173") {
		t.Errorf("local dir = %q", d)
	}
}
