package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/mabn/barreplay/internal/engine"
	"github.com/mabn/barreplay/internal/packer"
	"github.com/mabn/barreplay/internal/resim"
	"github.com/mabn/barreplay/snapshot"
)

// Every re-simulation the app runs is a job in the site's queue, like the
// ones bringest -resim runs: created when the run starts, healthchecked every
// reportEvery with what the run is doing (the queue page charts those), and
// ended with what it cost. The routes are the worker's open /api/app/jobs
// pair, which only ever touch the app's own jobs. Reporting is best-effort
// throughout: a site that cannot be reached never costs a run anything.

// newInstallID makes a UUIDv7: 48 bits of Unix milliseconds, then random
// bits, with the version and variant set. Time-ordered, so a list of installs
// sorts by when each first ran.
func newInstallID() string {
	var b [16]byte
	if _, err := rand.Read(b[6:]); err != nil {
		// crypto/rand does not fail on any supported platform; the time
		// prefix alone still makes a usable id.
		_ = err
	}
	var ms [8]byte
	binary.BigEndian.PutUint64(ms[:], uint64(time.Now().UnixMilli()))
	copy(b[0:6], ms[2:8])
	b[6] = 0x70 | b[6]&0x0f
	b[8] = 0x80 | b[8]&0x3f
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// reportEvery is how often a running job reports in: the pace bringest beats
// at, so the queue page's charts read the same for both.
var reportEvery = 10 * time.Second

// jobStats is the app's half of the worker's JobStats contract
// (worker/src/worker/jobs.ts); its JSON names are those cmd/bringest's
// jobStats uses, so the queue page reads both the same way, plus the app's
// own: App, Phases, the peaks and UploadJob.
type jobStats struct {
	TookSec   float64 `json:"tookSec,omitempty"`
	UploadSec float64 `json:"uploadSec,omitempty"`
	BrpBytes  int64   `json:"brpBytes,omitempty"`

	ResimSec      float64 `json:"resimSec,omitempty"`
	LoadSec       float64 `json:"loadSec,omitempty"`
	SimSec        float64 `json:"simSec,omitempty"`
	Frames        int32   `json:"frames,omitempty"`
	Samples       int     `json:"samples,omitempty"`
	SpeedUp       float64 `json:"speedUp,omitempty"`
	GameSec       int32   `json:"gameSec,omitempty"`
	EngineVersion string  `json:"engineVersion,omitempty"`
	EnginePatched bool    `json:"enginePatched,omitempty"`
	// PatchedBuild names the published patched build the run used.
	PatchedBuild string `json:"patchedBuild,omitempty"`

	Infolog    *infologStats `json:"infolog,omitempty"`
	SizeReport string        `json:"sizeReport,omitempty"`

	WidgetVersion string `json:"widgetVersion,omitempty"`
	WidgetSha     string `json:"widgetSha,omitempty"`
	WidgetDate    string `json:"widgetDate,omitempty"`
	BrpVersion    int    `json:"brpVersion,omitempty"`

	Host *hostInfo `json:"host,omitempty"`
	App  *appInfo  `json:"app,omitempty"`

	// Phases is wall time per phase, in the order the run went through them:
	// how long the demo, the content download, the engine's load and the
	// simulation each took, which is where a slow run's time went.
	Phases []phaseTime `json:"phases,omitempty"`
	// The engine's highest memory and swap over the run.
	PeakRssBytes  int64 `json:"peakRssBytes,omitempty"`
	PeakSwapBytes int64 `json:"peakSwapBytes,omitempty"`
	// UploadJob is the queue job that publishes the uploaded .brp.
	UploadJob string `json:"uploadJob,omitempty"`
}

type infologStats struct {
	Bytes     int64 `json:"bytes"`
	Lines     int   `json:"lines,omitempty"`
	LastFrame int32 `json:"lastFrame,omitempty"`
	Desyncs   int   `json:"desyncs"`
	Warnings  int   `json:"warnings,omitempty"`
}

// appInfo says which app made the job, and how it was asked to.
type appInfo struct {
	Name          string `json:"name"`
	Version       string `json:"version"`
	InstallID     string `json:"installId"`
	GoVersion     string `json:"goVersion,omitempty"`
	Auto          bool   `json:"auto"`
	MinFreeMB     int    `json:"minFreeMB,omitempty"`
	PatchedEngine bool   `json:"patchedEngine"`
	// Runs is how many re-sims this install started before this one.
	Runs int `json:"runs"`
}

// hostInfo is the machine. No hostname, unlike bringest's: a volunteer's PC
// name is theirs, and the install id already tells one machine from another.
type hostInfo struct {
	MemBytes      int64  `json:"memBytes,omitempty"`
	Cores         int    `json:"cores,omitempty"`
	Threads       int    `json:"threads,omitempty"`
	CPUModel      string `json:"cpuModel,omitempty"`
	OS            string `json:"os,omitempty"`
	OSBuild       string `json:"osBuild,omitempty"`
	MemFreeBytes  int64  `json:"memFreeBytes,omitempty"`
	DiskFreeBytes int64  `json:"diskFreeBytes,omitempty"`
}

type phaseTime struct {
	Phase string  `json:"phase"`
	Sec   float64 `json:"sec"`
}

// jobProgress is one healthcheck's reading: the worker's JobProgress, as
// cmd/bringest's jobProgress sends it.
type jobProgress struct {
	State       string  `json:"state,omitempty"`
	Frame       int32   `json:"frame,omitempty"`
	TotalFrames int32   `json:"totalFrames,omitempty"`
	Percent     float64 `json:"percent,omitempty"`
	EtaSec      float64 `json:"etaSec,omitempty"`
	SimFps      float64 `json:"simFps,omitempty"`
	RssBytes    int64   `json:"rssBytes,omitempty"`
	CpuPct      float64 `json:"cpuPct,omitempty"`
	SwapBytes   int64   `json:"swapBytes"`
	ElapsedSec  float64 `json:"elapsedSec,omitempty"`
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }

// progressOf converts a reading to the wire shape; phase overrides the
// run's own once resim.Run has returned (saving, uploading).
func progressOf(s resim.ProgressState, phase string, elapsed time.Duration) *jobProgress {
	p := &jobProgress{
		State:       s.Phase,
		Frame:       s.Frame,
		TotalFrames: s.TotalFrames,
		Percent:     round1(s.Percent),
		EtaSec:      float64(int64(s.ETASec)),
		SimFps:      round1(s.SimFPS),
		RssBytes:    s.RSSBytes,
		SwapBytes:   s.SwapBytes,
		CpuPct:      round1(s.CPUPercent),
		ElapsedSec:  float64(int64(elapsed.Seconds())),
	}
	if phase != "" {
		p.State = phase
	}
	if p.State == "" {
		p.State = resim.PhaseFetchingDemo
	}
	return p
}

// fromRunStats copies what the re-simulation measured.
func (s *jobStats) fromRunStats(r resim.RunStats) {
	s.ResimSec, s.LoadSec, s.SimSec = r.EngineSec, r.LoadSec, r.SimSec
	s.Frames, s.Samples, s.SpeedUp = r.Frames, r.Samples, r.SpeedUp
	s.GameSec, s.EngineVersion, s.EnginePatched = r.GameSec, r.EngineVersion, r.EnginePatched
	if r.EnginePatched && r.EngineVersion != "" {
		s.PatchedBuild = engine.PinnedPatchedVersion(r.EngineVersion)
	}
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

// maxSizeReport caps the report like bringest does.
const maxSizeReport = 16 << 10

// recordBRP measures the finished .brp: its size, the `pack -stats`
// breakdown, its container version and the widget build that wrote it.
func (s *jobStats) recordBRP(path string) {
	if fi, err := os.Stat(path); err == nil {
		s.BrpBytes = fi.Size()
	}
	var buf bytes.Buffer
	if err := packer.ReportStats(&buf, path); err == nil {
		// The report names the file it measured; this PC's folders are
		// nobody else's business.
		r := strings.ReplaceAll(buf.String(), path, filepath.Base(path))
		if len(r) > maxSizeReport {
			r = r[:maxSizeReport]
		}
		s.SizeReport = r
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	bf, err := snapshot.ParseBRP(bufio.NewReader(f))
	if err != nil {
		return
	}
	s.BrpVersion = int(bf.Version)
	if w := bf.Meta.Widget; w != nil {
		s.WidgetVersion, s.WidgetSha, s.WidgetDate = w.Version, w.Sha, w.Date
	}
}

// readHost reads the machine once per run (free memory and disk change).
func readHost(dataDir string) *hostInfo {
	h := &hostInfo{Threads: runtime.NumCPU()}
	h.MemBytes, _ = engine.MemTotal()
	h.MemFreeBytes, _ = engine.MemAvailable()
	h.CPUModel, h.Cores = cpuInfo()
	h.OS, h.OSBuild = osInfo()
	h.DiskFreeBytes = diskFree(dataDir)
	return h
}

// ---- the queue job ---------------------------------------------------------

// queueJob reports one run to the site. Its methods are safe to call however
// the site answers: until a create succeeds there is no job, every beat tries
// to create it again, and a run the site never heard of finishes silently.
type queueJob struct {
	a   *App
	run *jobRun
	st  *jobStats // the opening stats: app + host

	mu       sync.Mutex
	id       string
	phase    string
	phaseAt  time.Time
	phases   []phaseTime
	peakRSS  int64
	peakSwap int64

	stop chan struct{}
	done chan struct{}
}

// startQueueJob creates the run's job and starts its healthcheck. It never
// blocks the run: the create happens on the healthcheck's goroutine.
func (a *App) startQueueJob(run *jobRun, cfg Config) *queueJob {
	q := &queueJob{
		a:   a,
		run: run,
		st: &jobStats{
			Host: readHost(cfg.DataDir),
			App: &appInfo{
				Name:          "FogOfWar",
				Version:       version,
				InstallID:     cfg.InstallID,
				GoVersion:     runtime.Version(),
				Auto:          run.auto,
				MinFreeMB:     cfg.MinFreeMB,
				PatchedEngine: cfg.PatchedEngine,
				Runs:          cfg.Runs,
			},
		},
		phaseAt: run.started,
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	go q.loop()
	return q
}

func (q *queueJob) loop() {
	defer close(q.done)
	if q.create() {
		q.beat() // the run's first reading, however short it turns out
	}
	sample := time.NewTicker(time.Second)
	defer sample.Stop()
	beat := time.NewTicker(reportEvery)
	defer beat.Stop()
	for {
		select {
		case <-q.stop:
			return
		case <-sample.C:
			q.observe()
		case <-beat.C:
			if q.jobID() == "" {
				if q.create() {
					q.beat()
				}
				continue
			}
			q.beat()
		}
	}
}

// beat posts one healthcheck with the run's reading now. The queue page
// charts these, so a run beats as it starts and once more as it ends, on top
// of every reportEvery: a run of a few seconds still draws a line.
func (q *queueJob) beat() {
	id := q.jobID()
	if id == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := postJSON(ctx, "/api/app/jobs/"+url.PathEscape(id), map[string]any{
		"state":    "processing",
		"progress": q.progress(),
	}, nil); err != nil {
		q.a.logf("queue report: %v", err)
	}
}

func (q *queueJob) jobID() string {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.id
}

// create adds the run to the site's queue and says whether it did.
func (q *queueJob) create() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var out struct {
		Job string `json:"job"`
	}
	err := postJSON(ctx, "/api/app/jobs", map[string]any{
		"gameId":    q.run.gameID,
		"installId": q.st.App.InstallID,
		"stats":     q.st,
	}, &out)
	if err != nil || out.Job == "" {
		if err == nil {
			err = fmt.Errorf("the site named no job")
		}
		q.a.logf("queue: could not add this run to the site's queue: %v", err)
		return false
	}
	q.mu.Lock()
	q.id = out.Job
	q.mu.Unlock()
	q.a.logf("Reporting progress to the site's queue (job %s)", out.Job)
	return true
}

// current is the run's reading and phase as the window would show them.
func (q *queueJob) current() (resim.ProgressState, string) {
	s := q.run.progress.Snapshot()
	q.a.mu.Lock()
	phase := q.run.phase
	q.a.mu.Unlock()
	if phase == "" {
		phase = s.Phase
	}
	if phase == "" {
		phase = resim.PhaseFetchingDemo
	}
	return s, phase
}

// observe notes the phase and the engine's peaks, once a second.
func (q *queueJob) observe() {
	s, phase := q.current()
	q.mu.Lock()
	defer q.mu.Unlock()
	q.notePhase(phase, time.Now())
	q.peakRSS = max(q.peakRSS, s.RSSBytes)
	q.peakSwap = max(q.peakSwap, s.SwapBytes)
}

// notePhase closes the phase that was running when a new one starts.
func (q *queueJob) notePhase(phase string, now time.Time) {
	if phase == q.phase {
		return
	}
	if q.phase != "" {
		q.phases = append(q.phases, phaseTime{q.phase, round1(now.Sub(q.phaseAt).Seconds())})
	}
	q.phase, q.phaseAt = phase, now
}

func (q *queueJob) progress() *jobProgress {
	s, phase := q.current()
	return progressOf(s, phase, time.Since(q.run.started))
}

// finish stops the healthcheck and reports the run's end with its stats:
// done, or error with the message (and errorKind "oom" when the memory guard
// stopped it). It waits for the beat loop first, so a beat still in flight
// cannot put a finished job back into "processing".
func (q *queueJob) finish(st *jobStats, errMsg, errKind string) {
	close(q.stop)
	<-q.done
	q.observe() // the phase that was running now, however short
	// The last reading, before done/error clears the live one: with the
	// first, a run shorter than reportEvery still has two points to chart.
	q.beat()
	q.mu.Lock()
	q.notePhase("", time.Now())
	st.Phases = q.phases
	st.PeakRssBytes, st.PeakSwapBytes = q.peakRSS, q.peakSwap
	id := q.id
	q.mu.Unlock()
	st.Host, st.App = q.st.Host, q.st.App
	if id == "" {
		q.create()
		if id = q.jobID(); id == "" {
			return
		}
	}
	body := map[string]any{"state": "done", "stats": st}
	if errMsg != "" {
		body["state"], body["error"] = "error", errMsg
		if errKind != "" {
			body["errorKind"] = errKind
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := postJSON(ctx, "/api/app/jobs/"+url.PathEscape(id), body, nil); err != nil {
		q.a.logf("queue report: %v", err)
	}
}

// postJSON posts one JSON body to the site and decodes the answer into out.
func postJSON(ctx context.Context, path string, body, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, siteURL()+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return siteRefusal(resp, path)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}

// trimSpaces collapses the runs of spaces some CPU names are padded with.
func trimSpaces(s string) string { return strings.Join(strings.Fields(s), " ") }
