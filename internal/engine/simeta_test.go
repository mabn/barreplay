package engine

import (
	"math"
	"testing"
	"time"
)

// The curve is a cumulative share, so it must start at 0, end at 1 and never go
// backwards — an estimate divides by the difference between two readings of it.
func TestWallShareIsACumulativeShare(t *testing.T) {
	if got := wallShareAt(0); got != 0 {
		t.Errorf("wallShareAt(0) = %v, want 0", got)
	}
	for _, x := range []float64{1, 1.5, math.NaN()} {
		want := 1.0
		if math.IsNaN(x) {
			want = 0 // an unknown position is no progress, not all of it
		}
		if got := wallShareAt(x); got != want {
			t.Errorf("wallShareAt(%v) = %v, want %v", x, got, want)
		}
	}
	prev := 0.0
	for i := 1; i <= 200; i++ {
		got := wallShareAt(float64(i) / 200)
		if got < prev {
			t.Fatalf("wallShareAt went backwards at x=%.3f: %v after %v", float64(i)/200, got, prev)
		}
		prev = got
	}
	// The point of the whole exercise: half the frames are NOT half the work.
	if got := wallShareAt(0.5); got > 0.35 {
		t.Errorf("wallShareAt(0.5) = %v, want the measured ~0.30 — a curve this flat is the naive estimate", got)
	}
	// Between table entries it interpolates rather than stepping.
	lo, hi := wallShareAt(0.50), wallShareAt(0.55)
	if mid := wallShareAt(0.525); mid <= lo || mid >= hi {
		t.Errorf("wallShareAt(0.525) = %v, want strictly between %v and %v", mid, lo, hi)
	}
}

// frameAtShare inverts the curve: the frame a run following it exactly is on
// after a given share of its wall time.
func frameAtShare(total int32, share float64) int32 {
	lo, hi := 0.0, 1.0
	for i := 0; i < 40; i++ {
		mid := (lo + hi) / 2
		if wallShareAt(mid) < share {
			lo = mid
		} else {
			hi = mid
		}
	}
	return int32((lo + hi) / 2 * float64(total))
}

// The estimate's whole claim is that it needs to know nothing about the host:
// a run on a machine half the speed of the one the curve was measured on must
// still be estimated correctly, because the run's own elapsed time supplies the
// scale. So drive two runs of very different lengths and check both.
func TestSimETAIsIndependentOfHostSpeed(t *testing.T) {
	const total = int32(60000) // a 33-minute demo
	for _, wall := range []time.Duration{10 * time.Minute, 80 * time.Minute} {
		start := time.Unix(1700000000, 0)
		est := NewSimETA(total)
		var worst float64
		for at := time.Duration(0); at <= wall; at += 5 * time.Second {
			frame := frameAtShare(total, float64(at)/float64(wall))
			_, eta := est.Observe(start.Add(at), frame)
			truth := (wall - at).Seconds()
			if eta <= 0 || truth < 60 {
				continue
			}
			if e := math.Abs(math.Log(eta / truth)); e > worst {
				worst = e
			}
		}
		if worst > 0.05 {
			t.Errorf("wall=%v: worst error %.1f%%, want a run that follows the curve to be estimated almost exactly",
				wall, 100*(math.Exp(worst)-1))
		}
	}
}

// The failure the curve exists to fix: early in a run the remaining frames are
// far more expensive than the ones already done, so remaining/rate — what this
// used to do — says a 55-minute re-sim has four minutes left.
func TestSimETADoesNotUnderestimateEarly(t *testing.T) {
	const total = int32(100170) // the 55-minute game from bringest.log
	wall := 55 * time.Minute
	start := time.Unix(1700000000, 0)
	est := NewSimETA(total)
	for at := time.Duration(0); at <= 4*time.Minute; at += 5 * time.Second {
		frame := frameAtShare(total, float64(at)/float64(wall))
		fps, eta := est.Observe(start.Add(at), frame)
		if at < 4*time.Minute {
			continue
		}
		truth := (wall - at).Seconds()
		if eta < 0.7*truth || eta > 1.4*truth {
			t.Errorf("4 minutes in: ETA %.0fs against a true %.0fs left", eta, truth)
		}
		// The rate at this point is around 8x what the rest of the run will
		// average, which is exactly why it cannot be what the ETA is built on.
		if naive := float64(total-frame) / fps; naive > 0.5*truth {
			t.Logf("naive remaining/rate would have said %.0fs (truth %.0fs)", naive, truth)
		}
	}
}

func TestSimETAReportsTheRate(t *testing.T) {
	start := time.Unix(1700000000, 0)
	est := NewSimETA(60000)

	// Nothing to measure from one reading, nor from a span shorter than the
	// infolog's own granularity.
	if fps, eta := est.Observe(start, 0); fps >= 0 || eta != 0 {
		t.Errorf("first reading = (%v, %v), want no rate and no ETA", fps, eta)
	}
	if fps, _ := est.Observe(start.Add(5*time.Second), 900); fps >= 0 {
		t.Errorf("rate after 5s = %v, want it withheld until there is enough history", fps)
	}
	// Past the minimum span it is the average over everything still in the
	// window — 3000 frames in 20s — not the delta against the previous reading.
	if fps, _ := est.Observe(start.Add(20*time.Second), 3000); math.Abs(fps-150) > 1 {
		t.Errorf("rate = %v, want 150 (3000 frames in 20s)", fps)
	}
	// A stall shows up as the window empties of progress — gradually, which is
	// the point of a window — and bottoms out at a real zero, which is a
	// reading rather than the absence of one.
	if fps, _ := est.Observe(start.Add(40*time.Second), 3000); !(fps > 0 && fps < 150) {
		t.Errorf("rate 20s into a stall = %v, want it decaying, not dropping to 0", fps)
	}
	if fps, _ := est.Observe(start.Add(2*time.Minute), 3000); fps != 0 {
		t.Errorf("rate a full window into a stall = %v, want 0", fps)
	}
	// ...and the estimate then only grows, because the elapsed time does while
	// the work done does not.
	_, eta1 := est.Observe(start.Add(3*time.Minute), 3000)
	_, eta2 := est.Observe(start.Add(5*time.Minute), 3000)
	if !(eta1 > 0 && eta2 > eta1) {
		t.Errorf("a stalled run's ETA went %v -> %v, want it to grow", eta1, eta2)
	}
}

// The infolog is per data dir, so the first readings of a fresh run are the tail
// of the PREVIOUS run's log until the engine truncates it. Treating that stale
// frame as work already done would credit the run with most of a game it has not
// simulated; the frame going backwards is the signal, and it restarts the clock.
func TestSimETARestartsWhenTheFrameGoesBackwards(t *testing.T) {
	const total = int32(60000)
	start := time.Unix(1700000000, 0)
	est := NewSimETA(total)

	est.Observe(start, 48000) // the last run's log
	est.Observe(start.Add(5*time.Second), 48000)
	// The engine truncates and its own game begins.
	est.Observe(start.Add(10*time.Second), 0)

	_, eta := est.Observe(start.Add(70*time.Second), frameAtShare(total, 60.0/600))
	if eta <= 0 {
		t.Fatal("no ETA after the restart")
	}
	// The run began at t=10s and is a minute in at a tenth of its wall time, so
	// it has about nine more minutes.
	if eta < 400 || eta > 750 {
		t.Errorf("ETA after the restart = %.0fs, want roughly 540s", eta)
	}
}

// An unknown demo length (a capture with no header behind it) still has a
// measurable rate; it just has nothing to be a fraction of.
func TestSimETAWithoutATotal(t *testing.T) {
	start := time.Unix(1700000000, 0)
	est := NewSimETA(0)
	est.Observe(start, 0)
	fps, eta := est.Observe(start.Add(time.Minute), 3000)
	if math.Abs(fps-50) > 1 {
		t.Errorf("rate = %v, want 50", fps)
	}
	if eta != 0 {
		t.Errorf("ETA = %v, want none without a demo length", eta)
	}
}
