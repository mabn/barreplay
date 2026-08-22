package resim

import (
	"math"
	"testing"
	"time"
)

// The forecast has one job: turn the demo's length into a number of minutes
// before anything has been measured. It must be monotone in that length, and
// grow faster than it — a game twice as long costs more than twice as much,
// because each of its frames is more expensive than the last.
func TestForecastGrowsFasterThanGameLength(t *testing.T) {
	var f Forecaster
	short := f.Estimate(600)
	long := f.Estimate(1200)
	if !(long > short) {
		t.Fatalf("a longer game forecast shorter: %v vs %v", long, short)
	}
	if ratio := float64(long-preSimAllowance) / float64(short-preSimAllowance); ratio < 2.2 {
		t.Errorf("doubling the game length multiplied the sim by %.2f, want the super-linear growth the cost curve implies", ratio)
	}
	// An unknown demo length has no forecast at all — callers report that as no
	// ETA, which is honest, where a zero would read as "done".
	if got := f.Estimate(0); got != 0 {
		t.Errorf("Estimate(0) = %v, want no forecast", got)
	}
	// And it covers the phases before the simulation, which is the whole point:
	// the row has an ETA while the demo is still downloading.
	if f.Estimate(1) < preSimAllowance {
		t.Errorf("a trivial game forecasts %v, want at least the pre-sim allowance", f.Estimate(1))
	}
}

// The scale in front of the exponent is a property of the MACHINE — two
// measured hosts differ by 3x — so a Forecaster must move to the host it is
// running on rather than keep quoting the shipped constant.
func TestForecastLearnsTheHostsSpeed(t *testing.T) {
	var f Forecaster
	before := f.Estimate(1800)

	// A host four times slower than the default, ten jobs in a row.
	slow := 4 * (float64(before-preSimAllowance) / float64(time.Second))
	for i := 0; i < 10; i++ {
		f.Observe(1800, slow)
	}
	after := f.Estimate(1800)
	got := (after - preSimAllowance).Seconds()
	if math.Abs(got-slow)/slow > 0.05 {
		t.Errorf("after ten runs at %.0fs the forecast is %.0fs, want it to have followed the host", slow, got)
	}

	// Only the most recent runs count, so a host that changes speed is
	// followed rather than averaged against its own history for ever.
	for i := 0; i < forecastMemory; i++ {
		f.Observe(1800, slow/8)
	}
	if got := (f.Estimate(1800) - preSimAllowance).Seconds(); math.Abs(got-slow/8)/(slow/8) > 0.05 {
		t.Errorf("forecast %.0fs after the host got faster, want ~%.0fs", got, slow/8)
	}
	if len(f.obs) > forecastMemory {
		t.Errorf("kept %d observations, want at most %d", len(f.obs), forecastMemory)
	}
}

// A run that never simulated says nothing about how fast the host is, and
// averaging its zero in would drag every later forecast toward nothing.
func TestForecastIgnoresRunsThatDidNotSimulate(t *testing.T) {
	var f Forecaster
	want := f.Estimate(1800)
	f.Observe(1800, 0)
	f.Observe(0, 500)
	f.Observe(-1, -1)
	if got := f.Estimate(1800); got != want {
		t.Errorf("forecast moved to %v on runs that measured nothing, want %v", got, want)
	}
}

// A nil Forecaster is what a caller that wants no forecast passes, and what
// every existing caller passes by not setting the field.
func TestNilForecasterIsInert(t *testing.T) {
	var f *Forecaster
	f.Observe(1800, 900)
	if got := f.Estimate(1800); got == 0 {
		t.Error("a nil Forecaster should still give the shipped default, not nothing")
	}
}
