// Package capture parses the tagged text stream the snapshot Lua widget writes
// to the engine's stdout and drives a snapshot.Writer.
//
// Wire format (one record per line; every line the widget emits is prefixed with
// the BRSNAP tag so unrelated engine infolog output is ignored):
//
//	BRSNAP D <defID> <name>                       unit-def id -> internal name (preamble)
//	BRSNAP T <teamID> <allyTeam> <side>           team info (preamble)
//	BRSNAP READY                                  end of preamble (optional)
//	BRSNAP F <frame> <timeSec> <count>            start of a periodic snapshot
//	BRSNAP U <id> <def> <team> <x> <y> <z> <hp> <maxHp>   one unit (follows an F line)
//	BRSNAP EV <frame> <kind> <id> <def> <team>    unit lifecycle event
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

// Consume reads the widget stream from r and writes records to w. base carries the
// static metadata already known to the caller (gameId, versions, map, sampleEvery);
// the unit-def and team tables discovered in the stream are merged into it, and the
// combined Meta is written exactly once before the first frame/event.
//
// Consume is tolerant of interleaved non-BRSNAP engine output and of a truncated
// stream (e.g. the engine is killed) — it flushes whatever it has.
func Consume(r io.Reader, base snapshot.Meta, w snapshot.Writer) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	if base.UnitDefs == nil {
		base.UnitDefs = map[int32]string{}
	}
	metaWritten := false
	var pending *snapshot.Frame // frame currently being assembled from U lines
	pendingCount := int32(-1)   // unit count the F line declared (-1 = unknown)

	flushMeta := func() error {
		if metaWritten {
			return nil
		}
		metaWritten = true
		return w.WriteMeta(base)
	}
	flushFrame := func() error {
		if pending == nil {
			return nil
		}
		// The widget emits a whole frame in one Echo; if the engine's log ever
		// truncated that write, we'd see fewer U lines than the F line declared.
		// Surface it rather than silently persisting a short frame.
		if pendingCount >= 0 && int(pendingCount) != len(pending.Units) {
			fmt.Fprintf(os.Stderr, "capture: frame %d declared %d units but parsed %d (truncated log line?)\n",
				pending.Frame, pendingCount, len(pending.Units))
		}
		fr := *pending
		pending = nil
		pendingCount = -1
		return w.WriteFrame(fr)
	}

	for sc.Scan() {
		line := sc.Text()
		// Fast reject of engine noise.
		idx := strings.Index(line, Tag+" ")
		if idx < 0 {
			continue
		}
		fields := strings.Fields(line[idx+len(Tag)+1:])
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "D": // D <defID> <name>
			if len(fields) >= 3 {
				base.UnitDefs[atoi32(fields[1])] = fields[2]
			}
		case "T": // T <teamID> <allyTeam> <side>
			if len(fields) >= 3 {
				ti := snapshot.TeamInfo{TeamID: atoi32(fields[1]), AllyTeam: atoi32(fields[2])}
				if len(fields) >= 4 {
					ti.Side = fields[3]
				}
				base.Teams = append(base.Teams, ti)
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
				pendingCount = -1
				if len(fields) >= 4 {
					pendingCount = atoi32(fields[3])
					if pendingCount > 0 {
						fr.Units = make([]snapshot.UnitState, 0, pendingCount)
					}
				}
				pending = &fr
			}
		case "U": // U <id> <def> <team> <x> <y> <z> <hp> <maxHp>
			if pending != nil && len(fields) >= 9 {
				pending.Units = append(pending.Units, snapshot.UnitState{
					UnitID:    atoi32(fields[1]),
					DefID:     atoi32(fields[2]),
					Team:      atoi32(fields[3]),
					Pos:       snapshot.Vec3{X: atof32(fields[4]), Y: atof32(fields[5]), Z: atof32(fields[6])},
					Health:    atof32(fields[7]),
					MaxHealth: atof32(fields[8]),
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
				if err := w.WriteEvent(snapshot.Event{
					Frame:  atoi32(fields[1]),
					Kind:   snapshot.EventKind(fields[2]),
					UnitID: atoi32(fields[3]),
					DefID:  atoi32(fields[4]),
					Team:   atoi32(fields[5]),
				}); err != nil {
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
