package packer

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The signer must produce byte-for-byte what aws4fetch produces — the signer
// the worker's TS tooling uses successfully against R2. Fixture generated
// with aws4fetch 1.x:
//
//	new AwsClient({accessKeyId, secretAccessKey, service: "s3", region: "auto"})
//	  .sign(url, {method: "PUT", body, aws: {datetime: "20260719T120000Z"}})
func TestSignMatchesAws4fetch(t *testing.T) {
	c := &R2Client{
		Bucket:          "barreplay-replays",
		AccessKeyID:     "AKIDEXAMPLEKEYID0000",
		SecretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		Endpoint:        "https://9a1829e6502587e153ffa45b76de7ed3.r2.cloudflarestorage.com",
		now:             func() time.Time { return time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC) },
	}
	req, err := http.NewRequest(http.MethodPut,
		c.Endpoint+"/"+uriEncodePath(c.Bucket+"/replays/feed5eed00000000000000000000beef-3fdb5027/c1"),
		strings.NewReader("hello r2 sigv4"))
	if err != nil {
		t.Fatal(err)
	}
	c.sign(req)

	want := map[string]string{
		"Authorization":        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLEKEYID0000/20260719/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=01c48cd18a6e6b01b8d8ce2e5ff6e3ac62d1aae7b6b1802e339f276af6dfb55f",
		"x-amz-content-sha256": "UNSIGNED-PAYLOAD",
		"x-amz-date":           "20260719T120000Z",
	}
	for k, v := range want {
		if got := req.Header.Get(k); got != v {
			t.Errorf("%s =\n  %q\nwant\n  %q", k, got, v)
		}
	}
}

func TestURIEncodePath(t *testing.T) {
	for in, want := range map[string]string{
		"bucket/replays/abc-12345678/c1": "bucket/replays/abc-12345678/c1",
		"bucket/a b+c":                   "bucket/a%20b%2Bc",
		"bucket/x~y._-z":                 "bucket/x~y._-z",
	} {
		if got := uriEncodePath(in); got != want {
			t.Errorf("uriEncodePath(%q) = %q, want %q", in, got, want)
		}
	}
}

// writeBundle lays out a fake static bundle: three body objects + one .brw.
func writeBundle(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, f := range []string{"replays/id-1/c0", "replays/id-1/c1", "replays/id-1.keys", "replays/id-1.brw"} {
		p := filepath.Join(dir, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("data:"+f), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// UploadBundle must upload every file, signed, with the .brw head strictly
// after every other object has COMPLETED (the listing-marker barrier). The
// barrier is observable server-side: a body handler only counts itself
// completed on return, and it dawdles first — a premature head request would
// overtake the sleeping bodies and see a short count.
func TestUploadBundleBarrierAndAuth(t *testing.T) {
	var mu sync.Mutex
	var order []string
	var bodiesCompleted atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("method %s", r.Method)
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=key/") {
			t.Errorf("unsigned request to %s", r.URL.Path)
		}
		if strings.HasSuffix(r.URL.Path, ".brw") {
			if n := bodiesCompleted.Load(); n != 3 {
				t.Errorf(".brw arrived with only %d/3 bodies completed", n)
			}
		} else {
			time.Sleep(5 * time.Millisecond)
			defer bodiesCompleted.Add(1)
		}
		mu.Lock()
		order = append(order, strings.TrimPrefix(r.URL.Path, "/bkt/"))
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	c := &R2Client{Bucket: "bkt", AccessKeyID: "key", SecretAccessKey: "secret", Endpoint: srv.URL}
	if err := c.UploadBundle(context.Background(), writeBundle(t)); err != nil {
		t.Fatal(err)
	}
	if len(order) != 4 {
		t.Fatalf("uploaded %d objects, want 4: %v", len(order), order)
	}
	if order[len(order)-1] != "replays/id-1.brw" {
		t.Errorf("last object = %q, want the .brw head", order[len(order)-1])
	}
}

// A transient 500 is retried once; a persistent failure surfaces and no .brw
// head is uploaded after a body failed.
func TestPutRetriesOnceAndFailsClosed(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "hiccup", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	c := &R2Client{Bucket: "bkt", AccessKeyID: "k", SecretAccessKey: "s", Endpoint: srv.URL}
	if err := c.Put(context.Background(), "replays/x", []byte("d")); err != nil {
		t.Fatalf("retry should have recovered: %v", err)
	}
	if calls.Load() != 2 {
		t.Errorf("calls = %d, want 2 (one retry)", calls.Load())
	}

	var headPut atomic.Bool
	always500 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".brw") {
			headPut.Store(true)
		}
		http.Error(w, "down", http.StatusInternalServerError)
	}))
	t.Cleanup(always500.Close)
	c2 := &R2Client{Bucket: "bkt", AccessKeyID: "k", SecretAccessKey: "s", Endpoint: always500.URL}
	err := c2.UploadBundle(context.Background(), writeBundle(t))
	if err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("err = %v, want the 500 to surface", err)
	}
	if headPut.Load() {
		t.Error(".brw head was uploaded although a body wave failed")
	}
	var nonRetryable atomic.Int32
	forbidden := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nonRetryable.Add(1)
		http.Error(w, "no", http.StatusForbidden)
	}))
	t.Cleanup(forbidden.Close)
	c3 := &R2Client{Bucket: "bkt", AccessKeyID: "k", SecretAccessKey: "s", Endpoint: forbidden.URL}
	if err := c3.Put(context.Background(), "replays/x", []byte("d")); err == nil {
		t.Fatal("403 must fail")
	}
	if nonRetryable.Load() != 1 {
		t.Errorf("4xx retried (%d calls), want 1", nonRetryable.Load())
	}
}

// Credentials + account/bucket resolution: env vars win, wrangler.jsonc is
// the fallback, and missing pieces mean "use the node tooling" (nil).
func TestR2ClientFromEnv(t *testing.T) {
	dir := t.TempDir()
	jsonc := `{
  // comment to prove this is jsonc
  "account_id": "abc123",
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "prod-bucket", "preview_bucket_name": "preview-bucket" }]
}`
	if err := os.WriteFile(filepath.Join(dir, "wrangler.jsonc"), []byte(jsonc), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("R2_ACCESS_KEY_ID", "")
	t.Setenv("R2_SECRET_ACCESS_KEY", "")
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "")
	t.Setenv("R2_BUCKET", "")
	t.Setenv("R2_ENDPOINT", "")
	if c := r2ClientFromEnv(dir); c != nil {
		t.Error("no credentials must mean nil (node-tooling fallback)")
	}

	t.Setenv("R2_ACCESS_KEY_ID", "id")
	t.Setenv("R2_SECRET_ACCESS_KEY", "secret")
	c := r2ClientFromEnv(dir)
	if c == nil {
		t.Fatal("credentials + wrangler.jsonc should build a client")
	}
	if c.Endpoint != "https://abc123.r2.cloudflarestorage.com" || c.Bucket != "prod-bucket" {
		t.Errorf("endpoint/bucket = %s / %s", c.Endpoint, c.Bucket)
	}

	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "override")
	t.Setenv("R2_BUCKET", "other-bucket")
	c = r2ClientFromEnv(t.TempDir()) // no wrangler.jsonc needed when env is complete
	if c == nil || c.Endpoint != "https://override.r2.cloudflarestorage.com" || c.Bucket != "other-bucket" {
		t.Errorf("env overrides not honored: %+v", c)
	}

	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "")
	t.Setenv("R2_BUCKET", "")
	if c := r2ClientFromEnv(t.TempDir()); c != nil {
		t.Error("credentials without an account id must fall back to nil")
	}
}

// The whole native publish path end-to-end (hermetic): pack a stream, then
// UploadStatic with R2 credentials + R2_ENDPOINT pointed at a fake bucket —
// no node tooling runs (there is no worker dir at all). The pieces must land
// under the revisioned id and the catalog PUT must carry that rid.
func TestUploadStaticNative(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "somegameid.brsnap")
	if err := os.WriteFile(in, []byte(testStream), 0o644); err != nil {
		t.Fatal(err)
	}
	brpPath, _, err := Pack(context.Background(), nil, in, dir, "", true)
	if err != nil {
		t.Fatal(err)
	}
	rev, err := StreamRev(in)
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var putKeys []string
	bucket := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		putKeys = append(putKeys, strings.TrimPrefix(r.URL.Path, "/bkt/"))
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(bucket.Close)
	var catalogBody string
	index := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		catalogBody = string(b)
		w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(index.Close)

	t.Setenv("R2_ACCESS_KEY_ID", "id")
	t.Setenv("R2_SECRET_ACCESS_KEY", "secret")
	t.Setenv("R2_ENDPOINT", bucket.URL)
	t.Setenv("R2_BUCKET", "bkt")
	err = UploadStatic(context.Background(), brpPath, UploadOptions{
		Target:    "r2",
		WorkerDir: filepath.Join(dir, "does-not-exist"), // proves no node tooling is touched
		IndexURL:  index.URL,
		Rev:       rev,
	})
	if err != nil {
		t.Fatal(err)
	}
	rid := "somegameid-" + rev
	found := false
	for _, k := range putKeys {
		if !strings.HasPrefix(k, "replays/"+rid) {
			t.Errorf("object %q not under the revisioned id %q", k, rid)
		}
		if k == "replays/"+rid+".brw" {
			found = true
		}
	}
	if !found {
		t.Errorf("no .brw head among %v", putKeys)
	}
	if !strings.Contains(catalogBody, `"rid":"`+rid+`"`) {
		t.Errorf("catalog PUT body lacks the rid: %s", catalogBody)
	}
}

// The "local" target publishes through the dev worker's PUT /replays/* route
// — concurrent HTTP, no wrangler spawns (the nonexistent worker dir proves no
// node tooling ran) — and still PUTs the catalog row with the rid.
func TestUploadStaticLocalWorkerRoute(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "somegameid.brsnap")
	if err := os.WriteFile(in, []byte(testStream), 0o644); err != nil {
		t.Fatal(err)
	}
	brpPath, _, err := Pack(context.Background(), nil, in, dir, "", true)
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var putKeys []string
	var catalogBody string
	var sawAuth bool
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/replays/"):
			mu.Lock()
			putKeys = append(putKeys, strings.TrimPrefix(r.URL.Path, "/"))
			sawAuth = sawAuth || r.Header.Get("Authorization") == "Bearer tok"
			mu.Unlock()
			w.Write([]byte(`{"ok":true}`))
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/api/replays/"):
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			catalogBody = string(b)
			mu.Unlock()
			w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(worker.Close)

	t.Setenv("R2_ACCESS_KEY_ID", "")
	t.Setenv("R2_SECRET_ACCESS_KEY", "")
	t.Setenv("REPLAY_PUT_TOKEN", "tok")
	err = UploadStatic(context.Background(), brpPath, UploadOptions{
		Target:    "local",
		WorkerDir: filepath.Join(dir, "does-not-exist"),
		IndexURL:  worker.URL,
		Rev:       "1a2b3c4d",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(putKeys) == 0 || putKeys[len(putKeys)-1] != "replays/somegameid-1a2b3c4d.brw" {
		t.Errorf("piece PUTs = %v, want the revisioned keys with the .brw last", putKeys)
	}
	if !sawAuth {
		t.Error("piece PUTs did not carry the bearer token")
	}
	if !strings.Contains(catalogBody, `"rid":"somegameid-1a2b3c4d"`) {
		t.Errorf("catalog PUT body lacks the rid: %s", catalogBody)
	}
}

// A local publish with no reachable dev worker falls back toward the wrangler
// tooling (which surfaces the worker-project requirement).
func TestUploadStaticLocalFallsBack(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "somegameid.brsnap")
	if err := os.WriteFile(in, []byte(testStream), 0o644); err != nil {
		t.Fatal(err)
	}
	brpPath, _, err := Pack(context.Background(), nil, in, dir, "", true)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("R2_ACCESS_KEY_ID", "")
	t.Setenv("R2_SECRET_ACCESS_KEY", "")
	err = UploadStatic(context.Background(), brpPath, UploadOptions{
		Target:    "local",
		WorkerDir: filepath.Join(dir, "does-not-exist"),
		IndexURL:  "http://127.0.0.1:1", // nothing listens here
		Rev:       "1a2b3c4d",
	})
	if err == nil || !strings.Contains(err.Error(), "worker project") {
		t.Fatalf("err = %v, want the wrangler-fallback worker-project error", err)
	}
}

// The pool cancels promptly: after the first failure no new work starts.
func TestPutPoolFailFast(t *testing.T) {
	var started atomic.Int32
	keys := make([]string, 100)
	for i := range keys {
		keys[i] = "k"
	}
	err := putPool(context.Background(), keys, func(ctx context.Context, key string) error {
		started.Add(1)
		return errors.New("boom")
	})
	if err == nil {
		t.Fatal("want error")
	}
	if n := started.Load(); n > uploadConcurrency {
		t.Errorf("%d puts started after a failure, want at most %d", n, uploadConcurrency)
	}
}
