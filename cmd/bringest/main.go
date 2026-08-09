// Command bringest is the drag&drop upload daemon: it turns raw .brepstream
// files uploaded through the worker GUI (POST /api/upload) into
// published, viewable replays. The worker only archives the stream and
// records a pending job — this daemon, running wherever Go and the worker
// tooling live (a VM, a workstation), does the actual work through the same
// pipeline as `pack -upload` (internal/packer):
//
//	poll GET  <worker>/api/jobs            pending (and stalled) jobs
//	     POST <worker>/api/jobs/<id>       claim: state=processing
//	     GET  <worker>/api/<streamKey>     download the archived stream
//	     pack: demo fetch -> .brp -> static bundle -> R2 upload (revisioned)
//	     PUT  <worker>/api/replays/<gid>   catalog row (rid = the revision)
//	     POST <worker>/api/jobs/<id>       state=done | error
//
// Everything daemon->worker is plain HTTPS with the shared REPLAY_PUT_TOKEN
// bearer secret — no inbound connectivity to this host is ever needed, so it
// runs happily behind NAT and the worker keeps accepting uploads while it is
// down (jobs wait as pending; a "processing" job whose daemon died is
// re-offered after a timeout). With R2 API credentials in the environment
// (R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY — set them: this is the intended
// deployment) the R2 puts are NATIVE Go, concurrent SigV4 PUTs against the
// bucket's S3 endpoint (internal/packer/r2.go) — no node on the host at all;
// -upload local instead PUTs the pieces through the dev worker's own guarded
// /replays/* route. Only when neither is available (no credentials, or a
// local run with no dev server up) does it fall back to the worker project's
// upload tooling (npx tsx tools/upload.ts).
//
// A demo-fetch failure (the BAR API does not know the game — private lobby,
// not yet indexed) degrades to a -no-demo pack instead of failing the job:
// the stream's own GAME metadata still yields a playable replay.
//
// Usage:
//
//	bringest -index-url https://replays.example.workers.dev
//	bringest -once            # drain the backlog and exit
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/packer"
)

func main() {
	var (
		indexURL  = flag.String("index-url", os.Getenv("BARREPLAY_INDEX_URL"), "base URL of the deployed worker (default: $BARREPLAY_INDEX_URL)")
		workerDir = flag.String("worker-dir", "worker", "the Cloudflare worker project directory whose upload tooling performs the R2 puts")
		target    = flag.String("upload", "r2", `where to publish: "r2" (real bucket) or "local" (the wrangler/vite dev simulator)`)
		poll      = flag.Duration("poll", 10*time.Second, "how often to ask the worker for pending jobs")
		once      = flag.Bool("once", false, "process the current backlog and exit instead of polling forever")
	)
	flag.Parse()
	if *indexURL == "" {
		fmt.Fprintln(os.Stderr, "bringest: -index-url (or $BARREPLAY_INDEX_URL) is required")
		os.Exit(2)
	}
	if *target != "r2" && *target != "local" {
		fmt.Fprintf(os.Stderr, "bringest: -upload must be \"r2\" or \"local\" (got %q)\n", *target)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client := barapi.New()
	d := &daemon{
		indexURL: strings.TrimSuffix(*indexURL, "/"),
		token:    os.Getenv("REPLAY_PUT_TOKEN"),
		client:   &http.Client{Timeout: 5 * time.Minute},
		process: func(ctx context.Context, streamPath string) error {
			return processStream(ctx, client, streamPath, *target, *workerDir, strings.TrimSuffix(*indexURL, "/"))
		},
	}

	if *once {
		if _, err := d.runOnce(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "bringest: %v\n", err)
			os.Exit(1)
		}
		return
	}
	fmt.Fprintf(os.Stderr, "bringest: polling %s every %s\n", d.indexURL, *poll)
	ticker := time.NewTicker(*poll)
	defer ticker.Stop()
	for {
		if _, err := d.runOnce(ctx); err != nil && ctx.Err() == nil {
			fmt.Fprintf(os.Stderr, "bringest: %v\n", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// ingestJob mirrors the worker's job row (worker/src/worker/replayindex.ts).
type ingestJob struct {
	ID        string `json:"id"`
	StreamKey string `json:"streamKey"`
	GameID    string `json:"gameId"`
	State     string `json:"state"`
}

// daemon holds the polling loop's wiring. process is injectable so the loop
// (claim -> download -> process -> report) tests hermetically without the
// packer's npx/network machinery.
type daemon struct {
	indexURL string
	token    string
	client   *http.Client
	process  func(ctx context.Context, streamPath string) error
}

// runOnce fetches the pending queue and works through it sequentially,
// reporting each job's outcome to the worker. Returns how many jobs it
// attempted; the returned error covers queue-level failures only (a single
// job's failure is reported to its job row and does not stop the rest).
func (d *daemon) runOnce(ctx context.Context) (int, error) {
	var jobs []ingestJob
	if err := d.api(ctx, http.MethodGet, "/api/jobs", nil, &jobs); err != nil {
		return 0, fmt.Errorf("listing pending jobs: %w", err)
	}
	for _, j := range jobs {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		if err := d.handle(ctx, j); err != nil {
			fmt.Fprintf(os.Stderr, "bringest: job %s (%s): %v\n", j.ID, j.GameID, err)
			d.report(ctx, j.ID, "error", err.Error())
		} else {
			fmt.Fprintf(os.Stderr, "bringest: job %s (%s): published\n", j.ID, j.GameID)
			d.report(ctx, j.ID, "done", "")
		}
	}
	return len(jobs), nil
}

// handle runs one job: claim it, download the archived stream to a temp file
// named after the gameId (packer.Pack keys the replay off the basename), and
// hand it to the pipeline.
func (d *daemon) handle(ctx context.Context, j ingestJob) error {
	if err := d.report(ctx, j.ID, "processing", ""); err != nil {
		return fmt.Errorf("claiming: %w", err)
	}
	tmp, err := os.MkdirTemp("", "bringest-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	streamPath := filepath.Join(tmp, j.GameID+".brepstream")
	if err := d.download(ctx, j.StreamKey, streamPath); err != nil {
		return fmt.Errorf("downloading %s: %w", j.StreamKey, err)
	}
	return d.process(ctx, streamPath)
}

// download streams one archived upload from the worker (GET /api/<streamKey>,
// bearer-guarded) into path.
func (d *daemon) download(ctx context.Context, streamKey, path string) error {
	// The archive key is streams/<gameId>/<file>; the worker serves it under
	// /api/ with each segment escaped.
	parts := strings.Split(streamKey, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.indexURL+"/api/"+strings.Join(parts, "/"), nil)
	if err != nil {
		return err
	}
	d.auth(req)
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", req.URL, resp.Status)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// report posts a job state transition; errMsg rides along for "error".
func (d *daemon) report(ctx context.Context, jobID, state, errMsg string) error {
	body := map[string]string{"state": state}
	if errMsg != "" {
		body["error"] = errMsg
	}
	return d.api(ctx, http.MethodPost, "/api/jobs/"+url.PathEscape(jobID), body, nil)
}

// api performs one JSON request against the worker, bearer-authenticated.
func (d *daemon) api(ctx context.Context, method, path string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.indexURL+path, rdr)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	d.auth(req)
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("%s %s: %s: %s", method, path, resp.Status, strings.TrimSpace(string(msg)))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (d *daemon) auth(req *http.Request) {
	if d.token != "" {
		req.Header.Set("Authorization", "Bearer "+d.token)
	}
}

// processStream is the real pipeline: pack the stream (demo-enriched when the
// BAR API knows the game, the stream's own metadata otherwise) and publish it
// under its content-addressed revision. Idempotent: the same stream re-lands
// on the same keys and catalog row.
func processStream(ctx context.Context, client *barapi.Client, streamPath, target, workerDir, indexURL string) error {
	rev, err := packer.StreamRev(streamPath)
	if err != nil {
		return err
	}
	brpPath, modOptions, err := packer.Pack(ctx, client, streamPath, filepath.Dir(streamPath), "", false)
	if errors.Is(err, packer.ErrDemoUnavailable) {
		fmt.Fprintf(os.Stderr, "bringest: %v; publishing with the stream's own metadata\n", err)
		brpPath, modOptions, err = packer.Pack(ctx, client, streamPath, filepath.Dir(streamPath), "", true)
	}
	if err != nil {
		return err
	}
	return packer.UploadStatic(ctx, brpPath, packer.UploadOptions{
		Target:     target,
		WorkerDir:  workerDir,
		IndexURL:   indexURL,
		Rev:        rev,
		ModOptions: modOptions,
	})
}
