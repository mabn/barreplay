package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"sync"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/mabn/barreplay/internal/barapi"
	"github.com/mabn/barreplay/internal/engine"
	"github.com/mabn/barreplay/internal/resim"
)

// App is everything the window can ask of the program. Its exported methods
// are the whole API the web page sees (Wails binds them as
// window.go.main.App.<Name>), so they are kept few and narrow: the page can
// ask for a game to be re-simulated, change four settings and open folders,
// and nothing else — no paths it chose, no commands, no files read back.
//
// State flows the other way as events: "state" carries a full State whenever
// anything changed (at most every 250 ms while busy), "log" new log lines.
type App struct {
	ctx    context.Context
	root   string
	client *barapi.Client
	log    *logTee
	fc     *resim.Forecaster

	mu        sync.Mutex
	cfg       Config
	mode      string // modeSetup, modeSetupFailed, modeReady, modeRunning
	steps     []Step
	setupErr  string
	job       *jobRun
	last      *HistoryItem
	cancel    context.CancelFunc
	done      chan struct{} // closed when the running operation returns
	dl        transfer      // newest HTTP download (engine.DownloadProgress)
	prd       transfer      // newest pr-downloader reading, from its output
	dirty     bool
	quitting  bool
	startedAt time.Time
}

const (
	modeSetup       = "setup"
	modeSetupFailed = "setupFailed"
	modeReady       = "ready"
	modeRunning     = "running"
)

// Step is one line of the first-run checklist.
type Step struct {
	Key     string  `json:"key"`
	Label   string  `json:"label"`
	Status  string  `json:"status"` // pending, active, done, skipped, failed
	Detail  string  `json:"detail"`
	Percent float64 `json:"percent"` // -1 while nothing is measurable
	Done    int64   `json:"done"`
	Total   int64   `json:"total"`
}

// transfer is the newest reading of a download in flight.
type transfer struct {
	label       string
	done, total int64
	percent     float64
	at          time.Time
}

// Download is a transfer as the page sees it.
type Download struct {
	Label   string  `json:"label"`
	Done    int64   `json:"done"`
	Total   int64   `json:"total"`
	Percent float64 `json:"percent"`
}

type jobRun struct {
	gameID   string
	preview  *GamePreview
	progress *resim.Progress
	stats    *resim.RunStats
	started  time.Time
	phase    string // overrides the progress phase once Run returns
}

// JobView is the running re-simulation.
type JobView struct {
	GameID      string       `json:"gameId"`
	Preview     *GamePreview `json:"preview,omitempty"`
	Phase       string       `json:"phase"`
	Frame       int32        `json:"frame"`
	TotalFrames int32        `json:"totalFrames"`
	Percent     float64      `json:"percent"`
	ETASec      float64      `json:"etaSec"`
	SimFPS      float64      `json:"simFps"`
	RSSBytes    int64        `json:"rssBytes"`
	CPUPercent  float64      `json:"cpuPercent"`
	ElapsedSec  float64      `json:"elapsedSec"`
	Patched     bool         `json:"patched"`
	Download    *Download    `json:"download,omitempty"`
}

// State is everything the window draws.
type State struct {
	Mode       string        `json:"mode"`
	Steps      []Step        `json:"steps"`
	SetupError string        `json:"setupError,omitempty"`
	Setup      SetupRecord   `json:"setup"`
	Job        *JobView      `json:"job,omitempty"`
	Last       *HistoryItem  `json:"last,omitempty"`
	History    []HistoryItem `json:"history"`
	Settings   Settings      `json:"settings"`
	HostRAM    int64         `json:"hostRam"`
	Cores      int           `json:"cores"`
	Version    string        `json:"version"`
}

// Settings is the part of the config the page may change.
type Settings struct {
	DataDir       string `json:"dataDir"`
	OutputDir     string `json:"outputDir"`
	PatchedEngine bool   `json:"patchedEngine"`
	MinFreeMB     int    `json:"minFreeMB"`
}

var version = "dev"

func NewApp(root string, cfg Config, log *logTee) *App {
	return &App{
		root:   root,
		cfg:    cfg,
		client: barapi.New(),
		log:    log,
		fc:     &resim.Forecaster{},
		mode:   modeReady,
		steps:  newSetupSteps(),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go a.pump()
	if setupNeeded(a.config()) {
		a.beginSetup()
	}
}

// beforeClose asks before abandoning a run; quitting mid-download is fine.
func (a *App) beforeClose(ctx context.Context) bool {
	a.mu.Lock()
	running := a.mode == modeRunning && !a.quitting
	a.mu.Unlock()
	if !running {
		return false
	}
	ans, err := wruntime.MessageDialog(ctx, wruntime.MessageDialogOptions{
		Type:          wruntime.QuestionDialog,
		Title:         "Stop the re-simulation?",
		Message:       "A game is being re-simulated. Quitting stops it, and the replay will not be saved.",
		Buttons:       []string{"Quit", "Keep running"},
		DefaultButton: "Keep running",
		CancelButton:  "Keep running",
	})
	return err == nil && ans != "Quit" && ans != "Yes"
}

// shutdown stops whatever runs and waits for the engine to go, so the data
// dir's lock and the engine process do not outlive the window.
func (a *App) shutdown(context.Context) {
	a.mu.Lock()
	cancel, done := a.cancel, a.done
	a.mu.Unlock()
	if cancel != nil {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
		}
	}
}

// ---- the API the page calls ----

// Quit closes the app. The page asks the user first (with its own dialog)
// when a run would be lost, so this does not ask again.
func (a *App) Quit() {
	a.mu.Lock()
	a.quitting = true
	a.mu.Unlock()
	wruntime.Quit(a.ctx)
}

// PasteText is the clipboard's text, for the paste button.
func (a *App) PasteText() string {
	s, _ := wruntime.ClipboardGetText(a.ctx)
	return s
}

// GetState is the page's first read; afterwards it listens for "state".
func (a *App) GetState() State { return a.snapshot() }

// GetLog is the log so far; afterwards the page listens for "log".
func (a *App) GetLog() []string { return a.log.all() }

// ResolveGame looks a pasted link or id up, for the preview card.
func (a *App) ResolveGame(input string) (*GamePreview, error) {
	id, err := barapi.ParseGameID(input)
	if err != nil {
		return nil, errors.New("That doesn't look like a game link or ID.")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()
	p, err := fetchPreview(ctx, id)
	if err != nil {
		return nil, err
	}
	a.annotate(p)
	return p, nil
}

// StartResim re-simulates the game a pasted link or id names.
func (a *App) StartResim(input string) error {
	id, err := barapi.ParseGameID(input)
	if err != nil {
		return errors.New("That doesn't look like a game link or ID.")
	}
	a.mu.Lock()
	if a.mode != modeReady && a.mode != modeSetupFailed {
		a.mu.Unlock()
		if a.mode == modeRunning {
			return errors.New("A game is already being re-simulated.")
		}
		return errors.New("Still downloading the engine and game; it can start once that is done.")
	}
	ctx, cancel := context.WithCancel(context.Background())
	run := &jobRun{
		gameID:   id,
		progress: &resim.Progress{},
		stats:    &resim.RunStats{},
		started:  time.Now(),
	}
	a.job, a.last, a.mode = run, nil, modeRunning
	a.cancel, a.done = cancel, make(chan struct{})
	a.dl, a.prd = transfer{}, transfer{}
	done := a.done
	a.dirty = true
	a.mu.Unlock()

	// The preview is for the running card; the run does not wait for it.
	go func() {
		pctx, pcancel := context.WithTimeout(ctx, 20*time.Second)
		defer pcancel()
		if p, err := fetchPreview(pctx, id); err == nil {
			a.annotate(p)
			a.mu.Lock()
			if a.job == run {
				run.preview = p
				a.dirty = true
			}
			a.mu.Unlock()
		}
	}()
	go func() {
		defer close(done)
		a.runJob(ctx, run)
	}()
	return nil
}

// Cancel stops the running re-simulation or download.
func (a *App) Cancel() {
	a.mu.Lock()
	cancel := a.cancel
	a.mu.Unlock()
	if cancel != nil {
		a.logf("Stopping…")
		cancel()
	}
}

// RetrySetup runs the first-run download again after it failed.
func (a *App) RetrySetup() {
	a.mu.Lock()
	ok := a.mode == modeSetupFailed || a.mode == modeReady
	a.mu.Unlock()
	if ok {
		a.beginSetup()
	}
}

// DismissResult clears the finished card.
func (a *App) DismissResult() {
	a.mu.Lock()
	a.last = nil
	a.dirty = true
	a.mu.Unlock()
}

// SaveSettings stores the settings. Moving the data folder means the engine
// and game have to be downloaded there again.
func (a *App) SaveSettings(s Settings) (State, error) {
	a.mu.Lock()
	if a.mode == modeRunning || a.mode == modeSetup {
		a.mu.Unlock()
		return a.snapshot(), errors.New("Settings can be changed once the current work has finished.")
	}
	moved := false
	if s.DataDir != "" && filepath.Clean(s.DataDir) != filepath.Clean(a.cfg.DataDir) {
		a.cfg.DataDir = filepath.Clean(s.DataDir)
		a.cfg.Setup = SetupRecord{}
		moved = true
	}
	if s.OutputDir != "" {
		a.cfg.OutputDir = filepath.Clean(s.OutputDir)
	}
	a.cfg.PatchedEngine = s.PatchedEngine
	if s.MinFreeMB >= 128 && s.MinFreeMB <= 8192 {
		a.cfg.MinFreeMB = s.MinFreeMB
	}
	err := saveConfig(a.root, a.cfg)
	a.dirty = true
	a.mu.Unlock()
	if moved {
		a.beginSetup()
	}
	return a.snapshot(), err
}

// ChooseFolder opens the system folder picker; "" when cancelled.
func (a *App) ChooseFolder(title, start string) string {
	dir, err := wruntime.OpenDirectoryDialog(a.ctx, wruntime.OpenDialogOptions{
		Title:                title,
		DefaultDirectory:     start,
		CanCreateDirectories: true,
	})
	if err != nil {
		return ""
	}
	return dir
}

// OpenFolder opens one of the app's folders: "output", "data" or "app".
func (a *App) OpenFolder(which string) error {
	c := a.config()
	dir := map[string]string{"output": c.OutputDir, "data": c.DataDir, "app": a.root}[which]
	if dir == "" {
		return errors.New("no such folder")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return openPath(dir, false)
}

// ShowReplay selects a finished replay in the file manager. Only paths in the
// history can be named, so the page cannot open arbitrary files.
func (a *App) ShowReplay(gameID string) error {
	c := a.config()
	for _, h := range c.History {
		if h.GameID == gameID && h.Path != "" {
			if !fileExists(h.Path) {
				return errors.New("The file is no longer there.")
			}
			return openPath(h.Path, true)
		}
	}
	return errors.New("No replay for that game.")
}

// OpenLog opens fogofwar.log in the default text editor.
func (a *App) OpenLog() error {
	return openPath(filepath.Join(a.root, "fogofwar.log"), false)
}

// ---- the work ----

func (a *App) beginSetup() {
	ctx, cancel := context.WithCancel(context.Background())
	a.mu.Lock()
	if a.mode == modeRunning || a.mode == modeSetup {
		a.mu.Unlock()
		cancel()
		return
	}
	a.mode, a.steps, a.setupErr = modeSetup, newSetupSteps(), ""
	a.cancel, a.done = cancel, make(chan struct{})
	a.startedAt = time.Now()
	done := a.done
	a.dirty = true
	a.mu.Unlock()
	go func() {
		defer close(done)
		err := a.runSetup(ctx)
		a.mu.Lock()
		defer a.mu.Unlock()
		a.cancel = nil
		a.dirty = true
		if err != nil {
			a.mode = modeSetupFailed
			if ctx.Err() != nil {
				a.setupErr = "The download was stopped."
			} else {
				a.setupErr = err.Error()
			}
			a.logf("setup failed: %v", err)
			return
		}
		a.mode = modeReady
		a.logf("Ready: engine %s, %s", a.cfg.Setup.EngineVersion, shortGameVersion(a.cfg.Setup.GameVersion))
	}()
}

func (a *App) runJob(ctx context.Context, run *jobRun) {
	cfg := a.config()
	work := filepath.Join(a.root, "work")
	item := HistoryItem{GameID: run.gameID}
	err := func() error {
		if err := os.MkdirAll(work, 0o755); err != nil {
			return err
		}
		if err := os.MkdirAll(cfg.OutputDir, 0o755); err != nil {
			return err
		}
		a.logf("Re-simulating %s", run.gameID)
		brp, _, err := resim.Run(ctx, a.client, run.gameID, resim.Options{
			DataDir:       cfg.DataDir,
			OutDir:        work,
			PatchedEngine: cfg.PatchedEngine,
			ProgressEvery: 30 * time.Second,
			Forecaster:    a.fc,
			Stats:         run.stats,
			MinFreeBytes:  int64(cfg.MinFreeMB) << 20,
			Progress:      run.progress,
			OnlyLocal:     true,
		})
		if err != nil {
			return err
		}
		a.setJobPhase(run, "saving")
		dst := filepath.Join(cfg.OutputDir, run.gameID+".brp")
		if err := moveInto(brp, dst); err != nil {
			return err
		}
		// The raw stream is an intermediate the .brp was made from; at
		// hundreds of megabytes it is not worth keeping.
		os.Remove(filepath.Join(work, run.gameID+".brepstream"))
		item.Path = dst
		if st, err := os.Stat(dst); err == nil {
			item.Bytes = st.Size()
		}
		return nil
	}()
	s := run.stats
	item.TookSec = time.Since(run.started).Seconds()
	item.GameSec = float64(s.GameSec)
	item.SpeedUp = s.SpeedUp
	item.Patched = s.EnginePatched
	item.FinishedAt = time.Now()
	a.mu.Lock()
	if p := run.preview; p != nil {
		item.Map, item.MapFile, item.Size = p.Map, p.MapFile, p.Size
		if item.GameSec == 0 {
			item.GameSec = p.DurationSec
		}
	}
	a.mu.Unlock()
	switch {
	case err == nil:
		a.logf("Saved %s (%s) in %s", item.Path, engine.FormatBytes(item.Bytes), fmtDur(item.TookSec))
	case ctx.Err() != nil:
		item.Error = "Stopped"
		a.logf("Stopped %s", run.gameID)
	case errors.Is(err, resim.ErrOutOfMemory):
		item.Error = "This computer ran out of memory for this game. Close other programs, or try a smaller game."
		a.logf("out of memory: %v", err)
	default:
		item.Error = err.Error()
		a.logf("failed: %v", err)
	}
	// Never leave a half-written stream behind in the work folder.
	if err != nil {
		os.Remove(filepath.Join(work, run.gameID+".brepstream"))
		os.Remove(filepath.Join(work, run.gameID+".brp"))
	}

	a.mu.Lock()
	a.cfg.History = append([]HistoryItem{item}, a.cfg.History...)
	if len(a.cfg.History) > maxHistory {
		a.cfg.History = a.cfg.History[:maxHistory]
	}
	if serr := saveConfig(a.root, a.cfg); serr != nil {
		a.logf("save config: %v", serr)
	}
	a.mode, a.job, a.cancel = modeReady, nil, nil
	last := item
	a.last = &last
	a.dirty = true
	a.mu.Unlock()
}

func (a *App) setJobPhase(run *jobRun, phase string) {
	a.mu.Lock()
	run.phase = phase
	a.dirty = true
	a.mu.Unlock()
}

// ---- state ----

func (a *App) config() Config {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

func (a *App) updateConfig(f func(*Config)) {
	a.mu.Lock()
	f(&a.cfg)
	if err := saveConfig(a.root, a.cfg); err != nil {
		a.log.Logf("save config: " + err.Error())
	}
	a.dirty = true
	a.mu.Unlock()
}

func (a *App) logf(format string, args ...any) { a.log.Logf(fmt.Sprintf(format, args...)) }

func (a *App) setStep(i int, f func(*Step)) {
	a.mu.Lock()
	if i >= 0 && i < len(a.steps) {
		f(&a.steps[i])
	}
	a.dirty = true
	a.mu.Unlock()
}

func (a *App) stepStart(i int, detail string) {
	a.setStep(i, func(s *Step) { s.Status, s.Detail, s.Percent = "active", detail, -1 })
}
func (a *App) stepDone(i int, detail string) {
	a.setStep(i, func(s *Step) { s.Status, s.Detail, s.Percent = "done", detail, 100 })
}
func (a *App) stepSkip(i int, detail string) {
	a.setStep(i, func(s *Step) { s.Status, s.Detail = "skipped", detail })
}
func (a *App) stepFail(i int, err error) {
	a.setStep(i, func(s *Step) { s.Status, s.Detail = "failed", err.Error() })
}

// watchDownloads forgets older transfers, so a step only shows its own.
func (a *App) watchDownloads(int) {
	a.mu.Lock()
	a.dl, a.prd = transfer{}, transfer{}
	a.mu.Unlock()
}

// onDownload is engine.DownloadProgress: the engine and patched-engine
// downloads report bytes as they arrive.
func (a *App) onDownload(url string, done, total int64) {
	a.mu.Lock()
	a.dl = transfer{label: filepath.Base(url), done: done, total: total, at: time.Now()}
	if total > 0 {
		a.dl.percent = 100 * float64(done) / float64(total)
	}
	a.dirty = true
	a.mu.Unlock()
}

// pr-downloader redraws "[Progress]  42% [=====     ] 1234/5678" as it goes.
var (
	prdProgressRE = regexp.MustCompile(`\[Progress\]\s*(\d+(?:\.\d+)?)%(?:\s*\[[^\]]*\]\s*(\d+)/(\d+))?`)
	prdPercentRE  = regexp.MustCompile(`(\d{1,3}(?:\.\d+)?)%`)
)

// onLogLine reads download percentages out of pr-downloader's output.
func (a *App) onLogLine(line string) {
	m := prdProgressRE.FindStringSubmatch(line)
	if m == nil {
		return
	}
	pct, _ := strconv.ParseFloat(m[1], 64)
	t := transfer{label: "BAR content", percent: pct, at: time.Now()}
	if m[2] != "" {
		t.done, _ = strconv.ParseInt(m[2], 10, 64)
		t.total, _ = strconv.ParseInt(m[3], 10, 64)
	}
	a.mu.Lock()
	a.prd = t
	a.dirty = true
	a.mu.Unlock()
}

// currentDownload is whichever transfer reported last, if it is still live.
func (a *App) currentDownload() *Download {
	t := a.dl
	if a.prd.at.After(t.at) {
		t = a.prd
	}
	if t.at.IsZero() || time.Since(t.at) > 5*time.Second || (t.total > 0 && t.done >= t.total && t.percent >= 100) {
		return nil
	}
	return &Download{Label: t.label, Done: t.done, Total: t.total, Percent: t.percent}
}

func (a *App) snapshot() State {
	host, _ := engine.MemTotal()
	a.mu.Lock()
	defer a.mu.Unlock()
	st := State{
		Mode:       a.mode,
		Steps:      append([]Step(nil), a.steps...),
		SetupError: a.setupErr,
		Setup:      a.cfg.Setup,
		Last:       a.last,
		History:    append([]HistoryItem(nil), a.cfg.History...),
		Settings: Settings{
			DataDir:       a.cfg.DataDir,
			OutputDir:     a.cfg.OutputDir,
			PatchedEngine: a.cfg.PatchedEngine,
			MinFreeMB:     a.cfg.MinFreeMB,
		},
		HostRAM: host,
		Cores:   runtime.NumCPU(),
		Version: version,
	}
	if a.mode == modeSetup {
		if d := a.currentDownload(); d != nil {
			for i := range st.Steps {
				if st.Steps[i].Status == "active" {
					st.Steps[i].Percent, st.Steps[i].Done, st.Steps[i].Total = d.Percent, d.Done, d.Total
				}
			}
		}
	}
	if r := a.job; r != nil {
		p := r.progress.Snapshot()
		v := &JobView{
			GameID:      r.gameID,
			Preview:     r.preview,
			Phase:       p.Phase,
			Frame:       p.Frame,
			TotalFrames: p.TotalFrames,
			Percent:     p.Percent,
			ETASec:      p.ETASec,
			SimFPS:      p.SimFPS,
			RSSBytes:    p.RSSBytes,
			CPUPercent:  p.CPUPercent,
			ElapsedSec:  time.Since(r.started).Seconds(),
			Patched:     r.stats.EnginePatched,
		}
		if r.phase != "" {
			v.Phase = r.phase
		}
		if v.Phase == "" {
			v.Phase = resim.PhaseFetchingDemo
		}
		v.Download = a.currentDownload()
		st.Job = v
	}
	return st
}

// pump sends the page what changed: state when something did (and every
// quarter second while work runs, since elapsed time always does), and the
// log lines that arrived.
func (a *App) pump() {
	t := time.NewTicker(250 * time.Millisecond)
	defer t.Stop()
	for range t.C {
		if lines := a.log.take(); len(lines) > 0 {
			wruntime.EventsEmit(a.ctx, "log", lines)
		}
		a.mu.Lock()
		send := a.dirty || a.mode == modeRunning || a.mode == modeSetup
		a.dirty = false
		a.mu.Unlock()
		if send {
			wruntime.EventsEmit(a.ctx, "state", a.snapshot())
		}
	}
}

// ---- helpers ----

func stockExe() string {
	if runtime.GOOS == "windows" {
		return "spring-headless.exe"
	}
	return "spring-headless"
}

func patchedExe() string {
	if runtime.GOOS == "windows" {
		return "spring-headless-patched.exe"
	}
	return "spring-headless-patched"
}

// moveInto renames src to dst, replacing dst, copying across volumes (the
// output folder may be on another drive than the app's own).
func moveInto(src, dst string) error {
	os.Remove(dst)
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".part"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := out.ReadFrom(in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	in.Close()
	os.Remove(src)
	return os.Rename(tmp, dst)
}

// openPath shows a folder or file in the system's file manager (selecting it
// when selectIt), or opens a file with its default program.
func openPath(p string, selectIt bool) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		if selectIt {
			cmd = exec.Command("explorer", "/select,"+p)
		} else {
			cmd = exec.Command("explorer", p)
		}
	case "darwin":
		if selectIt {
			cmd = exec.Command("open", "-R", p)
		} else {
			cmd = exec.Command("open", p)
		}
	default:
		if selectIt {
			p = filepath.Dir(p)
		}
		cmd = exec.Command("xdg-open", p)
	}
	// explorer.exe exits non-zero even when it worked, so only a failure to
	// start at all is an error.
	return cmd.Start()
}

func fmtDur(sec float64) string {
	d := time.Duration(sec) * time.Second
	if d >= time.Hour {
		return fmt.Sprintf("%dh %02dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%dm %02ds", int(d.Minutes()), int(d.Seconds())%60)
}
