// .brepstream decoding: the binary capture stream the player-installable
// "Replay uploader" widget writes (assets/lua/replay_uploader.lua). The two
// implementations must evolve in lockstep; the stream is versioned by its
// header line. Full byte-level spec: docs/brepstream-format.md.
//
// Layout:
//
//	line "BREPSTREAM 1"
//	text preamble (BRSNAP GID/GAME/DEF/T/P lines), terminated by the
//	"BRSNAP READY" line
//	then length-framed binary records: <tag u8> <len u32le> <payload>
//	  'F'  frame (see decodeFrameRecord)
//	  'E'  unit lifecycle event, text payload
//	       "<frame> <kind> <id> <def> <team> [<aID> <aDef> <aTeam> <weapon>]"
//	  'C'  chat message or map drawing, JSON payload (see parseComm)
//	  'G'  game fact, JSON payload (snapshot.Fact)
//	  'D'  damage window, packed (decodeDamageRecord)
//	  'S'  per-unit lifetime totals, packed (decodeLivesRecord)
//	  'V'  per-side visibility changes, packed (decodeVisibilityRecord)
//	  'P'  engine profiler readings, JSON (into Stats, not the writer)
//	  'X'  end of stream, text payload = reason
//	  anything else: skipped (forward compatibility)
//
// A frame record's unit data is columnar and quantized exactly like the .brp
// codec (whole elmos/hp, velocity as per-sample-interval displacement, build
// progress 1/255; y/vy are not stored). A keyframe (flags bit 0) carries every
// visible unit and resets decoder state. A delta frame carries only units that
// diverged from their own prediction — every other tracked unit advances by
// x += dvx, z += dvz with all other columns carried — plus an explicit dead-id
// list. The widget-side encoder advances its mirror state by the same rule, so
// the two cannot drift.
//
// Like Consume, decoding is tolerant of truncation (a live game can end in a
// crash): a partial trailing record is dropped with a warning and everything
// before it is kept.
package capture

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strings"

	"github.com/mabn/barreplay/snapshot"
)

// BrepHeader is the first line of a .brepstream file.
const BrepHeader = "BREPSTREAM 1"

// maxBrepRecord caps a record's declared payload length; anything larger means
// a corrupt stream (a 30k-unit keyframe is ~700 KB).
const maxBrepRecord = 64 << 20

// ConsumeBrep reads a .brepstream from r and writes records to w, seeded with
// base exactly like Consume.
func ConsumeBrep(r io.Reader, base snapshot.Meta, w snapshot.Writer) error {
	return ConsumeBrepStats(r, base, w, nil)
}

// brepUnit is the decoder's tracked state for one live unit, in the stream's
// quantized integer domain.
type brepUnit struct {
	def, team                int32
	x, z, dvx, dvz           int32
	hp, maxHp, build, target int32
}

// ConsumeBrepStats is ConsumeBrep, additionally filling stats (which may be
// nil) with counters as they are observed.
func ConsumeBrepStats(r io.Reader, base snapshot.Meta, w snapshot.Writer, stats *Stats) error {
	if stats == nil {
		stats = &Stats{}
	}
	br := bufio.NewReaderSize(r, 256<<10)

	line, err := br.ReadString('\n')
	if err != nil || strings.TrimRight(line, "\r\n") != BrepHeader {
		return fmt.Errorf("capture: not a brepstream (missing %q header line)", BrepHeader)
	}

	// Text preamble, up to the READY line (or EOF for a stream truncated that
	// early).
	if base.UnitDefs == nil {
		base.UnitDefs = map[int32]snapshot.UnitDef{}
	}
	sampleEvery, gameSpeed := base.SampleEvery, int32(30)
	protocol := 0 // GAME line's stream-semantics version (0 = none seen)
	scanPreamble := func(m *snapshot.Meta) {
		for {
			line, err := br.ReadString('\n')
			if line != "" {
				content, ok := strings.CutPrefix(strings.TrimRight(line, "\r\n"), Tag+" ")
				if ok {
					fields := strings.Fields(content)
					if len(fields) > 0 {
						if fields[0] == "READY" {
							return
						}
						g, _ := applyPreambleLine(fields, content, m)
						if g != nil {
							protocol = g.Protocol
							if g.SampleEvery > 0 {
								sampleEvery = g.SampleEvery
							}
							if g.GameSpeed > 0 {
								gameSpeed = g.GameSpeed
							}
						}
					}
				}
			}
			if err != nil {
				return // EOF mid-preamble: still emit the meta we have
			}
		}
	}
	scanPreamble(&base)
	if base.SampleEvery == 0 {
		base.SampleEvery = sampleEvery
	}
	if sampleEvery <= 0 {
		sampleEvery = 30 // velocity de-quantization needs a divisor
	}
	backfillTeamPlayers(&base)
	if err := w.WriteMeta(base); err != nil {
		return err
	}

	// Binary record loop. A widget disabled and re-enabled mid-game APPENDS a
	// whole new self-contained segment (header line + preamble + records) to
	// the file; the header line read at record position — its first byte 'B'
	// where a tag would be — marks the restart. Segments never overlap in
	// frames when written by the widget (rejoins truncate instead), but stale
	// frames are guarded against anyway so a downstream writer always sees a
	// monotonic frame sequence.
	state := map[int32]*brepUnit{}
	graves := graveyard{}
	lastEmitted := int32(-1)
	staleWarned := false
	var hdr [5]byte
	for {
		if _, err := io.ReadFull(br, hdr[:1]); err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("capture: reading record tag: %w", err)
		}
		if hdr[0] == 'B' { // "BREPSTREAM 1\n" between records: segment restart
			rest, err := br.ReadString('\n')
			if err != nil || strings.TrimRight(rest, "\r\n") != BrepHeader[1:] {
				fmt.Fprintf(os.Stderr, "capture: malformed segment header after %d frames; stopping\n", stats.Frames)
				return nil
			}
			// The segment repeats the preamble; meta is already written, so
			// apply it to a scratch (only sampleEvery/gameSpeed may matter —
			// the re-enabled widget could even be a newer version).
			scratch := snapshot.Meta{UnitDefs: map[int32]snapshot.UnitDef{}}
			scanPreamble(&scratch)
			for id := range state {
				delete(state, id)
			}
			continue
		}
		if _, err := io.ReadFull(br, hdr[1:5]); err != nil {
			fmt.Fprintf(os.Stderr, "capture: brepstream truncated mid record header; keeping %d frames\n", stats.Frames)
			return nil
		}
		n := binary.LittleEndian.Uint32(hdr[1:5])
		if n > maxBrepRecord {
			return fmt.Errorf("capture: record length %d exceeds limit (corrupt stream?)", n)
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(br, payload); err != nil {
			fmt.Fprintf(os.Stderr, "capture: brepstream truncated mid record; keeping %d frames\n", stats.Frames)
			return nil
		}
		switch hdr[0] {
		case 'F':
			fr, err := decodeFrameRecord(payload, state, graves, sampleEvery, gameSpeed)
			if err != nil {
				fmt.Fprintf(os.Stderr, "capture: bad frame record: %v; keeping %d frames\n", err, stats.Frames)
				return nil
			}
			if fr.Frame <= lastEmitted {
				// Overlapping segment (should not happen: rejoins truncate).
				// The decode above still updated state, keeping the segment
				// self-consistent; just don't emit a non-monotonic frame.
				if !staleWarned {
					staleWarned = true
					fmt.Fprintf(os.Stderr, "capture: brepstream segment overlaps frame %d <= %d; skipping stale frames\n", fr.Frame, lastEmitted)
				}
				continue
			}
			lastEmitted = fr.Frame
			// Legacy streams (protocol <= 2) carry income over-scaled by
			// gameSpeed; see repairIncome. Per-segment: a re-enabled widget
			// appending to an old file could be a newer version.
			for i := range fr.Resources {
				fr.Resources[i].MetalIncome = repairIncome(fr.Resources[i].MetalIncome, protocol, gameSpeed)
				fr.Resources[i].EnergyIncome = repairIncome(fr.Resources[i].EnergyIncome, protocol, gameSpeed)
			}
			stats.Frames++
			stats.LastFrame = fr.Frame
			if err := w.WriteFrame(fr); err != nil {
				return err
			}
		case 'E': // "<frame> <kind> <id> <def> <team> [<aID> <aDef> <aTeam> <weapon>]"
			f := strings.Fields(string(payload))
			if len(f) >= 5 {
				ev := snapshot.Event{
					Frame:  atoi32(f[0]),
					Kind:   snapshot.EventKind(f[1]),
					UnitID: atoi32(f[2]),
					DefID:  atoi32(f[3]),
					Team:   atoi32(f[4]),
				}
				if len(f) >= 9 {
					c := snapshot.EventCause{UnitID: atoi32(f[5]), DefID: atoi32(f[6]), Team: atoi32(f[7]), WeaponDef: atoi32(f[8])}
					if c.UnitID >= 0 || c.DefID >= 0 || c.Team >= 0 || c.WeaponDef >= 0 {
						ev.Cause = &c
					}
				}
				graves.note(ev.Kind, ev.UnitID)
				if err := w.WriteEvent(ev); err != nil {
					return err
				}
			}
		case 'C': // chat message or map drawing, JSON payload (see parseComm)
			if c, ok := parseComm(string(payload)); ok {
				stats.Comms++
				if err := w.WriteComm(c); err != nil {
					return err
				}
			}
		case 'G': // game fact, JSON
			fact, err := snapshot.ParseFact(payload)
			if err != nil {
				fmt.Fprintf(os.Stderr, "capture: bad G record %q: %v\n", payload, err)
				continue
			}
			stats.Facts++
			if err := w.WriteFact(fact); err != nil {
				return err
			}
		case 'D':
			dw, err := decodeDamageRecord(payload)
			if err != nil {
				fmt.Fprintf(os.Stderr, "capture: bad damage record: %v\n", err)
				continue
			}
			stats.DamageWindows++
			if err := w.WriteDamage(dw); err != nil {
				return err
			}
		case 'S':
			lives, err := decodeLivesRecord(payload)
			if err != nil {
				fmt.Fprintf(os.Stderr, "capture: bad lives record: %v\n", err)
				continue
			}
			for _, l := range lives {
				stats.Lives++
				if err := w.WriteLife(l); err != nil {
					return err
				}
			}
		case 'V':
			v, err := decodeVisibilityRecord(payload)
			if err != nil {
				fmt.Fprintf(os.Stderr, "capture: bad visibility record: %v\n", err)
				continue
			}
			stats.Visibility++
			if err := w.WriteVisibility(v); err != nil {
				return err
			}
		case 'P':
			applyProfileRecord(payload, stats)
		case 'X':
			// End-of-stream marker; the reason is informational only.
		default:
			// Unknown record type: skip (already consumed).
		}
	}
}

// cursor is a bounds-checked little-endian reader over a record payload.
type cursor struct {
	b   []byte
	off int
	err error
}

func (c *cursor) take(n int) []byte {
	if c.err != nil {
		return nil
	}
	if c.off+n > len(c.b) {
		c.err = fmt.Errorf("payload too short: want %d bytes at %d, have %d", n, c.off, len(c.b))
		return nil
	}
	s := c.b[c.off : c.off+n]
	c.off += n
	return s
}

func (c *cursor) u8() int32 {
	s := c.take(1)
	if s == nil {
		return 0
	}
	return int32(s[0])
}

func (c *cursor) u16() int32 {
	s := c.take(2)
	if s == nil {
		return 0
	}
	return int32(binary.LittleEndian.Uint16(s))
}

func (c *cursor) s16() int32 {
	s := c.take(2)
	if s == nil {
		return 0
	}
	return int32(int16(binary.LittleEndian.Uint16(s)))
}

func (c *cursor) u32() int64 {
	s := c.take(4)
	if s == nil {
		return 0
	}
	return int64(binary.LittleEndian.Uint32(s))
}

func (c *cursor) f32() float32 {
	s := c.take(4)
	if s == nil {
		return 0
	}
	return math.Float32frombits(binary.LittleEndian.Uint32(s))
}

// decodeFrameRecord decodes one 'F' payload, mutating state, and returns the
// reconstructed full frame.
func decodeFrameRecord(payload []byte, state map[int32]*brepUnit, graves graveyard, sampleEvery, gameSpeed int32) (snapshot.Frame, error) {
	c := &cursor{b: payload}
	frame := int32(c.u32())
	flags := c.u8()
	nUnits := int(c.u16())
	nDead := int(c.u16())
	nRes := int(c.u8())
	keyframe := flags&1 != 0
	hasTarget := flags&2 != 0 // widget >= 1.4.0 appends the build-target column

	// Columns (present only when nUnits > 0, but reading 0-length columns is a
	// no-op either way).
	ids := make([]int32, nUnits)
	for i := range ids {
		ids[i] = c.u16()
	}
	defs := make([]int32, nUnits)
	for i := range defs {
		defs[i] = c.u16()
	}
	teams := make([]int32, nUnits)
	for i := range teams {
		teams[i] = c.u8()
	}
	xs := make([]int32, nUnits)
	for i := range xs {
		xs[i] = c.s16()
	}
	zs := make([]int32, nUnits)
	for i := range zs {
		zs[i] = c.s16()
	}
	hps := make([]int32, nUnits)
	for i := range hps {
		hps[i] = int32(c.u32())
	}
	maxHps := make([]int32, nUnits)
	for i := range maxHps {
		maxHps[i] = int32(c.u32())
	}
	dvxs := make([]int32, nUnits)
	for i := range dvxs {
		dvxs[i] = c.s16()
	}
	dvzs := make([]int32, nUnits)
	for i := range dvzs {
		dvzs[i] = c.s16()
	}
	builds := make([]int32, nUnits)
	for i := range builds {
		builds[i] = c.u8()
	}
	targets := make([]int32, nUnits)
	if hasTarget {
		for i := range targets {
			targets[i] = c.u16()
		}
	}
	dead := make([]int32, nDead)
	for i := range dead {
		dead[i] = c.u16()
	}
	resTeams := make([]int32, nRes)
	for i := range resTeams {
		resTeams[i] = c.u8()
	}
	resCols := make([][]float32, 6)
	for k := range resCols {
		resCols[k] = make([]float32, nRes)
		for i := 0; i < nRes; i++ {
			resCols[k][i] = c.f32()
		}
	}
	if c.err != nil {
		return snapshot.Frame{}, c.err
	}

	if keyframe {
		// A keyframe restates the world; everything tracked before it is gone.
		for id := range state {
			delete(state, id)
		}
	} else {
		for _, id := range dead {
			delete(state, id)
		}
		// Advance every unit NOT restated in this record by its own prediction.
		changed := make(map[int32]bool, nUnits)
		for _, id := range ids {
			changed[id] = true
		}
		for id, u := range state {
			if !changed[id] {
				u.x += u.dvx
				u.z += u.dvz
			}
		}
	}
	for i := 0; i < nUnits; i++ {
		u := state[ids[i]]
		if u == nil {
			u = &brepUnit{}
			state[ids[i]] = u
		}
		u.def, u.team = defs[i], teams[i]
		u.x, u.z = xs[i], zs[i]
		u.hp, u.maxHp, u.build = hps[i], maxHps[i], builds[i]
		u.target = targets[i]
		u.dvx, u.dvz = dvxs[i], dvzs[i]
	}

	// Drop anything the stream itself already reported destroyed (see
	// graveyard): an old widget could keep restating a killed unit forever.
	if len(graves) > 0 {
		restated := make(map[int32]bool, nUnits)
		for _, id := range ids {
			restated[id] = true
		}
		for id := range graves {
			u := state[id]
			if u == nil {
				continue
			}
			if graves.drop(id, float64(u.hp), restated[id]) {
				delete(state, id)
			}
		}
	}

	fr := snapshot.Frame{
		Frame:   frame,
		TimeSec: float32(frame) / float32(gameSpeed),
		Units:   make([]snapshot.UnitState, 0, len(state)),
	}
	for id, u := range state {
		fr.Units = append(fr.Units, snapshot.UnitState{
			UnitID:        id,
			DefID:         u.def,
			Team:          u.team,
			Pos:           snapshot.Vec3{X: float32(u.x), Z: float32(u.z)},
			Health:        float32(u.hp),
			MaxHealth:     float32(u.maxHp),
			VelX:          float32(u.dvx) / float32(sampleEvery),
			VelZ:          float32(u.dvz) / float32(sampleEvery),
			BuildProgress: float32(u.build) / 255,
			TargetID:      u.target,
		})
	}
	sort.Slice(fr.Units, func(i, j int) bool { return fr.Units[i].UnitID < fr.Units[j].UnitID })
	for i := 0; i < nRes; i++ {
		fr.Resources = append(fr.Resources, snapshot.TeamResource{
			Team:          resTeams[i],
			Metal:         resCols[0][i],
			Energy:        resCols[1][i],
			MetalStorage:  resCols[2][i],
			EnergyStorage: resCols[3][i],
			MetalIncome:   resCols[4][i],
			EnergyIncome:  resCols[5][i],
		})
	}
	return fr, nil
}

// unknown8 / unknown16 map the stream's "unknown" sentinels to -1.
func unknown8(v int32) int32 {
	if v == 0xFF {
		return -1
	}
	return v
}

func unknown16(v int32) int32 {
	if v == 0xFFFF {
		return -1
	}
	return v
}

// decodeDamageRecord decodes one 'D' payload: frame u32, n u16, then columns
// aTeam u8, aDef u16, weapon u16, vTeam u8, vDef u16, damage f32,
// paralyze f32, hits u16, overkill f32.
func decodeDamageRecord(payload []byte) (snapshot.DamageWindow, error) {
	c := &cursor{b: payload}
	dw := snapshot.DamageWindow{Frame: int32(c.u32())}
	n := int(c.u16())
	if c.err == nil && n*21 > len(payload) {
		return dw, fmt.Errorf("damage record declares %d rows in %d bytes", n, len(payload))
	}
	dw.Rows = make([]snapshot.DamageRow, n)
	for i := range dw.Rows {
		dw.Rows[i].AttackerTeam = unknown8(c.u8())
	}
	for i := range dw.Rows {
		dw.Rows[i].AttackerDef = unknown16(c.u16())
	}
	for i := range dw.Rows {
		dw.Rows[i].WeaponDef = unknown16(c.u16())
	}
	for i := range dw.Rows {
		dw.Rows[i].VictimTeam = unknown8(c.u8())
	}
	for i := range dw.Rows {
		dw.Rows[i].VictimDef = unknown16(c.u16())
	}
	for i := range dw.Rows {
		dw.Rows[i].Damage = c.f32()
	}
	for i := range dw.Rows {
		dw.Rows[i].Paralyze = c.f32()
	}
	for i := range dw.Rows {
		dw.Rows[i].Hits = c.u16()
	}
	for i := range dw.Rows {
		dw.Rows[i].Overkill = c.f32()
	}
	return dw, c.err
}

// decodeLivesRecord decodes one 'S' payload: frame u32, n u16, then columns
// id u16, def u16, team u8, born u32, died u32 (0xFFFFFFFF = alive at the
// end), dealt f32, taken f32, kills u16, minHp u8, xp f32.
func decodeLivesRecord(payload []byte) ([]snapshot.UnitLife, error) {
	c := &cursor{b: payload}
	c.u32() // the frame the record was written on; each row carries its own
	n := int(c.u16())
	if c.err == nil && n*28 > len(payload) {
		return nil, fmt.Errorf("lives record declares %d rows in %d bytes", n, len(payload))
	}
	ls := make([]snapshot.UnitLife, n)
	for i := range ls {
		ls[i].UnitID = c.u16()
	}
	for i := range ls {
		ls[i].DefID = c.u16()
	}
	for i := range ls {
		ls[i].Team = unknown8(c.u8())
	}
	for i := range ls {
		ls[i].Born = int32(c.u32())
	}
	for i := range ls {
		d := c.u32()
		if d == 0xFFFFFFFF {
			ls[i].Died = -1
		} else {
			ls[i].Died = int32(d)
		}
	}
	for i := range ls {
		ls[i].Dealt = c.f32()
	}
	for i := range ls {
		ls[i].Taken = c.f32()
	}
	for i := range ls {
		ls[i].Kills = c.u16()
	}
	for i := range ls {
		ls[i].MinHealthPct = c.u8()
	}
	for i := range ls {
		ls[i].XP = c.f32()
	}
	return ls, c.err
}

// decodeVisibilityRecord decodes one 'V' payload: frame u32, flags u8 (bit 0
// = every unit restated), nAllies u8, allies u8[nAllies], n u16, then ids
// u16[n] and masks u32[n].
func decodeVisibilityRecord(payload []byte) (snapshot.Visibility, error) {
	c := &cursor{b: payload}
	v := snapshot.Visibility{Frame: int32(c.u32())}
	v.Full = c.u8()&1 != 0
	na := int(c.u8())
	v.Allies = make([]int32, na)
	for i := range v.Allies {
		v.Allies[i] = c.u8()
	}
	n := int(c.u16())
	if c.err == nil && n*6 > len(payload) {
		return v, fmt.Errorf("visibility record declares %d rows in %d bytes", n, len(payload))
	}
	v.Units, v.Masks = make([]int32, n), make([]uint32, n)
	for i := range v.Units {
		v.Units[i] = c.u16()
	}
	for i := range v.Masks {
		v.Masks[i] = uint32(c.u32())
	}
	return v, c.err
}

// profileRecord is a 'P' payload: the engine profiler's per-scope totals at a
// frame — the final ones at game over, or a -profile heartbeat sample.
type profileRecord struct {
	Frame int32                `json:"f"`
	Units int32                `json:"u"`
	Final bool                 `json:"final"`
	R     [][2]json.RawMessage `json:"r"`
}

// applyProfileRecord folds one 'P' record into stats: the final record
// becomes Profile (largest first, as written), a heartbeat sample extends
// ProfileSamples.
func applyProfileRecord(payload []byte, stats *Stats) {
	var p profileRecord
	if err := json.Unmarshal(payload, &p); err != nil {
		fmt.Fprintf(os.Stderr, "capture: bad P record: %v\n", err)
		return
	}
	var entries []ProfileEntry
	for _, r := range p.R {
		var name string
		var ms float64
		if json.Unmarshal(r[0], &name) != nil || json.Unmarshal(r[1], &ms) != nil {
			continue
		}
		entries = append(entries, ProfileEntry{Name: name, Ms: ms})
	}
	if p.Final {
		stats.Profile = entries
		return
	}
	for _, e := range entries {
		stats.ProfileSamples = append(stats.ProfileSamples, ProfileSample{Frame: p.Frame, Units: p.Units, Ms: e.Ms, Name: e.Name})
	}
}
