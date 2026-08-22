package resim

import (
	"math"
	"sort"
	"sync"
	"time"
)

// Before the engine has simulated a single frame there is nothing to measure,
// and for the first twenty to thirty seconds of every job that is the whole
// story: the demo download, the content check and the engine's own boot happen
// with a queue row that can only say "loading". Measured over 29 re-sims with
// per-beat phase stamps, a job reaches its first simulating beat a median of
// 20s in (p90 30s) — about a tenth of a median job, and rather more than that
// of a short one.
//
// A Forecaster is the guess that fills it: how long this re-simulation will
// take, from the one fact known before any work happens — the demo's length.
//
// It is a GUESS and the numbers say so. Sim time grows faster than game time
// (each frame costs more as the game grows, so the total goes roughly as the
// square), but a 20-minute game can be a quiet duel or a sixteen-player
// slugfest, and the demo's length does not say which: even fitted to a single
// host's own history the median error is 24-43%. That is worth showing — it
// answers "is this three minutes or an hour", which is the question a queue row
// with no ETA cannot — and it is retired the moment the simulation produces a
// real measurement (engine.SimETA, ten seconds in).
//
// THE SCALE IS PER-HOST, which is why this learns rather than shipping a
// constant. The exponent is a property of BAR; the scale in front of it is a
// property of the machine, and two hosts measured here differ by 3x — enough
// that one's constant mispredicts the other's jobs by about a factor of two.
// So each completed run is Observed and the scale is the median of what this
// process has seen, which converges within a handful of jobs. A restart forgets
// it: the first job after one is forecast from the shipped default and every
// job after that is calibrated, which is a better trade than a state file whose
// staleness nobody would notice.
type Forecaster struct {
	mu sync.Mutex
	// obs holds log(simSec) - forecastExponent*log(gameSec) per completed run,
	// i.e. the log of the scale each one implies. Kept in log space because
	// that is where the median is the robust estimator of a multiplier.
	obs []float64
}

const (
	// forecastExponent is how sim time scales with game length, pooled over
	// both measured hosts (106 runs). Near 2 for the reason the cost curve in
	// engine/simeta.go exists: cost per frame grows through a game, so the
	// integral grows faster than the length. Fitting it per host as well was
	// tried and is not supportable from two hosts — their exponents differ, but
	// so do their job mixes, and nothing here can separate the two.
	forecastExponent = 1.73
	// forecastDefaultScale is the pooled scale, used until this process has
	// completed a run of its own.
	forecastDefaultScale = 8.1e-4
	// forecastMemory is how many recent runs the scale is taken over. Enough to
	// be a stable median, few enough to follow a host that gets slower (a
	// second daemon, a busier machine) rather than averaging over its history.
	forecastMemory = 20
	// preSimAllowance is the demo fetch, the content check and the engine's
	// boot — everything before the first sim frame. A constant because it
	// measures as one: 20s median, 30s at p90 over those same 29 runs, against
	// a sim phase that ranges from seconds to an hour. It is only ever the
	// whole answer for the few seconds before the download finishes.
	preSimAllowance = 25 * time.Second
)

// Estimate is how long a re-simulation of a game of this length is expected to
// take, from now, including the phases before the simulation starts. A
// non-positive gameSec (an unknown demo) has no forecast, which callers report
// as no ETA rather than as zero.
func (f *Forecaster) Estimate(gameSec float64) time.Duration {
	if gameSec <= 0 {
		return 0
	}
	scale := forecastDefaultScale
	if f != nil {
		f.mu.Lock()
		if n := len(f.obs); n > 0 {
			s := append([]float64(nil), f.obs...)
			sort.Float64s(s)
			scale = math.Exp(s[n/2])
		}
		f.mu.Unlock()
	}
	sim := time.Duration(scale * math.Pow(gameSec, forecastExponent) * float64(time.Second))
	return sim + preSimAllowance
}

// Observe records what a completed run actually cost, so the next forecast is
// about this machine. Runs that never really simulated are ignored: they say
// nothing about the host's speed and would drag the scale toward zero.
func (f *Forecaster) Observe(gameSec, simSec float64) {
	if f == nil || gameSec <= 0 || simSec <= 0 {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.obs = append(f.obs, math.Log(simSec)-forecastExponent*math.Log(gameSec))
	if len(f.obs) > forecastMemory {
		f.obs = f.obs[len(f.obs)-forecastMemory:]
	}
}
