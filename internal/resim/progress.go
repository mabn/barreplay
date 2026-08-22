package resim

import (
	"context"
	"sync"
	"time"

	"github.com/mabn/barreplay/internal/engine"
)

// The phases a re-simulation moves through, in order. They are the answer to
// "what is this job doing right now" for somebody watching a run that will not
// finish for another forty minutes — a run stuck in "provisioning content" and
// one stuck in "simulating" have nothing in common but their elapsed time.
//
// Plain strings rather than an enum: they are reported to a worker, stored as
// JSON and shown to a person, and none of those three cares about the type.
// A caller that does more work around Run (publishing, say) sets its own.
const (
	PhaseFetchingDemo   = "fetching demo"
	PhaseProvisioning   = "provisioning content"
	PhaseStartingEngine = "starting engine"
	// PhaseLoading is the engine's boot: VFS scan, map load, icon atlas. It
	// ends when the widget announces itself, which is also what splits the
	// run's wall time into RunStats.LoadSec and SimSec.
	PhaseLoading = "loading"
	// PhaseSimulating is the long one — the only phase whose progress can be
	// measured, since the engine logs the sim frame it is on.
	PhaseSimulating = "simulating"
	// PhaseCapturing is reading the widget's stream back and writing the .brp.
	PhaseCapturing = "reading capture"
)

// ProgressState is one reading of a running re-simulation: what it is doing,
// how far in it is, and what the engine process is costing the machine. Every
// field is best-effort — a phase that cannot be measured simply reports zeros,
// and so does a run whose engine has not started yet.
type ProgressState struct {
	// Phase is one of the constants above (or whatever the caller set).
	Phase string
	// Frame is the newest sim frame the engine has logged and TotalFrames the
	// demo's full length, both in sim frames (30 per game-second).
	Frame       int32
	TotalFrames int32
	// Percent is Frame against TotalFrames, 0-100. It is progress through the
	// SIMULATION, not through the job: it stays 0 through the download and the
	// engine's load phase, which are minutes of their own.
	Percent float64
	// ETASec is how many seconds of wall time the run still needs. It is NOT
	// the remaining frames over SimFPS: a sim frame gets several times more
	// expensive as the game it describes grows, so that number reads "nearly
	// done" through the whole first half of a run. See engine.SimETA.
	//
	// Until the simulation has produced a measurement — which covers the demo
	// fetch, the content check and the engine's boot — this is the Forecaster's
	// guess from the demo's length, counting down with the clock. It is much
	// rougher than what replaces it (see Forecaster), and it is replaced the
	// moment there is anything better. 0 when there is neither.
	ETASec float64
	// SimFPS is the rate the last minute of simulation ran at: sim frames
	// processed per wall second (30 = realtime).
	SimFPS float64
	// RSSBytes and CPUPercent are the engine process's resident memory and its
	// CPU use over the last sample window, as a percentage of one core — so a
	// busy multi-threaded engine reports well over 100. SwapBytes is how much
	// of the engine has been pushed out to swap: zero is both the healthy
	// answer and the usual one, and anything else is the direct explanation
	// for a run that has gone slow.
	RSSBytes   int64
	SwapBytes  int64
	CPUPercent float64
}

// Progress is a live, concurrency-safe view of a running re-simulation. Pass
// one in through Options.Progress and read it with Snapshot from any goroutine
// while Run works: it exists so a daemon can report in on a job that will not
// return for the better part of an hour.
//
// A pull, not a callback: the reporting cadence belongs to whoever is reporting
// (the ingest daemon pings every 10 seconds), and a callback would either fire
// on the sampler's schedule instead or have to be rate-limited by everyone who
// implements one.
type Progress struct {
	mu sync.Mutex
	st ProgressState
	// forecast is the pre-simulation guess (Forecaster.Estimate) and
	// forecastAt when it was made, so what is reported is what is LEFT of it.
	// Retired for good once the simulation reports anything: a forecast that
	// outlived its measurement would come back as the ETA during packing, and
	// a run that beat its forecast would then claim minutes of work left.
	forecast   time.Duration
	forecastAt time.Time
	measured   bool
	// now is the clock, injectable for tests.
	now func() time.Time
}

func (p *Progress) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

// SetForecast records a first guess at how long the whole re-simulation will
// take, made before there is anything to measure. Ignored once the simulation
// has reported for itself, and a zero or negative estimate simply clears it.
func (p *Progress) SetForecast(d time.Duration) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.measured {
		return
	}
	p.forecast, p.forecastAt = d, p.clock()
}

// etaLocked is what the run currently believes it has left: its own measurement
// where there is one, the forecast counting down otherwise. Caller holds p.mu.
func (p *Progress) etaLocked() float64 {
	if p.measured || p.forecast <= 0 {
		return p.st.ETASec
	}
	left := p.forecast.Seconds() - p.clock().Sub(p.forecastAt).Seconds()
	if left < 0 {
		// The forecast has run out and the simulation still has not reported.
		// Saying "0 left" would be a lie the row keeps telling; saying nothing
		// is what a guess that has been overtaken deserves.
		return 0
	}
	return left
}

// Snapshot returns the current reading. Safe to call at any time, including
// before Run has started and after it has returned.
func (p *Progress) Snapshot() ProgressState {
	if p == nil {
		return ProgressState{}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	st := p.st
	st.ETASec = p.etaLocked()
	return st
}

// SetPhase records what the run is doing now. Exported because the useful
// phases do not all belong to Run: a caller that packs and uploads afterwards
// owns those minutes and is the only one that can name them.
//
// Changing phase clears the simulation measurements, which describe the
// simulating phase and would otherwise be read as describing whatever came
// next. The engine's memory and CPU survive, since the process does.
func (p *Progress) SetPhase(phase string) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.st.Phase != phase {
		p.st.Frame, p.st.Percent, p.st.ETASec, p.st.SimFPS = 0, 0, 0, 0
	}
	p.st.Phase = phase
}

// setSim records one measurement of the simulation's progress.
func (p *Progress) setSim(frame, total int32, fps, eta float64) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if eta > 0 {
		// The simulation can speak for itself now, so the guess is done for
		// good — including across the phase changes that clear ETASec, where a
		// forecast still ticking down would reappear as the packing's ETA.
		p.measured, p.forecast = true, 0
	}
	p.st.Frame, p.st.TotalFrames, p.st.SimFPS, p.st.ETASec = frame, total, fps, eta
	if total > 0 {
		p.st.Percent = 100 * float64(frame) / float64(total)
	}
}

// setProc records one reading of the engine process's resource use.
func (p *Progress) setProc(rss, swap int64, cpuPct float64) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.st.RSSBytes, p.st.SwapBytes, p.st.CPUPercent = rss, swap, cpuPct
}

// memCheckEvery is how often the memory guard looks at the host. Faster than
// the progress sampler: this one is racing an allocation, and every extra
// second between checks is another second the engine has to reach the ceiling
// the guard exists to stay under. Reading one small file is nothing.
const memCheckEvery = 2 * time.Second

// memGuard records the one moment the host ran short of memory, so the run can
// end with that explanation rather than the generic "the engine was killed" —
// which is technically true, since the guard is what killed it, and useless.
//
// Written once from the watcher goroutine and read once after the engine exits,
// hence the mutex over the three fields together: a reading that reported the
// available memory of one moment and the RSS of another would be worse than no
// reading at all.
type memGuard struct {
	mu      sync.Mutex
	tripped bool
	avail   int64
	rss     int64
}

func (g *memGuard) trip(avail, rss int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.tripped {
		return // the first reading is the one that describes the decision
	}
	g.tripped, g.avail, g.rss = true, avail, rss
}

func (g *memGuard) reading() (avail, rss int64, tripped bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.avail, g.rss, g.tripped
}

// progressSampleEvery is how often the watcher below re-reads the infolog and
// /proc. Well under the ingest daemon's 10-second reporting interval, so a
// report is never stale by more than a fraction of it, and far above the cost
// of two small file reads.
const progressSampleEvery = 5 * time.Second

// watchProgress keeps p up to date while the engine runs: the sim frame from
// the engine's own log (the only progress a headless replay emits), turned into
// a rate and a time-remaining by engine.SimETA, and the process's memory and CPU
// from /proc. It returns when ctx is cancelled, which Run does before it
// returns.
//
// Everything here is best-effort. A sample that cannot be read is skipped, not
// reported as zero — a run whose infolog has not appeared yet is normal for the
// first seconds, and blanking the last good reading would make the watcher
// flicker rather than say nothing.
func watchProgress(ctx context.Context, p *Progress, infologPath string, pid int, totalFrames int32, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()

	var (
		est      = engine.NewSimETA(totalFrames)
		prevProc engine.ProcSample
		haveProc bool
	)
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			if s, ok := engine.SampleProcess(pid); ok {
				cpu := 0.0
				if haveProc {
					cpu = engine.CPUPercent(prevProc, s)
				}
				p.setProc(s.RSSBytes, s.SwapBytes, cpu)
				prevProc, haveProc = s, true
			}
			frame, ok := engine.LastLoggedFrame(infologPath)
			if !ok || frame < 0 {
				continue // pregame: the engine logs [f=-1] until the game starts
			}
			fps, eta := est.Observe(now, frame)
			if fps < 0 {
				// Not measurable yet. ProgressState says nothing with a 0,
				// which is also what a genuinely stalled engine reports — a
				// distinction nobody reading a queue page needs.
				fps = 0
			}
			p.setSim(frame, totalFrames, fps, eta)
		}
	}
}
