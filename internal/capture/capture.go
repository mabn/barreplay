// Package capture parses the tagged text stream the snapshot Lua widget writes
// to the engine's stdout and drives a snapshot.Writer.
//
// Wire format (one record per line; every line the widget emits is prefixed with
// the BRSNAP tag so unrelated engine infolog output is ignored):
//
//	BRSNAP DEF <json>                             full unit-def (JSON; preamble)
//	BRSNAP D <defID> <name>                       unit-def id -> internal name (legacy preamble)
//	BRSNAP T <teamID> <allyTeam> <side> <color>   team info (preamble; side "_" = none)
//	BRSNAP P <playerID> <team> <spectator> <name...>   player info (preamble)
//	BRSNAP READY                                  end of preamble (optional)
//	BRSNAP F <frame> <timeSec> <count>            start of a periodic snapshot
//	BRSNAP U <id> <def> <team> <x> <y> <z> <hp> <maxHp> [<vx> <vy> <vz> <build>]   one unit (follows an F line)
//	BRSNAP R <teamID> <metal> <energy> <mStore> <eStore> <mIncome> <eIncome>   team economy (follows an F line)
//	BRSNAP EV <frame> <kind> <id> <def> <team>    unit lifecycle event
//	BRSNAP PROF <totalMs> <name>                  engine time-profiler record (at game over)
//
// The format is internal and evolves in lockstep with assets/lua/snapshot_widget.lua.
// The persisted on-disk format is owned separately by the snapshot package.
package capture

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/mabn/barreplay/snapshot"
)

// Tag prefixes every line the widget emits.
const Tag = "BRSNAP"

// Stats reports counters observed in the stream, for the CLI's end-of-run
// summary. All fields are best-effort: a truncated stream (or a widget that
// never loaded) leaves the corresponding zero values.
type Stats struct {
	// Frames counts sampled frames; LastFrame is the sim frame of the newest one.
	Frames    int
	LastFrame int32
	// Profile holds the engine's internal time-profiler records (PROF lines,
	// emitted once at game over), largest first. Profiler scopes nest (e.g.
	// "Sim::Path" is also inside "Sim"), so entries overlap and do not sum to
	// wall time.
	Profile []ProfileEntry
	// ProfileSamples holds the per-heartbeat profiler samples (PROFD lines,
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

// Consume reads the widget stream from r and writes records to w. base carries the
// static metadata already known to the caller (gameId, versions, map, sampleEvery);
// the unit-def and team tables discovered in the stream are merged into it, and the
// combined Meta is written exactly once before the first frame/event.
//
// Consume is tolerant of interleaved non-BRSNAP engine output and of a truncated
// stream (e.g. the engine is killed) — it flushes whatever it has.
func Consume(r io.Reader, base snapshot.Meta, w snapshot.Writer) error {
	return ConsumeStats(r, base, w, nil)
}

// ConsumeStats is Consume, additionally filling stats (which may be nil) with
// counters as they are observed in the stream.
func ConsumeStats(r io.Reader, base snapshot.Meta, w snapshot.Writer, stats *Stats) error {
	if stats == nil {
		stats = &Stats{}
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	if base.UnitDefs == nil {
		base.UnitDefs = map[int32]snapshot.UnitDef{}
	}
	metaWritten := false
	var pending *snapshot.Frame // frame currently being assembled from U/R lines
	pendingCount := int32(-1)   // unit count the F line declared (-1 = unknown)
	pendingParsed := int32(0)   // U lines seen for it (kept or dropped)
	graves := graveyard{}       // ids the stream reported destroyed (see lines.go)
	protocol := 0               // GAME line's stream-semantics version (0 = none seen)
	gameSpeed := int32(30)      // sim frames per game-second (from the GAME line)

	flushMeta := func() error {
		if metaWritten {
			return nil
		}
		metaWritten = true
		backfillTeamPlayers(&base)
		return w.WriteMeta(base)
	}
	flushFrame := func() error {
		if pending == nil {
			return nil
		}
		// The widget emits a whole frame in one Echo; if the engine's log ever
		// truncated that write, we'd see fewer U lines than the F line declared.
		// Surface it rather than silently persisting a short frame.
		// Counted against the U lines PARSED, not the units kept: the
		// graveyard pass legitimately drops some (see lines.go).
		if pendingCount >= 0 && pendingCount != pendingParsed {
			fmt.Fprintf(os.Stderr, "capture: frame %d declared %d units but parsed %d (truncated log line?)\n",
				pending.Frame, pendingCount, pendingParsed)
		}
		fr := *pending
		pending = nil
		pendingCount = -1
		pendingParsed = 0
		return w.WriteFrame(fr)
	}

	for sc.Scan() {
		line := sc.Text()
		// Fast reject of engine noise.
		idx := strings.Index(line, Tag+" ")
		if idx < 0 {
			continue
		}
		content := line[idx+len(Tag)+1:]
		fields := strings.Fields(content)
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "GID", "GAME", "D", "DEF", "P", "T":
			// Preamble records shared with the binary .brepstream head.
			if g, _ := applyPreambleLine(fields, content, &base); g != nil {
				protocol = g.Protocol
				if g.GameSpeed > 0 {
					gameSpeed = g.GameSpeed
				}
			}
		case "READY":
			if err := flushMeta(); err != nil {
				return err
			}
		case "F": // F <frame> <timeSec> <count>
			if err := flushFrame(); err != nil {
				return err
			}
			if err := flushMeta(); err != nil {
				return err
			}
			if len(fields) >= 3 {
				fr := snapshot.Frame{Frame: atoi32(fields[1]), TimeSec: atof32(fields[2])}
				stats.Frames++
				stats.LastFrame = fr.Frame
				pendingCount = -1
				pendingParsed = 0
				if len(fields) >= 4 {
					pendingCount = atoi32(fields[3])
					if pendingCount > 0 {
						fr.Units = make([]snapshot.UnitState, 0, pendingCount)
					}
				}
				pending = &fr
			}
		case "U": // U <id> <def> <team> <x> <y> <z> <hp> <maxHp> [<vx> <vy> <vz> <build>]
			if pending != nil && len(fields) >= 9 {
				us := snapshot.UnitState{
					UnitID:    atoi32(fields[1]),
					DefID:     atoi32(fields[2]),
					Team:      atoi32(fields[3]),
					Pos:       snapshot.Vec3{X: atof32(fields[4]), Y: atof32(fields[5]), Z: atof32(fields[6])},
					Health:    atof32(fields[7]),
					MaxHealth: atof32(fields[8]),
				}
				// Velocity + build progress are appended by newer widgets; older
				// .brsnap streams stop at maxHp.
				if len(fields) >= 13 {
					us.VelX = atof32(fields[9])
					us.VelY = atof32(fields[10])
					us.VelZ = atof32(fields[11])
					us.BuildProgress = atof32(fields[12])
				}
				pendingParsed++
				// Every U line restates its unit, so a buried id survives only
				// by reappearing alive (id reuse).
				if !graves.drop(us.UnitID, float64(us.Health), true) {
					pending.Units = append(pending.Units, us)
				}
			}
		case "R": // R <teamID> <metal> <energy> <mStore> <eStore> <mIncome> <eIncome>
			if pending != nil && len(fields) >= 8 {
				pending.Resources = append(pending.Resources, snapshot.TeamResource{
					Team:          atoi32(fields[1]),
					Metal:         atof32(fields[2]),
					Energy:        atof32(fields[3]),
					MetalStorage:  atof32(fields[4]),
					EnergyStorage: atof32(fields[5]),
					MetalIncome:   repairIncome(atof32(fields[6]), protocol, gameSpeed),
					EnergyIncome:  repairIncome(atof32(fields[7]), protocol, gameSpeed),
				})
			}
		case "PROF": // PROF <totalMs> <name> (name is last; profiler names may contain anything)
			if len(fields) >= 3 {
				stats.Profile = append(stats.Profile, ProfileEntry{
					Name: strings.Join(fields[2:], " "),
					Ms:   atof64(fields[1]),
				})
			}
		case "PROFD": // PROFD <frame> <units> <totalMs> <name> (name last, as in PROF)
			if len(fields) >= 5 {
				stats.ProfileSamples = append(stats.ProfileSamples, ProfileSample{
					Frame: atoi32(fields[1]),
					Units: atoi32(fields[2]),
					Ms:    atof64(fields[3]),
					Name:  strings.Join(fields[4:], " "),
				})
			}
		case "EV": // EV <frame> <kind> <id> <def> <team>
			if err := flushFrame(); err != nil {
				return err
			}
			if err := flushMeta(); err != nil {
				return err
			}
			if len(fields) >= 6 {
				ev := snapshot.Event{
					Frame:  atoi32(fields[1]),
					Kind:   snapshot.EventKind(fields[2]),
					UnitID: atoi32(fields[3]),
					DefID:  atoi32(fields[4]),
					Team:   atoi32(fields[5]),
				}
				graves.note(ev.Kind, ev.UnitID)
				if err := w.WriteEvent(ev); err != nil {
					return err
				}
			}
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	if err := flushFrame(); err != nil {
		return err
	}
	// Ensure meta is written even for an empty capture.
	return flushMeta()
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
