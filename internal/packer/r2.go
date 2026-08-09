// Native R2 uploads: a minimal SigV4 signer + concurrent PUT pool against the
// bucket's S3 endpoint (https://<account>.r2.cloudflarestorage.com), so the
// ingest daemon and `pack -upload r2` publish without shelling into the
// worker's node tooling. Deliberately mirrors worker/tools/r2put.ts's fast
// path (aws4fetch): UNSIGNED-PAYLOAD, the same three signed headers, 16 PUTs
// in flight, one retry on transient failures, and the .brw-heads-last
// completion barrier. The signer is pinned byte-for-byte against an
// aws4fetch-produced signature in r2_test.go — the exact signer the TS path
// uses successfully against R2. Only PutObject is implemented; that is all
// publishing needs, and it keeps the repo's no-third-party-deps rule.
package packer

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// R2Client PUTs objects into one R2 bucket over the S3 API.
type R2Client struct {
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
	// Endpoint is the S3 endpoint base URL (no trailing slash), normally
	// https://<accountID>.r2.cloudflarestorage.com; tests point it at a local
	// server.
	Endpoint string
	// HTTPClient defaults to http.DefaultClient; now defaults to time.Now.
	HTTPClient *http.Client
	now        func() time.Time
}

const uploadConcurrency = 16

// r2ClientFromEnv assembles a native client when the environment carries R2
// API credentials (R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY). The account id
// and bucket come from CLOUDFLARE_ACCOUNT_ID / R2_BUCKET, falling back to
// workerDir's wrangler.jsonc (account_id / the first bucket_name); R2_ENDPOINT
// overrides the derived endpoint outright (tests, other S3-compatible
// stores). Returns nil — callers fall back to the worker's node tooling —
// when credentials or the account id are missing.
func r2ClientFromEnv(workerDir string) *R2Client {
	id, secret := os.Getenv("R2_ACCESS_KEY_ID"), os.Getenv("R2_SECRET_ACCESS_KEY")
	if id == "" || secret == "" {
		return nil
	}
	bucket := os.Getenv("R2_BUCKET")
	if bucket == "" {
		bucket = wranglerConfigValue(workerDir, "bucket_name")
	}
	endpoint := os.Getenv("R2_ENDPOINT")
	if endpoint == "" {
		account := os.Getenv("CLOUDFLARE_ACCOUNT_ID")
		if account == "" {
			account = wranglerConfigValue(workerDir, "account_id")
		}
		if account != "" {
			endpoint = "https://" + account + ".r2.cloudflarestorage.com"
		}
	}
	if endpoint == "" || bucket == "" {
		fmt.Fprintln(os.Stderr, "warning: R2 credentials set but no account id/bucket (CLOUDFLARE_ACCOUNT_ID/R2_BUCKET or wrangler.jsonc); using the worker's upload tooling")
		return nil
	}
	return &R2Client{
		Bucket:          bucket,
		AccessKeyID:     id,
		SecretAccessKey: secret,
		Endpoint:        strings.TrimSuffix(endpoint, "/"),
	}
}

// wranglerConfigValue extracts a `"key": "value"` string from the worker's
// wrangler.jsonc — the same single-source-of-truth parse the TS tooling does
// (jsonc has comments, so no JSON decoder). First occurrence wins, which for
// bucket_name is the production bucket.
func wranglerConfigValue(workerDir, key string) string {
	b, err := os.ReadFile(filepath.Join(workerDir, "wrangler.jsonc"))
	if err != nil {
		return ""
	}
	m := regexp.MustCompile(`"` + key + `"\s*:\s*"([^"]+)"`).FindSubmatch(b)
	if m == nil {
		return ""
	}
	return string(m[1])
}

// UploadBundle uploads every file under bundleDir (a WriteStaticBundle
// output: replays/** keys mirror R2 keys) via c.Put — see uploadBundle for
// the wave/barrier semantics.
func (c *R2Client) UploadBundle(ctx context.Context, bundleDir string) error {
	return uploadBundle(ctx, bundleDir, c.Put)
}

// uploadBundle uploads every file under bundleDir through put in two waves —
// everything else first, then every .brw head. The barrier matters: the head
// is the object the Worker's live listing keys on, so a replay can never
// appear in the picker before the rest of its files exist.
func uploadBundle(ctx context.Context, bundleDir string, put func(ctx context.Context, key string, body []byte) error) error {
	var bodies, heads []string // bundle-relative keys
	err := filepath.WalkDir(bundleDir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		key := filepath.ToSlash(strings.TrimPrefix(strings.TrimPrefix(path, bundleDir), "/"))
		if strings.HasSuffix(key, ".brw") {
			heads = append(heads, key)
		} else {
			bodies = append(bodies, key)
		}
		return nil
	})
	if err != nil {
		return err
	}
	putFile := func(ctx context.Context, key string) error {
		body, err := os.ReadFile(filepath.Join(bundleDir, filepath.FromSlash(key)))
		if err != nil {
			return err
		}
		if err := put(ctx, key, body); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "  put %s\n", key)
		return nil
	}
	if err := putPool(ctx, bodies, putFile); err != nil {
		return err
	}
	return putPool(ctx, heads, putFile)
}

// workerPut PUTs one object through the worker's bearer-guarded
// PUT /replays/<key> route — the transport for the "local" target, where the
// dev server binds the simulator's bucket (wrangler spawns cost ~1s each;
// this is plain fast HTTP). One retry on transient failures, like R2Client.
func workerPut(ctx context.Context, indexURL, key string, body []byte) error {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPut,
			strings.TrimSuffix(indexURL, "/")+"/"+uriEncodePath(key), bytes.NewReader(body))
		if err != nil {
			return err
		}
		if token := os.Getenv("REPLAY_PUT_TOKEN"); token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				return err
			}
			continue
		}
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return nil
		}
		lastErr = fmt.Errorf("PUT %s: %s: %s", key, resp.Status, strings.TrimSpace(string(msg)))
		if resp.StatusCode < 500 {
			return lastErr
		}
	}
	return lastErr
}

// Put uploads one object, retrying once on a transient failure (5xx or a
// transport error) like the TS s3Put.
func (c *R2Client) Put(ctx context.Context, key string, body []byte) error {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.Endpoint+"/"+uriEncodePath(c.Bucket+"/"+key), bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.ContentLength = int64(len(body))
		c.sign(req)
		client := c.HTTPClient
		if client == nil {
			client = http.DefaultClient
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				return err
			}
			continue
		}
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return nil
		}
		lastErr = fmt.Errorf("PUT %s: %s: %s", key, resp.Status, strings.TrimSpace(string(msg)))
		if resp.StatusCode < 500 {
			return lastErr
		}
	}
	return lastErr
}

// sign adds the SigV4 headers exactly the way aws4fetch does for S3 (region
// "auto", UNSIGNED-PAYLOAD, signed headers host;x-amz-content-sha256;
// x-amz-date) — pinned against an aws4fetch fixture in the tests.
func (c *R2Client) sign(req *http.Request) {
	now := time.Now
	if c.now != nil {
		now = c.now
	}
	amzDate := now().UTC().Format("20060102T150405Z")
	day := amzDate[:8]
	const payloadHash = "UNSIGNED-PAYLOAD"
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)

	canonical := strings.Join([]string{
		req.Method,
		req.URL.EscapedPath(),
		req.URL.RawQuery,
		"host:" + req.URL.Host,
		"x-amz-content-sha256:" + payloadHash,
		"x-amz-date:" + amzDate,
		"",
		"host;x-amz-content-sha256;x-amz-date",
		payloadHash,
	}, "\n")

	scope := day + "/auto/s3/aws4_request"
	toSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		hexSHA256([]byte(canonical)),
	}, "\n")

	key := hmacSHA256([]byte("AWS4"+c.SecretAccessKey), day)
	key = hmacSHA256(key, "auto")
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(key, toSign))

	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=%s",
		c.AccessKeyID, scope, sig))
}

// uriEncodePath percent-encodes a key path per the S3 canonical-URI rules:
// every byte except unreserved characters, keeping "/" as the separator.
// Applied at URL build time so URL.EscapedPath() sees (and signs) exactly
// what goes on the wire.
func uriEncodePath(p string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~/"
	var b strings.Builder
	for i := 0; i < len(p); i++ {
		if strings.IndexByte(unreserved, p[i]) >= 0 {
			b.WriteByte(p[i])
		} else {
			fmt.Fprintf(&b, "%%%02X", p[i])
		}
	}
	return b.String()
}

func hexSHA256(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func hmacSHA256(key []byte, msg string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(msg))
	return h.Sum(nil)
}

// putPool runs put over keys with at most uploadConcurrency in flight; the
// first failure cancels the rest (in-flight puts finish or abort on ctx).
func putPool(ctx context.Context, keys []string, put func(context.Context, string) error) error {
	if len(keys) == 0 {
		return nil
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	work := make(chan string)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	workers := min(uploadConcurrency, len(keys))
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for key := range work {
				if ctx.Err() != nil {
					return
				}
				if err := put(ctx, key); err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
					cancel()
					return
				}
			}
		}()
	}
	for _, k := range keys {
		select {
		case work <- k:
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
	}
	close(work)
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	return firstErr
}
