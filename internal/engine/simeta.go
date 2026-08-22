package engine

import "time"

// The wall-clock cost of a sim frame is NOT constant: a re-simulation of a big
// game gets several times slower as it goes, because the thing it is simulating
// grows — more units, more projectiles, more pathfinding, more LuaRules work per
// frame. Measured over 29 completed re-sims (bringest.log), the last third of a
// game's frames processes at a median of 0.29x the rate of the first third.
//
// That is what made the obvious ETA — remaining frames divided by the rate
// measured over the last few seconds — worse than useless: it says the run is
// nearly done exactly when it has barely started. Against those same 29 runs it
// predicted a MEDIAN of 0.23x the true remaining time over the first tenth of a
// game (a 55-minute re-sim announcing "ETA 03:49" at 1%), swinging to 2.8x too
// long over the ninth tenth, and landed within 2x of the truth only 37% of the
// time. Nobody can plan an hour of engine time around a number like that.
//
// simWallShare replaces the local rate with the SHAPE of that slowdown, which
// turns out to be near-universal across games: it is the share of a
// re-simulation's total wall time already spent by the time it reaches a given
// fraction of the demo's frames, sampled every 5% and interpolated between. The
// striking entry is the middle one — half the FRAMES are done after 30% of the
// TIME. The curve is a median over those 29 runs; it correlates with neither the
// game's length (r = +0.27) nor the host's speed (r = -0.09), which is what makes
// one table enough: both of those scale the whole run and cancel out of a shape
// expressed in fractions.
//
// It is a prior, and it is allowed to be one. The estimate below divides it out
// against the run's OWN elapsed time, so a host half the speed of this one, or a
// game whose fights start unusually early, is calibrated for automatically after
// a couple of minutes; only a game whose cost curve is a different SHAPE from
// every measured one is mis-estimated, and then only by the amount of that
// difference. Leave-one-out over the 29 runs: a median error of 27%, 96% of all
// readings within 2x, and no systematic bias at any point in a run.
//
// Worth regenerating (from a daemon's progress log, whose lines are one fixed
// tick apart) if the engine's per-frame cost profile changes materially.
var simWallShare = [21]float64{
	0.0000, // x = 0.00
	0.0139, // x = 0.05
	0.0259, // x = 0.10
	0.0414, // x = 0.15
	0.0663, // x = 0.20
	0.0947, // x = 0.25
	0.1201, // x = 0.30
	0.1598, // x = 0.35
	0.2028, // x = 0.40
	0.2439, // x = 0.45
	0.2966, // x = 0.50
	0.3431, // x = 0.55
	0.4024, // x = 0.60
	0.4503, // x = 0.65
	0.5263, // x = 0.70
	0.6149, // x = 0.75
	0.6992, // x = 0.80
	0.7785, // x = 0.85
	0.8795, // x = 0.90
	0.9512, // x = 0.95
	1.0000, // x = 1.00
}

// wallShareAt interpolates simWallShare at frame fraction x (0-1).
func wallShareAt(x float64) float64 {
	if !(x > 0) { // also catches NaN
		return 0
	}
	if x >= 1 {
		return 1
	}
	q := x * float64(len(simWallShare)-1)
	i := int(q)
	return simWallShare[i] + (simWallShare[i+1]-simWallShare[i])*(q-float64(i))
}

const (
	// simRateWindow is how far back the reported frame rate looks. The engine
	// does not log every frame — the widget's heartbeat marks one every 300 —
	// so at a late-game 10 fps the infolog only moves every ~30 seconds, and a
	// rate taken between two consecutive samples reads 0, 0, 0, 0, 0, 60. A
	// minute of history smooths that out without lagging a real slowdown:
	// against the rate the next 60 seconds actually turn out to run at, it is
	// off by a median of 37% where the exponential average it replaces was off
	// by 150%, and it stops the number jumping by ±40% every single tick.
	simRateWindow = 60 * time.Second
	// simRateMinSpan is the least history that makes a rate worth reporting at
	// all — below it the log's own granularity dominates.
	simRateMinSpan = 10 * time.Second
	// simETAMinElapsed is how long the simulation must have been running before
	// an estimate is offered. The estimate divides by the work done so far, and
	// in the first seconds that divisor is small enough that the log's 300-frame
	// granularity alone swings the answer by minutes. Nobody is waiting on an
	// ETA half a minute into an hour of work.
	simETAMinElapsed = 30 * time.Second
)

// SimETA turns a stream of sim-frame readings into the two numbers a person
// watching a headless re-simulation wants: how fast it is going now, and how
// much longer it has. Feed it every reading; it keeps only the last minute of
// them plus where the simulation started.
//
// Not safe for concurrent use — each watcher owns one.
type SimETA struct {
	total int32
	// win is the trailing window behind the reported rate, oldest first.
	win []simSample
	// start and startShare are where THIS simulation began, which is what the
	// estimate measures elapsed work against. They are re-taken whenever the
	// frame goes backwards: the infolog is per data dir, so a fresh run reads
	// the tail of the previous one's log until the engine truncates it, and
	// without the reset that stale frame would be treated as work already done.
	start      time.Time
	startShare float64
	last       int32
	seen       bool
}

type simSample struct {
	at    time.Time
	frame int32
}

// NewSimETA returns an estimator for a demo of totalFrames sim frames. A total
// of 0 (an unknown demo length) still yields a frame rate, never an ETA.
func NewSimETA(totalFrames int32) *SimETA {
	return &SimETA{total: totalFrames}
}

// Observe records one reading of the engine's current sim frame and returns the
// rate in sim frames per wall second (negative while there is not enough history
// to measure one — a stalled engine reports a real 0) and the estimated seconds
// of simulation left (0 when there is nothing to estimate from).
func (e *SimETA) Observe(now time.Time, frame int32) (fps, etaSec float64) {
	if !e.seen || frame < e.last {
		e.seen, e.start, e.startShare, e.win = true, now, e.shareOf(frame), e.win[:0]
	}
	e.last = frame
	e.win = append(e.win, simSample{now, frame})
	// Drop everything past the window, always keeping at least two samples so a
	// reading after a long gap still has something to be a rate against. Copied
	// down rather than re-sliced so the backing array stays put.
	drop := 0
	for drop+2 < len(e.win) && now.Sub(e.win[drop+1].at) >= simRateWindow {
		drop++
	}
	if drop > 0 {
		e.win = append(e.win[:0], e.win[drop:]...)
	}

	fps = -1
	if span := now.Sub(e.win[0].at); span >= simRateMinSpan {
		fps = float64(frame-e.win[0].frame) / span.Seconds()
	}

	elapsed := now.Sub(e.start)
	share := e.shareOf(frame)
	done := share - e.startShare
	if elapsed >= simETAMinElapsed && done > 1e-6 && e.total > frame {
		etaSec = elapsed.Seconds() * (1 - share) / done
	}
	return fps, etaSec
}

// shareOf is the curve's reading for a frame, or 0 when the demo's length is
// unknown (in which case nothing downstream uses it).
func (e *SimETA) shareOf(frame int32) float64 {
	if e.total <= 0 {
		return 0
	}
	return wallShareAt(float64(frame) / float64(e.total))
}
