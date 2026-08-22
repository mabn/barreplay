package resim

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
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
	// A second reading is what makes a rate, and a rate is what makes an ETA.
	appendLine(t, log, "[f=0003000] more\n")
	if !eventually(func() bool { return p.Snapshot().ETASec > 0 }, 2*time.Second) {
		t.Fatalf("no ETA after a second sample: %+v", p.Snapshot())
	}
	if got := p.Snapshot(); got.SimFPS <= 0 || got.Percent != 50 {
		t.Errorf("snapshot = %+v, want 50%% and a positive frame rate", got)
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
