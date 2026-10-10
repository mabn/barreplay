// Package capture decodes the capture stream the Lua widget
// (assets/lua/replay_uploader.lua — the live uploader and the re-simulation
// sampler are the same file) writes, and drives a snapshot.Writer. The
// stream is the binary .brepstream (brep.go; spec docs/brepstream-format.md),
// whose head is a short text preamble of "BRSNAP <record>" lines (lines.go).
//
// The text-only .brsnap stream the old re-simulation sampler wrote is no
// longer read: its frames are a strict subset of what a .brepstream carries
// and nothing produces it any more.
//
// The format is internal and evolves in lockstep with the widget. The
// persisted on-disk format is owned separately by the snapshot package.
package capture

import (
	"strconv"
)

// Tag prefixes every preamble line the widget emits.
const Tag = "BRSNAP"

// Stats reports counters observed in the stream, for the CLI's end-of-run
// summary. All fields are best-effort: a truncated stream (or a widget that
// never loaded) leaves the corresponding zero values.
type Stats struct {
	// Frames counts sampled frames; LastFrame is the sim frame of the newest one.
	Frames    int
	LastFrame int32
	// Comms counts recorded chat messages and map drawings. Worth reporting
	// because zero is ambiguous — a quiet game and a widget too old to record
	// them look the same in the output file.
	Comms int
	// Analysis record counts (re-simulations only; see snapshot/analysis.go).
	Facts, DamageWindows, Lives, Visibility, Hits, UnitEnds int
	// Profile holds the engine's internal time-profiler records (the final
	// P record, emitted once at game over), largest first. Profiler scopes nest (e.g.
	// "Sim::Path" is also inside "Sim"), so entries overlap and do not sum to
	// wall time.
	Profile []ProfileEntry
	// ProfileSamples holds the per-heartbeat profiler samples (P records,
	// -profile mode only) in stream order: cumulative per-scope totals tagged
	// with the sim frame and unit count at sampling time.
	ProfileSamples []ProfileSample
}

// ProfileEntry is one engine time-profiler record: total accumulated wall
// milliseconds spent in a named internal scope over the whole run.
type ProfileEntry struct {
	Name string
	Ms   float64
}

// ProfileSample is one per-heartbeat profiler observation: the cumulative wall
// milliseconds a scope had accumulated by a sim frame, plus the unit count then.
type ProfileSample struct {
	Frame int32
	Units int32
	Ms    float64
	Name  string
}

func atoi32(s string) int32 {
	n, _ := strconv.ParseInt(s, 10, 32)
	return int32(n)
}

func atof32(s string) float32 {
	f, _ := strconv.ParseFloat(s, 32)
	return float32(f)
}

func atof64(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}
