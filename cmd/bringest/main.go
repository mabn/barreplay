// Command bringest is the drag&drop upload daemon: it turns raw .brepstream
// files uploaded through the worker GUI (POST /api/upload) into
// published, viewable replays. The worker only archives the stream and
// records a pending job — this daemon, running wherever Go and the worker
// tooling live (a VM, a workstation), does the actual work through the same
// pipeline as `pack -upload` (internal/packer):
//
//	poll GET  <worker>/api/jobs?kind=upload   pending (and stalled) jobs
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
// see the GL caveat in CLAUDE.md) runs a SEPARATE worker instead of the upload
// job loop, re-simulating demos headlessly (internal/resim, the cmd/barreplay
// pipeline) and publishing each full-view capture as another revision of its
// game. It takes work from two places, in this order:
//
//  1. REQUESTED re-sims: GET /api/jobs?kind=resim, the queue behind the
//     landing page's paste-a-replay-link box. These are claimed
//     (POST state=processing claim=true, which the worker REFUSES if another
//     daemon holds the job), heartbeated while the engine runs, and reported
//     done/error so the requester sees the outcome — including the failure
//     message — on the queue page. They are the only route into the pipeline
//     for a game nobody uploaded at all.
//  2. The CATALOG SCAN: GET /api/replays for games whose current upload is
//     ONE-SIDED (uploaderAlly set — a playing client's point of view) and
//     which have no full-view revision yet (no ally-null entry in the row's
//     uploads list). Finding this work needs no queue state: the publish
//     itself retires the candidate — the row's uploads list gains an ally-null
//     entry and its rid moves to the full view. But the work is ANNOUNCED
//     (POST /api/jobs) so it gets a job row like any other, and is then
//     claimed, healthchecked and reported exactly like a requested one; before
//     that it was an hour of engine time visible nowhere, whose progress and
//     timings lived only in this daemon's log on a machine nobody else can
//     reach. A game whose resim fails here is ALSO remembered in-process and
//     skipped until the daemon restarts — the announced row records the
//     failure for a person to read, but re-announcing after a restart is what
//     retries it, since a scan candidate has no link for anyone to re-paste.
//
// The two lists cannot overlap: a request is refused while its game is in the
// catalog, and a scanned candidate is in it by definition. Upload jobs are
// untouched either way and keep being served by plain bringest runs.
//
// Usage:
//
//	bringest                  # serve the deployed worker's upload queue
//	bringest -upload local    # ...the dev simulator's instead
//	bringest -once            # drain the backlog and exit
//	bringest -resim -data ~/bar-data        # the independent full-view re-sim worker
//	bringest -resim -data ~/bar-data -once  # re-sim the requested + current candidates and exit
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
			// The requested-re-sim queue is the same bearer-guarded job API
			// the upload loop uses; the catalog listing it also reads is
			// open, which is why this loop needed no token before.
			workerAPI: workerAPI{
				indexURL: indexURL,
				token:    os.Getenv("REPLAY_PUT_TOKEN"),
				client:   &http.Client{Timeout: 1 * time.Minute},
			},
			failed: map[string]bool{},
			resim: func(ctx context.Context, gameID string, st *jobStats, pr *resim.Progress) error {
				return resimPublish(ctx, client, gameID, ro, *target, *workerDir, indexURL, *stats, st, pr)
			},
		}
		what = "requested and one-sided replays to re-simulate"
	} else {
		loop = &daemon{
			workerAPI: workerAPI{
				indexURL: indexURL,
				token:    os.Getenv("REPLAY_PUT_TOKEN"),
				client:   &http.Client{Timeout: 5 * time.Minute},
			},
			process: func(ctx context.Context, streamPath string, st *jobStats) error {
				return processStream(ctx, client, streamPath, *target, *workerDir, indexURL, *stats, st)
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

// ingestJob mirrors the worker's job row (worker/src/worker/jobs.ts).
type ingestJob struct {
	ID        string `json:"id"`
	StreamKey string `json:"streamKey"`
	GameID    string `json:"gameId"`
	Kind      string `json:"kind"`
	State     string `json:"state"`
}

// Job kinds, mirroring worker/src/worker/jobs.ts. Which kind a job is decides
// which daemon serves it: an upload needs no engine, a re-sim needs a whole
// BAR install and an hour.
const (
	kindUpload = "upload"
	kindResim  = "resim"
)

// jobStats is one job's processing record, reported alongside its terminal
// state and kept on the job row as a single JSON blob (the worker's jobs.stats
// column). One blob rather than a column per number because nothing queries
// these — the queue page shows the headline figure and expands the rest on
// click — and because the two kinds of job have little in common: an upload
// records what packing and uploading cost, a re-sim adds most of an hour of
// engine time and what the engine's own log said about it.
//
// It is reported on FAILURE too. A re-sim that dies at minute forty is exactly
// the one worth having the timings and the infolog for.
type jobStats struct {
	TookSec   float64 `json:"tookSec"`
	PackSec   float64 `json:"packSec,omitempty"`
	UploadSec float64 `json:"uploadSec,omitempty"`
	BrpBytes  int64   `json:"brpBytes,omitempty"`

	// Re-sim only, from resim.RunStats.
	ResimSec      float64 `json:"resimSec,omitempty"`
	LoadSec       float64 `json:"loadSec,omitempty"`
	SimSec        float64 `json:"simSec,omitempty"`
	Frames        int32   `json:"frames,omitempty"`
	Samples       int     `json:"samples,omitempty"`
	SpeedUp       float64 `json:"speedUp,omitempty"`
	GameSec       int32   `json:"gameSec,omitempty"`
	EngineVersion string  `json:"engineVersion,omitempty"`

	Infolog *infologStats `json:"infolog,omitempty"`

	// SizeReport is packer.ReportStats' output verbatim — the per-section and
	// per-unit-def breakdown `pack -stats` prints. It is text rather than
	// numbers on purpose: it is read, not queried, and keeping it whole means
	// the queue page shows exactly what the terminal would have.
	SizeReport string `json:"sizeReport,omitempty"`
}

type infologStats struct {
	Bytes     int64 `json:"bytes"`
	Lines     int   `json:"lines,omitempty"`
	LastFrame int32 `json:"lastFrame,omitempty"`
	Desyncs   int   `json:"desyncs"`
	Warnings  int   `json:"warnings,omitempty"`
}

// maxSizeReport caps the stored report. The real thing is 2-3 KB; the cap is
// only here so a pathological capture cannot push an unbounded string into
// every read of the queue page.
const maxSizeReport = 16 << 10

// fromRunStats copies what a finished (or failed) re-simulation measured.
func (s *jobStats) fromRunStats(r resim.RunStats) {
	s.ResimSec, s.LoadSec, s.SimSec = r.EngineSec, r.LoadSec, r.SimSec
	s.Frames, s.Samples, s.SpeedUp = r.Frames, r.Samples, r.SpeedUp
	s.GameSec, s.EngineVersion = r.GameSec, r.EngineVersion
	if r.Infolog.Bytes > 0 {
		s.Infolog = &infologStats{
			Bytes:     r.Infolog.Bytes,
			Lines:     r.Infolog.Lines,
			LastFrame: r.Infolog.LastFrame,
			Desyncs:   r.Infolog.Desyncs,
			Warnings:  r.Infolog.Warnings,
		}
	}
}

// healthcheckEvery is how often a running job reports in. It does two jobs at
// once, which is why it is one request: it keeps the job's updated_unix fresh
// (the worker offers a "processing" job to somebody else once it has been
// silent for its kind's stale window — a re-sim runs many times longer than
// that window, so without a beat the worker would hand live work away mid-run),
// and it carries the run's live progress to the queue page.
//
// Ten seconds because the second job is what sets the pace: a re-sim is an hour
// of silence otherwise, and a progress line that is up to a minute stale reads
// as a stuck job. The cost is one small SQL write per job per tick.
// A var so the test can beat faster.
var healthcheckEvery = 10 * time.Second

// jobProgress is what a running job reports about ITSELF between state
// transitions — the other half of the worker's JobProgress contract
// (worker/src/worker/jobs.ts), exactly as jobStats is for the terminal record.
//
// It is deliberately a separate thing from jobStats: stats are what the work
// COST, written once when it ends and kept forever; this is what the work is
// DOING, overwritten every tick and dropped the moment the job stops running.
type jobProgress struct {
	// State is the phase in words ("simulating", "starting engine"): the one
	// field that means something in every phase, including the ones with
	// nothing to measure.
	State string `json:"state,omitempty"`
	// Frame/TotalFrames are the simulation's position in sim frames, Percent
	// is the two as a percentage, and EtaSec how much wall time the daemon
	// thinks is left. All zero outside the simulating phase.
	Frame       int32   `json:"frame,omitempty"`
	TotalFrames int32   `json:"totalFrames,omitempty"`
	Percent     float64 `json:"percent,omitempty"`
	EtaSec      float64 `json:"etaSec,omitempty"`
	SimFps      float64 `json:"simFps,omitempty"`
	// RssBytes and CpuPct are the ENGINE process's resident memory and CPU use
	// (percent of one core, so a threaded engine exceeds 100). They are the
	// answer to "is this host coping", which nothing else in the pipeline can
	// report: the daemon runs on somebody's machine, behind NAT, and its own
	// log is the only other place this exists.
	RssBytes int64   `json:"rssBytes,omitempty"`
	CpuPct   float64 `json:"cpuPct,omitempty"`
}

// resimProgress reads a live re-simulation and converts the reading to the wire
// shape. Split from progressOf so the conversion — which is where the rounding
// and the field mapping live — can be exercised without a running engine.
func resimProgress(p *resim.Progress) *jobProgress {
	if p == nil {
		return nil
	}
	return progressOf(p.Snapshot())
}

// progressOf is the wire conversion. Rounded on the way out: these are shown to
// a person, and a percentage with fourteen decimals only makes the JSON bigger.
func progressOf(s resim.ProgressState) *jobProgress {
	return &jobProgress{
		State:       s.Phase,
		Frame:       s.Frame,
		TotalFrames: s.TotalFrames,
		Percent:     round1(s.Percent),
		EtaSec:      float64(int64(s.ETASec)),
		SimFps:      round1(s.SimFPS),
		RssBytes:    s.RSSBytes,
		CpuPct:      round1(s.CPUPercent),
	}
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }

// phaseUploading and phasePacking name the minutes AFTER the engine exits.
// They are the caller's to name — internal/resim has no idea a publish happens
// (see resim.Progress.SetPhase) — and without them a job spends its last
// minutes still claiming to be simulating.
const (
	phasePacking   = "packing"
	phaseUploading = "uploading"
)

// workerAPI is the daemons' shared line to the worker: one JSON helper, the
// bearer token, and the job transitions both loops need.
type workerAPI struct {
	indexURL string
	token    string
	client   *http.Client
}

// daemon holds the upload loop's wiring. process is injectable so the loop
// (claim -> download -> process -> report) tests hermetically without the
// packer's npx/network machinery or a real engine.
type daemon struct {
	workerAPI
	process func(ctx context.Context, streamPath string, st *jobStats) error
}

// runOnce fetches the pending queue and works through it sequentially,
// reporting each job's outcome to the worker. Returns how many jobs it
// attempted; the returned error covers queue-level failures only (a single
// job's failure is reported to its job row and does not stop the rest).
func (d *daemon) runOnce(ctx context.Context) (int, error) {
	jobs, err := d.pendingJobs(ctx, kindUpload)
	if err != nil {
		return 0, fmt.Errorf("listing pending jobs: %w", err)
	}
	attempted := 0
	for _, j := range jobs {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		// A worker too old to filter by kind serves every pending job. Leave
		// anything that is not ours alone — untouched, not failed: the daemon
		// that can run it has to still find it pending.
		if j.Kind == kindResim || (j.Kind == "" && j.StreamKey == "") {
			fmt.Fprintf(os.Stderr, "bringest: job %s (%s): not an upload job, leaving it for -resim\n", j.ID, j.GameID)
			continue
		}
		attempted++
		st, err := d.handle(ctx, j)
		if err != nil {
			fmt.Fprintf(os.Stderr, "bringest: job %s (%s): %v\n", j.ID, j.GameID, err)
			d.report(ctx, j.ID, "error", err.Error(), st)
		} else {
			fmt.Fprintf(os.Stderr, "bringest: job %s (%s): published\n", j.ID, j.GameID)
			d.report(ctx, j.ID, "done", "", st)
		}
	}
	return attempted, nil
}

// handle runs one job: claim it, download the archived stream to a temp file
// named after the gameId (packer.Pack keys the replay off the basename), and
// hand it to the pipeline. The stats come back on the failure path too, so a
// job that died carries what it managed to measure.
func (d *daemon) handle(ctx context.Context, j ingestJob) (*jobStats, error) {
	started := time.Now()
	st := &jobStats{}
	defer func() { st.TookSec = time.Since(started).Seconds() }()

	if err := d.report(ctx, j.ID, "processing", "", nil); err != nil {
		return st, fmt.Errorf("claiming: %w", err)
	}
	tmp, err := os.MkdirTemp("", "bringest-")
	if err != nil {
		return st, err
	}
	defer os.RemoveAll(tmp)
	streamPath := filepath.Join(tmp, j.GameID+".brepstream")
	if err := d.download(ctx, j.StreamKey, streamPath); err != nil {
		return st, fmt.Errorf("downloading %s: %w", j.StreamKey, err)
	}
	return st, d.process(ctx, streamPath, st)
}

// download streams one archived upload from the worker (GET /api/<streamKey>,
// bearer-guarded) into path.
func (d *workerAPI) download(ctx context.Context, streamKey, path string) error {
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

// pendingJobs lists the worker's pending (and stalled) jobs of one kind.
func (d *workerAPI) pendingJobs(ctx context.Context, kind string) ([]ingestJob, error) {
	var jobs []ingestJob
	if err := d.api(ctx, http.MethodGet, "/api/jobs?kind="+url.QueryEscape(kind), nil, &jobs); err != nil {
		return nil, err
	}
	return jobs, nil
}

// report posts a job state transition; errMsg rides along for "error" and st,
// when non-nil, is the processing record the queue page shows.
func (d *workerAPI) report(ctx context.Context, jobID, state, errMsg string, st *jobStats) error {
	body := map[string]any{"state": state}
	if errMsg != "" {
		body["error"] = errMsg
	}
	if st != nil {
		body["stats"] = st
	}
	return d.api(ctx, http.MethodPost, "/api/jobs/"+url.PathEscape(jobID), body, nil)
}

// announce asks the worker for a job row to report a self-found game onto (the
// catalog scan's work: a game whose only upload is one-sided). It answers two
// separate questions, which is why it returns two things:
//
//	jobID != "", mine       report onto this row
//	jobID == "", mine       nobody recorded it; do the work anyway, unreported
//	           , !mine      another daemon holds this game; leave it alone
//
// The distinction is the difference between an hour of engine time going
// unlogged and two machines spending an hour each on the same game. A FAILED
// announce is only bookkeeping lost — the daemon and the worker deploy
// independently, so a worker too old to have the route is routine during a
// rollout, and the re-simulation still has to happen. A DUPLICATE is a
// different statement: somebody else's engine is already on it.
func (d *workerAPI) announce(ctx context.Context, gameID string) (jobID string, mine bool) {
	var out struct {
		Job    string `json:"job"`
		Status string `json:"status"`
	}
	if err := d.api(ctx, http.MethodPost, "/api/jobs",
		map[string]any{"gameId": gameID, "kind": kindResim}, &out); err != nil {
		fmt.Fprintf(os.Stderr, "bringest: %s: could not announce the job (%v); re-simulating unreported\n", gameID, err)
		return "", true
	}
	if out.Status == "duplicate" {
		return "", false
	}
	return out.Job, true
}

// claim takes a job, and unlike report it can legitimately FAIL: the worker
// only allows the transition from pending (or from a processing gone stale),
// so a second daemon polling the same round is told no rather than running the
// same hour of engine work in parallel. The flag is opt-in precisely because
// the upload loop's plain "processing" report must keep succeeding.
func (d *workerAPI) claim(ctx context.Context, jobID, kind string) error {
	return d.api(ctx, http.MethodPost, "/api/jobs/"+url.PathEscape(jobID),
		map[string]any{"state": "processing", "claim": true, "kind": kind}, nil)
}

// beat posts one healthcheck: the "processing" state that keeps the job from
// being offered away, plus — when the caller has a live reading to give — what
// the run is doing right now. Separate from report because the shapes have
// nothing in common: report carries an outcome and a permanent record, this
// carries a snapshot that the next beat overwrites.
func (d *workerAPI) beat(ctx context.Context, jobID string, p *jobProgress) error {
	body := map[string]any{"state": "processing"}
	if p != nil {
		body["progress"] = p
	}
	return d.api(ctx, http.MethodPost, "/api/jobs/"+url.PathEscape(jobID), body, nil)
}

// healthcheck reports in every healthcheckEvery until the returned stop is
// called, so a job that runs for longer than the worker's stale window is not
// offered to somebody else while it is alive — and so the queue page can show
// how far along it is rather than only that it started.
//
// progress is polled at each tick rather than passed once: the run updates its
// reading continuously and this must send whatever is current, not whatever was
// true when the loop began. Nil (or a nil reading) simply beats.
//
// stop WAITS for the goroutine to finish: a beat still in flight when the
// terminal done/error lands would overwrite it and leave the row processing
// forever.
func (d *workerAPI) healthcheck(ctx context.Context, jobID string, progress func() *jobProgress) (stop func()) {
	hctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(healthcheckEvery)
		defer t.Stop()
		for {
			select {
			case <-hctx.Done():
				return
			case <-t.C:
				var p *jobProgress
				if progress != nil {
					p = progress()
				}
				if err := d.beat(hctx, jobID, p); err != nil && hctx.Err() == nil {
					fmt.Fprintf(os.Stderr, "bringest: job %s: healthcheck: %v\n", jobID, err)
				}
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

// api performs one JSON request against the worker, bearer-authenticated.
func (d *workerAPI) api(ctx context.Context, method, path string, body, out any) error {
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

func (d *workerAPI) auth(req *http.Request) {
	if d.token != "" {
		req.Header.Set("Authorization", "Bearer "+d.token)
	}
}

// processStream is the real pipeline: pack the stream (demo-enriched when the
// BAR API knows the game, the stream's own metadata otherwise) and publish it
// under its content-addressed revision. Idempotent: the same stream re-lands
// on the same keys and catalog row.
func processStream(ctx context.Context, client *barapi.Client, streamPath, target, workerDir, indexURL string, stats bool, st *jobStats) error {
	packStart := time.Now()
	brpPath, modOptions, err := packer.Pack(ctx, client, streamPath, filepath.Dir(streamPath), "", false)
	if errors.Is(err, packer.ErrDemoUnavailable) {
		fmt.Fprintf(os.Stderr, "bringest: %v; publishing with the stream's own metadata\n", err)
		brpPath, modOptions, err = packer.Pack(ctx, client, streamPath, filepath.Dir(streamPath), "", true)
	}
	if err != nil {
		return err
	}
	if st != nil {
		st.PackSec = time.Since(packStart).Seconds()
	}
	recordBRP(st, brpPath, stats)
	// AFTER the pack, and from the packed file: the fallback just above is
	// exactly the case a stream hash gets wrong. The same stream published once
	// with the demo metadata and once without produces different .brp bytes,
	// and hashing the stream gave both the same revision — so the second
	// publish overwrote pieces already served as immutable.
	rev, err := packer.ContentRev(brpPath)
	if err != nil {
		return err
	}
	uploadStart := time.Now()
	err = packer.UploadStatic(ctx, brpPath, packer.UploadOptions{
		Target:     target,
		WorkerDir:  workerDir,
		IndexURL:   indexURL,
		Rev:        rev,
		ModOptions: modOptions,
	})
	if st != nil {
		st.UploadSec = time.Since(uploadStart).Seconds()
	}
	return err
}

// recordBRP measures the finished .brp and — when the size report is wanted —
// prints it and keeps a copy on the job's record. Called from both publish
// paths: an upload packs its stream, a re-sim's engine run wrote the file
// directly, but either way this is the same file and the same report.
func recordBRP(st *jobStats, brpPath string, wantReport bool) {
	report := ""
	if wantReport {
		report = reportStats(brpPath)
	}
	if st == nil {
		return
	}
	if fi, err := os.Stat(brpPath); err == nil {
		st.BrpBytes = fi.Size()
	}
	// The report names the file it measured, which here is a temp path on this
	// machine — gone by the time anyone reads the queue page, and nobody
	// else's business. The basename is the part that means anything.
	report = strings.Replace(report, brpPath, filepath.Base(brpPath), 1)
	if len(report) > maxSizeReport {
		report = report[:maxSizeReport]
	}
	st.SizeReport = report
}

// reportStats prints the freshly packed .brp's size breakdown — the same
// report as `pack -stats`, so an unattended publish leaves the same record in
// the log a manual one leaves on the terminal (which is where the sizes get
// compared across replays and codec changes). Best-effort: a measuring failure
// says something about the codec, not about the replay, so it is a warning and
// never costs an otherwise finished publish.
//
// It writes to os.Stderr like everything else here, which teeStderr also
// copies into the log file, and RETURNS the same text so it can ride the job's
// record to the queue page — where it is the only place the numbers are
// visible to somebody who is not reading the daemon's log.
func reportStats(brpPath string) string {
	var buf bytes.Buffer
	if err := packer.ReportStats(&buf, brpPath); err != nil {
		fmt.Fprintf(os.Stderr, "bringest: stats for %s: %v\n", brpPath, err)
		return ""
	}
	os.Stderr.Write(buf.Bytes())
	return buf.String()
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

// resimDaemon is the independent -resim worker. It takes work from two places,
// in this order:
//
//   - REQUESTED re-sims, the queue behind the landing page's paste box
//     (POST /api/resim -> a "resim" job). Someone asked for these by name, and
//     they are the only way a game NOBODY uploaded gets published at all.
//   - the CATALOG SCAN: a game is a candidate while its current upload is
//     one-sided (uploaderAlly set) and its uploads list holds no full-view
//     revision (an entry with a null ally: spectator uploads and re-sim
//     captures PUT with no uploaderAlly). Finding the work needs no queue
//     state — the publish itself retires the candidate — but the run is
//     announced onto a job row so it is visible and reports its progress and
//     stats like the requested ones (runScanned).
//
// The two lists cannot overlap: a requested game is refused while it is in the
// catalog, and a scanned one is in it by definition.
type resimDaemon struct {
	workerAPI
	// resim does the work. pr is non-nil only for a JOB-backed run — it is
	// what the healthcheck reads to report progress, and the catalog scan has
	// no job row to report onto.
	resim func(ctx context.Context, gameID string, st *jobStats, pr *resim.Progress) error
	// failed remembers games whose resim errored (engine missing, unknown
	// demo, desync); they are skipped until the process restarts so one bad
	// game cannot wedge the loop into retrying forever. Only the catalog scan
	// needs it: a requested job leaves the queue by itself once it fails, and
	// re-pasting the link is the retry, whereas a scanned game stays a
	// candidate for as long as its only upload is one-sided — the announced
	// job row records what went wrong for a person to read, but it is not what
	// stops the next round from trying again.
	failed map[string]bool
}

// runOnce drains the requested re-sims, then scans the catalog, re-simulating
// every candidate sequentially (each is minutes of engine wall time). Returns
// how many it attempted; the error covers the listings only — per-game
// failures are reported and do not stop the round.
func (r *resimDaemon) runOnce(ctx context.Context) (int, error) {
	attempted, err := r.runQueued(ctx)
	if err != nil {
		return attempted, err
	}
	if ctx.Err() != nil {
		return attempted, ctx.Err()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.indexURL+"/api/replays", nil)
	if err != nil {
		return attempted, err
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return attempted, fmt.Errorf("listing the catalog: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return attempted, fmt.Errorf("GET /api/replays: %s", resp.Status)
	}
	var rows []catalogRow
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		return attempted, fmt.Errorf("decoding the catalog: %w", err)
	}

	for _, row := range rows {
		if ctx.Err() != nil {
			return attempted, ctx.Err()
		}
		if !row.needsResim() || r.failed[row.ID] {
			continue
		}
		attempted++
		fmt.Fprintf(os.Stderr, "bringest: %s: one-sided only, re-simulating for the full view\n", row.ID)
		if err := r.runScanned(ctx, row.ID); err != nil {
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

// runScanned re-simulates a game the CATALOG SCAN found and reports on it the
// same way a requested one is reported: a job row to be seen in the queue, a
// healthcheck carrying the live phase/progress/engine load while the engine
// runs, and the timings and size report on the terminal state.
//
// The row is ANNOUNCED rather than queued (workerAPI.announce): the work is
// already being done, and POST /api/resim would refuse the game anyway — it is
// in the catalog, which is exactly what makes it a scan candidate. Without a
// row this was an hour of engine time that showed up nowhere and whose stats
// existed only in this daemon's log, on a machine nobody else can reach.
//
// A worker that will not give a row is not a reason to skip the game: the
// re-simulation runs unreported, which is what this whole path did before.
func (r *resimDaemon) runScanned(ctx context.Context, gameID string) error {
	jobID, mine := r.announce(ctx, gameID)
	if !mine {
		fmt.Fprintf(os.Stderr, "bringest: %s: another daemon is already re-simulating it; skipping\n", gameID)
		return nil
	}
	if jobID == "" {
		return r.resim(ctx, gameID, nil, nil)
	}
	if err := r.claim(ctx, jobID, kindResim); err != nil {
		// Somebody else took the row between announcing and claiming it. Their
		// engine, not ours.
		fmt.Fprintf(os.Stderr, "bringest: %s: could not claim job %s (%v); skipping\n", gameID, jobID, err)
		return nil
	}
	started := time.Now()
	pr := &resim.Progress{}
	stop := r.healthcheck(ctx, jobID, func() *jobProgress { return resimProgress(pr) })
	st := &jobStats{}
	err := r.resim(ctx, gameID, st, pr)
	st.TookSec = time.Since(started).Seconds()
	stop() // before the terminal report, or a late beat undoes it
	if err != nil {
		// With the stats, like the queued path: forty minutes that ended badly
		// is the record most worth keeping.
		r.report(ctx, jobID, "error", err.Error(), st)
		return err
	}
	r.report(ctx, jobID, "done", "", st)
	return nil
}

// runQueued works through the re-sims somebody explicitly requested. Unlike
// the catalog scan these are worker-side state, so each one is claimed (the
// worker refuses a job another daemon already holds), healthchecked while the
// engine runs — which is both what keeps the job from being offered away and
// what puts its progress on the queue page — and reported done or error, the
// failure message being what the requester sees there.
func (r *resimDaemon) runQueued(ctx context.Context) (int, error) {
	jobs, err := r.pendingJobs(ctx, kindResim)
	if err != nil {
		return 0, fmt.Errorf("listing queued re-sims: %w", err)
	}
	attempted := 0
	for _, j := range jobs {
		if ctx.Err() != nil {
			return attempted, ctx.Err()
		}
		// A worker too old to filter by kind serves every pending job; an
		// upload is not ours to run, and taking it would strand it.
		if j.Kind != kindResim {
			continue
		}
		if err := r.claim(ctx, j.ID, kindResim); err != nil {
			fmt.Fprintf(os.Stderr, "bringest: %s: could not claim job %s (%v); skipping\n", j.GameID, j.ID, err)
			continue
		}
		attempted++
		fmt.Fprintf(os.Stderr, "bringest: %s: re-sim requested, re-simulating\n", j.GameID)
		started := time.Now()
		// The run keeps this up to date as it goes; the healthcheck reads it
		// every tick and posts it, which is the only window anyone but this
		// daemon has into an hour of engine time.
		pr := &resim.Progress{}
		stop := r.healthcheck(ctx, j.ID, func() *jobProgress { return resimProgress(pr) })
		st := &jobStats{}
		rerr := r.resim(ctx, j.GameID, st, pr)
		st.TookSec = time.Since(started).Seconds()
		stop() // before the terminal report, or a late beat undoes it
		if rerr != nil {
			if ctx.Err() != nil {
				return attempted, ctx.Err()
			}
			fmt.Fprintf(os.Stderr, "bringest: %s: resim failed: %v\n", j.GameID, rerr)
			// With the stats: forty minutes of engine time that ended badly is
			// the record most worth keeping, not the one to throw away.
			r.report(ctx, j.ID, "error", rerr.Error(), st)
			continue
		}
		fmt.Fprintf(os.Stderr, "bringest: %s: full view published\n", j.GameID)
		r.report(ctx, j.ID, "done", "", st)
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
func resimPublish(ctx context.Context, client *barapi.Client, gameID string, ro resim.Options, target, workerDir, indexURL string, stats bool, st *jobStats, pr *resim.Progress) error {
	tmp, err := os.MkdirTemp("", "bringest-resim-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	ro.OutDir = tmp
	ro.Progress = pr
	// Run fills this in as it goes, so a failure below still carries how far
	// the engine got and what its log said.
	var run resim.RunStats
	ro.Stats = &run
	brpPath, modOptions, rerr := resim.Run(ctx, client, gameID, ro)
	if st != nil {
		st.fromRunStats(run)
	}
	if rerr != nil {
		return rerr
	}
	// No PackSec here: a re-sim has no separate pack step — resim.Run's engine
	// writes the .brp itself, and that cost is ResimSec.
	pr.SetPhase(phasePacking)
	recordBRP(st, brpPath, stats)
	rev, err := packer.ContentRev(brpPath) // content hash of any file; here the .brp
	if err != nil {
		return err
	}
	pr.SetPhase(phaseUploading)
	uploadStart := time.Now()
	err = packer.UploadStatic(ctx, brpPath, packer.UploadOptions{
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
	if st != nil {
		st.UploadSec = time.Since(uploadStart).Seconds()
	}
	return err
}
