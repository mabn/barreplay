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
// Every published replay — from either loop — is followed by the same size
// report `pack -stats` prints (packer.ReportStats: per-section sizes and the
// top unit defs by encoded bytes), so the sizes of unattended publishes end up
// in the log next to everything else. -stats=false turns it off.
//
// -resim (needs -data pointing at a BAR data dir on an engine-capable host —
// see the GL caveat in CLAUDE.md) runs an INDEPENDENT worker instead of the
// job loop: it polls the replay catalog (GET /api/replays) for games whose
// current upload is ONE-SIDED (uploaderAlly set — a playing client's point
// of view) and which have no full-view revision yet (no ally-null entry in
// the row's uploads list), re-simulates each demo headlessly
// (internal/resim, the cmd/barreplay pipeline) and publishes the full-view
// capture as another revision of the same game. The publish itself
// retires the candidate — the row's uploads list gains an ally-null entry
// and its rid moves to the full view — so no extra queue state exists
// anywhere; upload jobs are untouched and keep being served by plain
// bringest runs. A game whose resim fails is remembered and skipped until
// the daemon restarts.
//
// Usage:
//
//	bringest                  # serve the deployed worker's upload queue
//	bringest -upload local    # ...the dev simulator's instead
//	bringest -once            # drain the backlog and exit
//	bringest -resim -data ~/bar-data        # the independent full-view re-sim worker
//	bringest -resim -data ~/bar-data -once  # re-sim the current candidates and exit
//
// -upload names the whole deployment, not just a bucket: the job queue, the
// stream downloads, the R2 pieces and the catalog row all belong to one worker
// (packer.LookupTarget), so a run cannot claim a job on one deployment and
// publish it into another.
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
	"github.com/mabn/barreplay/internal/envfile"
	"github.com/mabn/barreplay/internal/packer"
	"github.com/mabn/barreplay/internal/resim"
)

// envPath is the local secrets file loaded at startup (R2 keys, catalog
// token). Relative, so it resolves against the working directory — normally
// the repo root, which is also where -worker-dir's default "worker" points.
const envPath = ".env"

// defaultLogPath is where -log appends by default; progressEvery matches
// cmd/barreplay's -progress cadence so the two read identically.
const (
	defaultLogPath = "bringest.log"
	progressEvery  = 2 * time.Second
)

// main is a thin wrapper so run's deferred cleanup — notably flushing the tee'd
// log — happens on every exit path; os.Exit inside run would skip it.
func main() { os.Exit(run()) }

func run() int {
	// Before the flags below, whose defaults read the environment. Its report
	// is held back so it lands in the log file too, which only opens once the
	// flags naming it are parsed.
	envMsgs := loadEnvFile()

	var (
		workerDir = flag.String("worker-dir", "worker", "the Cloudflare worker project directory whose upload tooling performs the R2 puts")
		target    = flag.String("upload", "r2", "which deployment to work off and publish to: "+packer.TargetHelp())
		poll      = flag.Duration("poll", 10*time.Second, "how often to ask the worker for pending jobs")
		once      = flag.Bool("once", false, "process the current backlog and exit instead of polling forever")
		doResim   = flag.Bool("resim", false, "run the independent re-sim worker instead of the job loop: find cataloged games whose only upload is one-sided, re-simulate them headlessly, and publish the full view as another revision (needs -data on an engine-capable host)")
		dataDir   = flag.String("data", os.Getenv("BAR_DATA_DIR"), "BAR/Spring data directory for -resim (engine/, games/, maps/; also --write-dir; default: $BAR_DATA_DIR)")
		skipProv  = flag.Bool("no-provision", false, "-resim: do not download engine/game/map content; assume already installed")
		progress  = flag.Bool("progress", true, "-resim: print the frame/ETA progress line during a re-simulation, like cmd/barreplay's -progress")
		stats     = flag.Bool("stats", true, "print the packed .brp's size breakdown (per-section sizes + the top unit defs by encoded bytes) for each replay published, like pack -stats")
		logPath   = flag.String("log", defaultLogPath, "also append everything printed to this file (empty disables)")
	)
	flag.Parse()

	if *logPath != "" {
		stopTee, err := teeStderr(*logPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "bringest: %v\n", err)
			return 2
		}
		defer stopTee()
	}
	for _, m := range envMsgs {
		fmt.Fprintln(os.Stderr, m)
	}

	// One flag names the whole deployment: the daemon's job queue, the stream
	// downloads, the bucket and the catalog are all the same worker, so there
	// is nothing to point at each other wrongly (see internal/packer/targets.go
	// — a queue on one deployment publishing into another was reachable when
	// the URL and the bucket were separate flags).
	dest, ok := packer.LookupTarget(*target)
	if !ok {
		fmt.Fprintf(os.Stderr, "bringest: -upload must be %s (got %q)\n", packer.TargetList(), *target)
		return 2
	}
	if *doResim && *dataDir == "" {
		fmt.Fprintln(os.Stderr, "bringest: -resim needs -data (or $BAR_DATA_DIR) pointing at a BAR data directory")
		return 2
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client := barapi.New()
	indexURL := dest.IndexURL

	// -resim runs the independent re-sim worker; everything else is the
	// normal upload-job loop. The two share nothing but the worker URL.
	var loop interface {
		runOnce(context.Context) (int, error)
	}
	what := "pending jobs"
	if *doResim {
		ro := resim.Options{DataDir: *dataDir, SkipProvision: *skipProv}
		if *progress {
			ro.ProgressEvery = progressEvery
		}
		loop = &resimDaemon{
			indexURL: indexURL,
			client:   &http.Client{Timeout: 1 * time.Minute},
			failed:   map[string]bool{},
			resim: func(ctx context.Context, gameID string) error {
				return resimPublish(ctx, client, gameID, ro, *target, *workerDir, indexURL, *stats)
			},
		}
		what = "one-sided replays to re-simulate"
	} else {
		loop = &daemon{
			indexURL: indexURL,
			token:    os.Getenv("REPLAY_PUT_TOKEN"),
			client:   &http.Client{Timeout: 5 * time.Minute},
			process: func(ctx context.Context, streamPath string) error {
				return processStream(ctx, client, streamPath, *target, *workerDir, indexURL, *stats)
			},
		}
	}

	if *once {
		if _, err := loop.runOnce(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "bringest: %v\n", err)
			return 1
		}
		return 0
	}
	fmt.Fprintf(os.Stderr, "bringest: polling %s every %s for %s\n", indexURL, *poll, what)
	ticker := time.NewTicker(*poll)
	defer ticker.Stop()
	for {
		if _, err := loop.runOnce(ctx); err != nil && ctx.Err() == nil {
			fmt.Fprintf(os.Stderr, "bringest: %v\n", err)
		}
		select {
		case <-ctx.Done():
			return 0
		case <-ticker.C:
		}
	}
}

// teeStderr duplicates everything written to os.Stderr into path (appended, so
// runs accumulate rather than clobbering each other). It swaps os.Stderr for a
// pipe rather than threading a writer through the call graph, so it also
// captures what internal/resim, internal/packer and inherited child processes
// print — which is most of the interesting output. The returned stop drains
// the pipe before returning, so nothing is lost at exit.
func teeStderr(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open log %s: %w", path, err)
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		f.Close()
		return nil, err
	}
	orig := os.Stderr
	os.Stderr = pw
	done := make(chan struct{})
	go func() {
		defer close(done)
		io.Copy(io.MultiWriter(orig, f), pr)
	}()
	return func() {
		os.Stderr = orig
		pw.Close()
		<-done // drain what is still in flight before the process exits
		f.Close()
	}, nil
}

// loadEnvFile seeds the environment from ./.env. It reports what it did
// because the failure it exists to prevent is silent: without the R2
// credentials the upload falls back to the worker's wrangler tooling, which
// fails with an unrelated-looking CLOUDFLARE_API_TOKEN error, so "did my
// secrets actually get loaded?" must be answerable from the log alone.
// Names only — never values, which are secrets.
// It returns its report rather than printing it: the log file that should also
// receive these lines is named by a flag, and the flags cannot be parsed until
// this has run (their defaults read the environment it populates).
func loadEnvFile() []string {
	var msgs []string
	n, err := envfile.Load(envPath)
	switch {
	case err != nil:
		// Not fatal: the environment may already carry everything needed.
		msgs = append(msgs, fmt.Sprintf("bringest: ignoring %s: %v", envPath, err))
	case n > 0:
		msgs = append(msgs, fmt.Sprintf("bringest: loaded %d var(s) from %s", n, envPath))
	}
	if os.Getenv("R2_ACCESS_KEY_ID") == "" || os.Getenv("R2_SECRET_ACCESS_KEY") == "" {
		msgs = append(msgs, fmt.Sprintf("bringest: warning: R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY not set"+
			" (no %s in %s?); -upload r2 will fall back to the worker's wrangler tooling",
			envPath, mustGetwd()))
	}
	return msgs
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return "the working directory"
	}
	return wd
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
// packer's npx/network machinery or a real engine.
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
func processStream(ctx context.Context, client *barapi.Client, streamPath, target, workerDir, indexURL string, stats bool) error {
	brpPath, modOptions, err := packer.Pack(ctx, client, streamPath, filepath.Dir(streamPath), "", false)
	if errors.Is(err, packer.ErrDemoUnavailable) {
		fmt.Fprintf(os.Stderr, "bringest: %v; publishing with the stream's own metadata\n", err)
		brpPath, modOptions, err = packer.Pack(ctx, client, streamPath, filepath.Dir(streamPath), "", true)
	}
	if err != nil {
		return err
	}
	if stats {
		reportStats(brpPath)
	}
	// AFTER the pack, and from the packed file: the fallback just above is
	// exactly the case a stream hash gets wrong. The same stream published once
	// with the demo metadata and once without produces different .brp bytes,
	// and hashing the stream gave both the same revision — so the second
	// publish overwrote pieces already served as immutable.
	rev, err := packer.ContentRev(brpPath)
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

// reportStats prints the freshly packed .brp's size breakdown — the same
// report as `pack -stats`, so an unattended publish leaves the same record in
// the log a manual one leaves on the terminal (which is where the sizes get
// compared across replays and codec changes). Best-effort: a measuring failure
// says something about the codec, not about the replay, so it is a warning and
// never costs an otherwise finished publish.
//
// It writes to os.Stderr like everything else here, which teeStderr also
// copies into the log file.
func reportStats(brpPath string) {
	if err := packer.ReportStats(os.Stderr, brpPath); err != nil {
		fmt.Fprintf(os.Stderr, "bringest: stats for %s: %v\n", brpPath, err)
	}
}

// ---- the -resim worker ------------------------------------------------------

// catalogRow is the slice of a GET /api/replays row the re-sim worker reads:
// enough to decide whether a game's published state is one-sided with no
// full-view revision yet.
type catalogRow struct {
	ID           string `json:"id"`
	UploaderAlly *int   `json:"uploaderAlly"`
	Uploads      []struct {
		Rid  string `json:"rid"`
		Ally *int   `json:"ally"`
	} `json:"uploads"`
}

// resimDaemon is the independent -resim worker: no job queue, no worker-side
// state. Its work list is a pure function of the public catalog — a game is
// a candidate while its current upload is one-sided (uploaderAlly set) and
// its uploads list holds no full-view revision (an entry with a null ally:
// spectator uploads and re-sim captures PUT with no uploaderAlly). The
// publish itself retires the candidate, so completion needs no marking.
type resimDaemon struct {
	indexURL string
	client   *http.Client
	resim    func(ctx context.Context, gameID string) error
	// failed remembers games whose resim errored (engine missing, unknown
	// demo, desync); they are skipped until the process restarts so one bad
	// game cannot wedge the loop into retrying forever.
	failed map[string]bool
}

// runOnce lists the catalog and re-simulates every candidate sequentially
// (each is minutes of engine wall time). Returns how many it attempted; the
// error covers the catalog listing only — per-game failures are logged and
// remembered.
func (r *resimDaemon) runOnce(ctx context.Context) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.indexURL+"/api/replays", nil)
	if err != nil {
		return 0, err
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("listing the catalog: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("GET /api/replays: %s", resp.Status)
	}
	var rows []catalogRow
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		return 0, fmt.Errorf("decoding the catalog: %w", err)
	}

	attempted := 0
	for _, row := range rows {
		if ctx.Err() != nil {
			return attempted, ctx.Err()
		}
		if !row.needsResim() || r.failed[row.ID] {
			continue
		}
		attempted++
		fmt.Fprintf(os.Stderr, "bringest: %s: one-sided only, re-simulating for the full view\n", row.ID)
		if err := r.resim(ctx, row.ID); err != nil {
			if ctx.Err() != nil {
				return attempted, ctx.Err()
			}
			fmt.Fprintf(os.Stderr, "bringest: %s: resim failed (skipping until restart): %v\n", row.ID, err)
			r.failed[row.ID] = true
		} else {
			fmt.Fprintf(os.Stderr, "bringest: %s: full view published\n", row.ID)
		}
	}
	return attempted, nil
}

// needsResim: the current upload is a playing client's point of view and no
// revision of the game is a full view yet.
func (row catalogRow) needsResim() bool {
	if row.UploaderAlly == nil {
		return false
	}
	for _, u := range row.Uploads {
		if u.Ally == nil {
			return false
		}
	}
	return true
}

// resimPublish re-simulates the demo headlessly (internal/resim — minutes of
// engine wall time) and publishes the resulting full-view .brp,
// content-addressed off the .brp bytes (deterministic writer: the same sim
// re-lands on the same revision).
func resimPublish(ctx context.Context, client *barapi.Client, gameID string, ro resim.Options, target, workerDir, indexURL string, stats bool) error {
	tmp, err := os.MkdirTemp("", "bringest-resim-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	ro.OutDir = tmp
	brpPath, modOptions, err := resim.Run(ctx, client, gameID, ro)
	if err != nil {
		return err
	}
	if stats {
		reportStats(brpPath)
	}
	rev, err := packer.ContentRev(brpPath) // content hash of any file; here the .brp
	if err != nil {
		return err
	}
	return packer.UploadStatic(ctx, brpPath, packer.UploadOptions{
		Target:     target,
		WorkerDir:  workerDir,
		IndexURL:   indexURL,
		Rev:        rev,
		ModOptions: modOptions,
		// A re-sim watched the whole game, but its capture carries no recorder
		// record to say so (only live uploads do), so state it explicitly —
		// otherwise the row keeps the superseded one-sided upload's marking.
		View: "full",
	})
}
