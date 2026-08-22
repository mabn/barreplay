package resim

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mabn/barreplay/internal/engine"
)

// A phase change wipes the simulation numbers: they describe the simulating
// phase, and left in place they would be read as describing the packing that
// came after it. The engine's footprint survives, because the process does.
func TestSetPhaseClearsSimMeasurements(t *testing.T) {
	p := &Progress{}
	p.SetPhase(PhaseSimulating)
	p.setSim(3000, 6000, 60, 50)
	p.setProc(1<<30, 2<<20, 400)

	if got := p.Snapshot(); got.Percent != 50 || got.ETASec != 50 {
		t.Fatalf("mid-sim snapshot = %+v, want 50%% and a 50s ETA", got)
	}
	p.SetPhase("packing")
	got := p.Snapshot()
	if got.Phase != "packing" || got.Frame != 0 || got.Percent != 0 || got.ETASec != 0 || got.SimFPS != 0 {
		t.Errorf("after the phase change = %+v, want the sim numbers cleared", got)
	}
	if got.RSSBytes != 1<<30 || got.SwapBytes != 2<<20 || got.CPUPercent != 400 {
		t.Errorf("after the phase change = %+v, want the process reading kept", got)
	}
	// Re-stating the SAME phase is not a change and must not clear anything —
	// the caller may say it every time round a loop.
	p.setSim(3000, 6000, 60, 50)
	p.SetPhase("packing")
	if got := p.Snapshot(); got.Percent != 50 {
		t.Errorf("re-stating the phase cleared the measurements: %+v", got)
	}
}

// A nil Progress is the normal case for every caller that does not want one
// (cmd/barreplay, the daemon's catalog scan), so every method must tolerate it.
func TestNilProgressIsInert(t *testing.T) {
	var p *Progress
	p.SetPhase(PhaseSimulating)
	p.setSim(1, 2, 3, 4)
	p.setProc(5, 6, 7)
	if got := (p.Snapshot()); got != (ProgressState{}) {
		t.Errorf("Snapshot of nil = %+v, want the zero state", got)
	}
}

// The watcher against a real infolog file: it must turn the engine's own
// "[f=N]" markers into a percentage and an ETA, and keep saying nothing while
// the log has no frame in it yet.
func TestWatchProgressReadsTheInfolog(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "infolog.txt")
	// Pregame: the engine logs [f=-1] until the game starts, which is not
	// progress and must not be reported as 0%.
	if err := os.WriteFile(log, []byte("[f=-000001] Loading map\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	p := &Progress{}
	p.SetPhase(PhaseSimulating)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// A pid of 0 exercises the "no process to sample" path, which is what a
	// caller watching a run that has not launched yet gets.
	go watchProgress(ctx, p, log, 0, 6000, time.Millisecond)

	if !stays(func() bool { return p.Snapshot().Frame == 0 }, 50*time.Millisecond) {
		t.Fatal("a pregame log was reported as progress")
	}
	appendLine(t, log, "[f=0001500] something\n")
	if !eventually(func() bool { return p.Snapshot().Frame == 1500 }, 2*time.Second) {
		t.Fatalf("the first frame never showed up: %+v", p.Snapshot())
	}
	if got := p.Snapshot(); got.Percent != 25 || got.TotalFrames != 6000 {
		t.Errorf("snapshot = %+v, want 25%% of 6000", got)
	}
	appendLine(t, log, "[f=0003000] more\n")
	if !eventually(func() bool { return p.Snapshot().Frame == 3000 }, 2*time.Second) {
		t.Fatalf("the second frame never showed up: %+v", p.Snapshot())
	}
	if got := p.Snapshot(); got.Percent != 50 {
		t.Errorf("snapshot = %+v, want 50%%", got)
	}
	// And no ETA out of a run that has been going for milliseconds: the
	// estimate is a share of elapsed work, and there is not enough of either
	// yet to divide by. engine.SimETA is where the arithmetic is tested.
	if got := p.Snapshot(); got.ETASec != 0 {
		t.Errorf("ETA = %v seconds a moment into the run, want none offered yet", got.ETASec)
	}
}

func appendLine(t *testing.T, path, line string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(line); err != nil {
		t.Fatal(err)
	}
}

// eventually polls cond until it holds or d runs out; stays is the opposite —
// cond must hold for the whole of d. The watcher is a goroutine on a ticker, so
// both of its interesting behaviours ("reports this soon" and "never reports
// that") are statements about a window of time rather than about one instant.
func eventually(cond func() bool, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(time.Millisecond)
	}
	return cond()
}

func stays(cond func() bool, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if !cond() {
			return false
		}
		time.Sleep(time.Millisecond)
	}
	return cond()
}

// The guard's reading is what explains a stopped run, so the FIRST one wins:
// by the time the engine has actually died the host may well have recovered,
// and a later, healthier-looking number would describe the recovery rather
// than the decision.
func TestMemGuardKeepsTheFirstReading(t *testing.T) {
	var g memGuard
	if _, _, tripped := g.reading(); tripped {
		t.Fatal("a fresh guard reads as tripped")
	}
	g.trip(400<<20, 6<<30)
	g.trip(3<<30, 1<<20) // the host recovering after the kill
	avail, rss, tripped := g.reading()
	if !tripped || avail != 400<<20 || rss != 6<<30 {
		t.Errorf("reading = (%d, %d, %v), want the first one", avail, rss, tripped)
	}
}

// minFree's three cases: unset takes the package default, a value is used as
// given, and negative is the caller saying "let the kernel have it".
func TestOptionsMinFree(t *testing.T) {
	if got, want := (Options{}).minFree(), engine.DefaultMinFreeBytes; got != want {
		t.Errorf("unset minFree = %d, want the default %d", got, want)
	}
	if got := (Options{MinFreeBytes: 256 << 20}).minFree(); got != 256<<20 {
		t.Errorf("minFree = %d, want what was set", got)
	}
	// engine.WatchMemory treats <= 0 as off, so this must stay negative rather
	// than being helpfully turned back into the default.
	if got := (Options{MinFreeBytes: -1}).minFree(); got > 0 {
		t.Errorf("minFree = %d, want the guard left disabled", got)
	}
}

// A run that fails must not leave the widget's raw stream behind. It lives in
// the DATA dir (the Lua sandbox forces that), it is hundreds of megabytes, and
// a daemon handed games too big for its host would otherwise accumulate one per
// abandoned game until the disk is the next thing to go.
//
// Run cannot be driven without an engine, so this exercises the cleanup the way
// Run registers it: a deferred remove that fires only on the error path.
func TestAbandonedStreamIsRemoved(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool // the stream should still be there afterwards
	}{
		{"a failed run drops it", errors.New("out of memory"), false},
		// The success path MOVES it out to the capture directory, so the
		// cleanup must keep its hands off.
		{"a good run keeps it for the mover", nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			stream := filepath.Join(dir, "game.brsnap")
			if err := os.WriteFile(stream, []byte("BRSNAP"), 0o644); err != nil {
				t.Fatal(err)
			}
			func() (retErr error) {
				defer removeAbandonedStream(stream, &retErr)
				return tc.err
			}()
			_, err := os.Stat(stream)
			if got := err == nil; got != tc.want {
				t.Errorf("stream present = %v, want %v", got, tc.want)
			}
		})
	}
	// A stream that never appeared (the widget never ran) is not a warning.
	var err error = errors.New("boom")
	removeAbandonedStream(filepath.Join(t.TempDir(), "absent.brsnap"), &err)
}

// The complaint this answers: a job that has been claimed shows nothing but
// "loading" for the first half-minute, which is a tenth of a median run and
// most of a short one. A forecast fills that in, counting down as it goes, and
// stands down the moment the simulation can speak for itself.
func TestForecastCarriesTheETAUntilTheSimCan(t *testing.T) {
	now := time.Unix(1700000000, 0)
	p := &Progress{now: func() time.Time { return now }}

	p.SetPhase(PhaseFetchingDemo)
	if got := p.Snapshot().ETASec; got != 0 {
		t.Errorf("ETA before any forecast = %v, want none", got)
	}
	p.SetForecast(10 * time.Minute)
	if got := p.Snapshot().ETASec; math.Abs(got-600) > 0.001 {
		t.Errorf("ETA = %v, want the whole forecast", got)
	}

	// It counts down with the clock, and survives the phases the run moves
	// through on the way to simulating — which is exactly where it is needed.
	now = now.Add(2 * time.Minute)
	p.SetPhase(PhaseProvisioning)
	p.SetPhase(PhaseLoading)
	if got := p.Snapshot().ETASec; math.Abs(got-480) > 0.001 {
		t.Errorf("ETA after two minutes of loading = %v, want 480", got)
	}

	// The first real measurement retires it for good.
	p.setSim(3000, 60000, 120, 900)
	if got := p.Snapshot().ETASec; got != 900 {
		t.Errorf("ETA = %v, want the measurement to win over the forecast", got)
	}
	// Including across the phase change that clears the sim numbers: a forecast
	// still ticking down would otherwise reappear as the packing's ETA, and a
	// run that beat its forecast would claim minutes of work it has finished.
	p.SetPhase("packing")
	if got := p.Snapshot().ETASec; got != 0 {
		t.Errorf("ETA while packing = %v, want none", got)
	}
	p.SetForecast(10 * time.Minute)
	if got := p.Snapshot().ETASec; got != 0 {
		t.Errorf("a forecast was accepted after the run measured itself: %v", got)
	}
}

// A forecast that runs out while the simulation still has not reported must go
// quiet rather than sit at "0s left" — a guess that has been overtaken has
// nothing left to say.
func TestExpiredForecastSaysNothing(t *testing.T) {
	now := time.Unix(1700000000, 0)
	p := &Progress{now: func() time.Time { return now }}
	p.SetForecast(time.Minute)
	now = now.Add(90 * time.Second)
	if got := p.Snapshot().ETASec; got != 0 {
		t.Errorf("expired forecast reports %v, want none", got)
	}
}
