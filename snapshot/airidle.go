package snapshot

import "math"

// AirIdleOptions tunes the idle-aircraft freezing transform (NewAirIdleWriter).
type AirIdleOptions struct {
	// Radius is the anchor tolerance in elmos: an aircraft that stays within
	// this distance of its anchor point qualifies as idle, and a frozen one
	// that drifts beyond it unfreezes. It should comfortably cover the
	// circling radius of an idle fighter, and it bounds the position error of
	// a frozen plane. <= 0 selects the default (700).
	Radius float64
	// IdleSamples is how many consecutive qualifying samples (near the anchor,
	// no health loss, no active command) an aircraft needs before freezing —
	// at the default 1 Hz sampling, samples == seconds. Too low and combat
	// churn (freeze/glide/unfreeze cycles) costs more than parking saves; 6
	// measured best on both a fighter-stacked and a combat-heavy real game.
	// <= 0 selects the default (6).
	IdleSamples int
}

const (
	defaultAirIdleRadius  = 700
	defaultAirIdleSamples = 6
	// glideSpeedFactor caps a transition glide at this multiple of the unit's
	// def speed per sample: fast enough to always outrun the real aircraft
	// (the catch-up gap can only shrink), slow enough to read as flight.
	glideSpeedFactor = 2.0
)

// AirIdleWriter implements the idle-aircraft optimization as a Writer
// transform: an aircraft that has been circling near one spot with no health
// loss and no active command is rewritten to sit parked at its anchor point
// with zero velocity. The downstream .brp codec then predicts it perfectly and
// it costs zero delta bytes — the same mechanism that makes ghosts free. The
// transform is lossy by design (an idle plane renders parked instead of
// circling, with position error bounded by Radius) and purely a function of
// the input frames, so the writer stays deterministic.
//
// The emitted path is CONTINUOUS: the writer never teleports a unit. It
// tracks the last position it emitted per aircraft and, whenever that
// diverges from the target (the anchor when freezing, the true position when
// unfreezing), it glides toward it at most glideSpeedFactor x the unit's def
// speed per sample (Radius/2 per sample when the def carries no speed). A
// constant-velocity glide self-predicts in the delta codec, so transitions
// cost almost nothing; a parked plane costs zero. Because the glide outruns
// the aircraft itself, the catch-up gap only shrinks and the position error
// stays bounded by roughly Radius throughout.
//
// Idleness uses the frame's command state when the capture recorded it
// (protocol 3): a unit actively working — building, reclaiming, repairing,
// attacking, loading, or nanolathing anything — never freezes. Without
// command data the positional + health test alone decides, which is safe: an
// aircraft doing anything consequential either moves off its anchor or takes
// damage.
type AirIdleWriter struct {
	next Writer
	opts AirIdleOptions

	canFly    map[int32]bool
	glideStep map[int32]float64 // per-sample glide cap in elmos, by def
	units     map[int32]*airIdleState
	sampleSec float64 // seconds per sample (sampleEvery/30)

	// aircraftRecords/rewrittenRecords count aircraft unit-samples seen and
	// how many were rewritten (parked or gliding) — the observability the
	// caller reports.
	aircraftRecords, rewrittenRecords int64
}

type airIdleState struct {
	def, team        int32
	anchorX, anchorZ float32
	dispX, dispZ     float32 // last EMITTED position (the continuity anchor)
	lastTX, lastTZ   float32 // last TRUE position (faithfulness tracker)
	health           float32
	stable           int  // consecutive qualifying samples at the anchor
	frozen           bool // targeting the anchor (parked once the glide lands)
	seen             bool // seen in the current frame (mark/sweep)
	// avgStep is an EMA of the unit's per-sample true displacement — its
	// recent movement regime. A sudden jump far above it (a parked plane
	// taking off) unfreezes immediately instead of waiting for the anchor
	// radius to break.
	avgStep float64
	// turn accumulates absolute heading change over the qualifying streak.
	// Freezing requires the unit to be visibly NOT going anywhere: either
	// stationary (landed/hovering, avgStep below a few elmos) or literally
	// circling (>= 90 degrees of accumulated rotation). A plane cruising in a
	// straight line satisfies the anchor-containment test for a while (the
	// streak centroid chases it), but turns ~0 degrees — without this it
	// would freeze mid-flight and stutter.
	turn       float64
	heading    float64
	hasHeading bool
	// Running centroid of the qualifying streak. While the streak grows the
	// anchor tracks it, so a circling aircraft anchors at its orbit CENTER —
	// an orbit of radius r then needs Radius ≈ r to qualify instead of 2r
	// (the worst case when anchoring at the streak's first point, on the
	// orbit's edge), and a frozen plane parks where it was actually circling.
	// The anchor locks the moment the unit freezes.
	sumX, sumZ float64
	n          int
}

// NewAirIdleWriter wraps next with the idle-aircraft freezing transform.
func NewAirIdleWriter(next Writer, opts AirIdleOptions) *AirIdleWriter {
	if opts.Radius <= 0 {
		opts.Radius = defaultAirIdleRadius
	}
	if opts.IdleSamples <= 0 {
		opts.IdleSamples = defaultAirIdleSamples
	}
	return &AirIdleWriter{
		next:      next,
		opts:      opts,
		canFly:    map[int32]bool{},
		glideStep: map[int32]float64{},
		units:     map[int32]*airIdleState{},
		sampleSec: 1,
	}
}

func (w *AirIdleWriter) WriteMeta(m Meta) error {
	se := float64(m.SampleEvery)
	if se <= 0 {
		se = 30
	}
	w.sampleSec = se / 30
	for id, d := range m.UnitDefs {
		if d.CanFly {
			w.canFly[id] = true
			if d.Speed > 0 {
				// Def speed is elmos per game-second; one sample is sampleSec.
				w.glideStep[id] = glideSpeedFactor * float64(d.Speed) * w.sampleSec
			}
		}
	}
	return w.next.WriteMeta(m)
}

// commandBlocks reports whether a command row must keep the unit unfrozen.
// An empty queue (no row) never blocks. A move/patrol/fight order blocks
// unless its position target is within radius — "idle" means circling NEAR
// THE DESTINATION; a plane ordered somewhere far must depart faithfully, from
// the very sample the order appears (before it even starts moving). A guard
// order blocks unless the guarded unit (looked up via unitPos) is nearby.
// Anything else — attack, build orders, reclaim/repair/resurrect/capture,
// transport commands, unknown/future ids — or a live buildee always blocks.
// Engine ids: rts/Sim/Units/CommandAI/Command.h.
func commandBlocks(c UnitCommand, ux, uz float32, r2 float64, unitPos func(int32) (float32, float32, bool)) bool {
	if c.Buildee != 0 {
		return true
	}
	switch c.Cmd {
	case 0:
		return false
	case 10, 15, 16: // MOVE/PATROL/FIGHT: near the position target only
		if c.TX == 0 && c.TZ == 0 {
			return false // no/unknown target recorded
		}
		dx, dz := float64(ux)-float64(c.TX), float64(uz)-float64(c.TZ)
		return dx*dx+dz*dz > r2
	case 25: // GUARD: near the guarded unit only
		gx, gz, ok := unitPos(c.TargetID)
		if !ok {
			return true // target not visible: be conservative
		}
		dx, dz := float64(ux)-float64(gx), float64(uz)-float64(gz)
		return dx*dx+dz*dz > r2
	}
	return true
}

func (w *AirIdleWriter) WriteFrame(fr Frame) error {
	r2 := w.opts.Radius * w.opts.Radius

	// Command rows by unit, and a lazy unit-position lookup for guard targets.
	cmdRow := map[int32]UnitCommand{}
	for _, c := range fr.Commands {
		cmdRow[c.UnitID] = c
	}
	var posIdx map[int32]int
	unitPos := func(id int32) (float32, float32, bool) {
		if posIdx == nil {
			posIdx = make(map[int32]int, len(fr.Units))
			for i := range fr.Units {
				posIdx[fr.Units[i].UnitID] = i
			}
		}
		i, ok := posIdx[id]
		if !ok {
			return 0, 0, false
		}
		return fr.Units[i].Pos.X, fr.Units[i].Pos.Z, true
	}

	// fr.Units is shared with the caller; copy before rewriting anything.
	rewritten := false
	units := fr.Units
	for i := range units {
		u := &units[i]
		if !w.canFly[u.DefID] {
			continue
		}
		w.aircraftRecords++
		s := w.units[u.UnitID]
		if s == nil || s.def != u.DefID || s.team != u.Team {
			// New aircraft (or the engine reused the id): appears as-is — a
			// unit coming into existence is not a teleport — and seeds both
			// the anchor and the emitted-position tracker.
			s = &airIdleState{def: u.DefID, team: u.Team,
				anchorX: u.Pos.X, anchorZ: u.Pos.Z,
				dispX: u.Pos.X, dispZ: u.Pos.Z,
				lastTX: u.Pos.X, lastTZ: u.Pos.Z,
				health: u.Health,
				sumX:   float64(u.Pos.X), sumZ: float64(u.Pos.Z), n: 1}
			w.units[u.UnitID] = s
			s.seen = true
			continue
		}
		s.seen = true

		// True per-sample displacement vs the movement regime so far: a step
		// far above the recent average is a takeoff (a parked plane starting
		// to move accelerates from ~0), and must unfreeze NOW — the anchor
		// radius would only notice several samples later.
		tdx, tdz := float64(u.Pos.X-s.lastTX), float64(u.Pos.Z-s.lastTZ)
		trueStep := math.Sqrt(tdx*tdx + tdz*tdz)
		takeoff := trueStep > 3*s.avgStep+24

		blocked := false
		if c, ok := cmdRow[u.UnitID]; ok {
			blocked = commandBlocks(c, u.Pos.X, u.Pos.Z, r2, unitPos)
		}
		dx := float64(u.Pos.X - s.anchorX)
		dz := float64(u.Pos.Z - s.anchorZ)
		qualifies := dx*dx+dz*dz <= r2 &&
			u.Health >= s.health-0.5 && // lost hp = in a fight
			!blocked && !takeoff
		s.health = u.Health

		if !qualifies {
			// Drifted off / took off / damaged / ordered away: target the
			// true position again and restart the movement-regime average.
			s.frozen = false
			s.stable = 0
			s.anchorX, s.anchorZ = u.Pos.X, u.Pos.Z
			s.sumX, s.sumZ, s.n = float64(u.Pos.X), float64(u.Pos.Z), 1
			s.avgStep = trueStep
			s.turn, s.hasHeading = 0, false
		} else {
			s.avgStep = 0.7*s.avgStep + 0.3*trueStep
			if trueStep >= 8 {
				h := math.Atan2(tdz, tdx)
				if s.hasHeading {
					d := math.Mod(h-s.heading+3*math.Pi, 2*math.Pi) - math.Pi
					s.turn += math.Abs(d)
				}
				s.heading, s.hasHeading = h, true
			}
			s.stable++
			if !s.frozen {
				// Track the streak centroid until the anchor locks at freeze
				// time.
				s.sumX += float64(u.Pos.X)
				s.sumZ += float64(u.Pos.Z)
				s.n++
				s.anchorX = float32(s.sumX / float64(s.n))
				s.anchorZ = float32(s.sumZ / float64(s.n))
			}
			if s.stable >= w.opts.IdleSamples && (s.turn >= math.Pi/2 || s.avgStep < 8) {
				s.frozen = true
			}
		}

		// While unfrozen AND faithful (the last emitted position was the last
		// true position), stay faithful: pass the record through untouched.
		// This also preserves the capture's OWN discontinuities — a ghost
		// re-spotted across the map jumps exactly as recorded — and means
		// normal flight is never speed-capped. The glide below only ever
		// recovers from divergence this transform itself introduced.
		faithful := s.dispX == s.lastTX && s.dispZ == s.lastTZ
		s.lastTX, s.lastTZ = u.Pos.X, u.Pos.Z
		if !s.frozen && faithful {
			s.dispX, s.dispZ = u.Pos.X, u.Pos.Z
			continue
		}

		// Glide the emitted position toward the target — the anchor when
		// frozen, the true position otherwise — capped per sample so the
		// output path is always continuous (no teleports, in either
		// direction).
		targetX, targetZ := u.Pos.X, u.Pos.Z
		if s.frozen {
			targetX, targetZ = s.anchorX, s.anchorZ
		}
		gdx, gdz := float64(targetX-s.dispX), float64(targetZ-s.dispZ)
		if d2 := gdx*gdx + gdz*gdz; d2 > 0 {
			step := w.glideStep[u.DefID]
			if step <= 0 {
				step = w.opts.Radius / 2
			}
			if d2 > step*step {
				d := math.Sqrt(d2)
				targetX = s.dispX + float32(gdx/d*step)
				targetZ = s.dispZ + float32(gdz/d*step)
			}
		}

		w.rewrittenRecords++
		if !rewritten {
			rewritten = true
			units = make([]UnitState, len(fr.Units))
			copy(units, fr.Units)
			u = &units[i]
		}
		// Velocity = the emitted displacement, so the viewer interpolates the
		// glide smoothly and a constant-velocity glide self-predicts in the
		// delta codec (a parked plane emits zeros and costs nothing).
		u.VelX = (targetX - s.dispX) / float32(w.sampleSec*30)
		u.VelZ = (targetZ - s.dispZ) / float32(w.sampleSec*30)
		u.VelY = 0
		u.Pos.X, u.Pos.Z = targetX, targetZ
		s.dispX, s.dispZ = targetX, targetZ
	}
	fr.Units = units

	// Sweep state for units that left the world.
	for id, s := range w.units {
		if !s.seen {
			delete(w.units, id)
		} else {
			s.seen = false
		}
	}
	return w.next.WriteFrame(fr)
}

func (w *AirIdleWriter) WriteEvent(e Event) error { return w.next.WriteEvent(e) }
func (w *AirIdleWriter) Close() error             { return w.next.Close() }

// Stats returns (aircraft unit-samples seen, unit-samples rewritten — parked
// at an anchor or gliding to/from one).
func (w *AirIdleWriter) Stats() (aircraft, rewritten int64) {
	return w.aircraftRecords, w.rewrittenRecords
}
