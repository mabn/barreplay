package snapshot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
)

// Analysis records: what a game summary is computed from. A re-simulation
// watches the whole game as a full-view spectator, so it can record things no
// player's capture could — who killed what, how much damage flowed where,
// what each side could see — and the engine's own end-of-game facts. None of
// it is drawn by the viewer frame by frame; it is the input to summaries
// computed once per replay. Each kind is its own optional .brp section (G, D,
// S, V; .brp v6+), absent from every capture that did not record it.

// Fact is one game fact (a G record): a JSON object whose "k" names its kind
// and whose "f", when present, is the sim frame it happened on. Facts are kept
// VERBATIM, so a kind added to the widget reaches the .brp without a codec
// change; Decode reads one into the matching struct below.
type Fact struct {
	Kind  string
	Frame int32
	JSON  json.RawMessage
}

// Fact kinds the widget writes (see assets/lua/replay_uploader.lua).
const (
	FactEnd        = "end"        // FactEndData: the game ended
	FactTeamDied   = "teamdied"   // FactTeamDiedData: a team was eliminated
	FactPlayerLeft = "playerleft" // FactPlayerLeftData: a player left
	FactWeaponDefs = "wdefs"      // FactWeaponDefsData: the weapon table
	FactTeamStats  = "teamstats"  // FactTeamStatsData: the engine's team statistics
	FactBlast      = "blast"      // FactBlastData: a big death explosion
)

// FactEndData is the end of the game. Winners are ALLY team ids; empty for a
// draw (or a game that ended with nobody standing).
type FactEndData struct {
	Frame   int32   `json:"f"`
	Winners []int32 `json:"winners"`
}

// FactTeamDiedData is a team being eliminated.
type FactTeamDiedData struct {
	Frame int32 `json:"f"`
	Team  int32 `json:"team"`
}

// FactPlayerLeftData is a player leaving the game. Reason is the engine's
// code: 0 lost connection, 1 left, 2 kicked.
type FactPlayerLeftData struct {
	Frame  int32 `json:"f"`
	Player int32 `json:"player"`
	Reason int32 `json:"reason"`
}

// FactBlastData is one big death explosion (an advanced fusion going up):
// the unit that blew up, where, the explosion weapon, who set it off (By*,
// absent when nobody did — a self-destruct, a team dying, or a chain whose
// start the widget did not see) and what the blast did: Damage is health
// removed, Kills the units it destroyed. Only blasts past a threshold are
// written (re-sim only).
type FactBlastData struct {
	Frame  int32  `json:"f"`
	Unit   int32  `json:"unit"`
	Def    int32  `json:"def"`
	Team   int32  `json:"team"`
	X      int32  `json:"x"`
	Z      int32  `json:"z"`
	Weapon int32  `json:"weapon"`
	ByUnit *int32 `json:"byUnit,omitempty"`
	ByDef  *int32 `json:"byDef,omitempty"`
	ByTeam *int32 `json:"byTeam,omitempty"`
	Damage int32  `json:"damage"`
	Kills  int32  `json:"kills"`
}

// WeaponDef is one entry of the weapon table that EventCause.WeaponDef and
// DamageRow.WeaponDef index. Weapon ids are per game build, like unit-def
// ids, which is why the table travels with the capture.
type WeaponDef struct {
	ID          int32   `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description,omitempty"`
	Type        string  `json:"type,omitempty"`
	Range       float32 `json:"range,omitempty"`
	Reload      float32 `json:"reload,omitempty"`
	Damage      float32 `json:"damage,omitempty"` // against the default armour class
	Paralyzer   bool    `json:"paralyzer,omitempty"`
}

// FactWeaponDefsData is the weapon table.
type FactWeaponDefsData struct {
	Defs []WeaponDef `json:"defs"`
}

// FactTeamStatsData is one team's statistics history as the engine kept it
// (the numbers BAR's end-of-game graphs draw): Rows[i][j] is Fields[j] at the
// i-th statistics frame. A demo does not carry these — the re-simulation
// recomputes them.
type FactTeamStatsData struct {
	Team   int32       `json:"team"`
	Fields []string    `json:"fields"`
	Rows   [][]float64 `json:"rows"`
}

// Decode unmarshals the fact's JSON into v (one of the Fact*Data types).
func (f Fact) Decode(v any) error { return json.Unmarshal(f.JSON, v) }

// MarshalJSON writes the fact verbatim.
func (f Fact) MarshalJSON() ([]byte, error) {
	if len(f.JSON) == 0 {
		return []byte("null"), nil
	}
	return f.JSON, nil
}

// ParseFact reads one fact from its JSON object. The kind is required; the
// frame is optional (0 when absent).
func ParseFact(b []byte) (Fact, error) {
	var head struct {
		Kind  string `json:"k"`
		Frame int32  `json:"f"`
	}
	if err := json.Unmarshal(b, &head); err != nil {
		return Fact{}, err
	}
	if head.Kind == "" {
		return Fact{}, fmt.Errorf("snapshot: fact without a kind")
	}
	return Fact{Kind: head.Kind, Frame: head.Frame, JSON: append(json.RawMessage(nil), b...)}, nil
}

// DamageWindow is all the damage dealt in one window of sim frames (one
// sample interval, starting at Frame), aggregated by who hit whom with what.
// No single hit is recorded.
type DamageWindow struct {
	Frame int32       `json:"frame"`
	Rows  []DamageRow `json:"rows"`
}

// DamageEngineCauses is how many of the engine's own damage sources a
// DamageRow can name (Recoil's CSolidObject::DamageType, 1..7).
const DamageEngineCauses = 7

// DamageEngineCause is the DamageRow.WeaponDef recording engine damage source
// k — damage no weapon dealt: 1 debris, 2 ground collision, 3 object
// collision, 4 fire, 5 water (lava), 6 killed by Lua, 7 crushed. The values
// are -2..-8, below -1 (unknown).
func DamageEngineCause(k int32) int32 { return -1 - k }

// DamageCauseName names the engine damage source a negative WeaponDef below
// -1 records, or "" for anything else.
func DamageCauseName(weapon int32) string {
	names := [...]string{"debris", "ground collision", "object collision", "fire", "water", "killed by Lua", "crushed"}
	if k := -1 - weapon; k >= 1 && k <= DamageEngineCauses {
		return names[k-1]
	}
	return ""
}

// weaponPlus encodes a DamageRow.WeaponDef: idPlus for a weapon or unknown,
// and an engine cause (-2..-8) far above any weapon id, so .brp files
// written before causes existed decode unchanged.
func weaponPlus(v int32) uint64 {
	if v < -1 {
		return weaponCauseBase + uint64(-v)
	}
	return idPlus(v)
}

const weaponCauseBase = 1 << 20

func weaponFromPlus(v uint64) int32 {
	if v > weaponCauseBase {
		return -int32(v - weaponCauseBase)
	}
	return int32(v) - 1
}

// DamageRow is one (attacker team, attacker def, weapon, victim team, victim
// def) combination within a window. Ids are -1 when unknown (no attacker — a
// crash, a self-destruct). WeaponDef below -1 is an engine damage source
// rather than a weapon (DamageEngineCause). Damage excludes paralyzer damage, which is
// Paralyze, and counts only health actually removed: a killing blow counts
// the health the victim had left, not the blow's full size. Stored to
// 0.1 hp.
type DamageRow struct {
	AttackerTeam int32   `json:"aTeam"`
	AttackerDef  int32   `json:"aDef"`
	WeaponDef    int32   `json:"weapon"`
	VictimTeam   int32   `json:"vTeam"`
	VictimDef    int32   `json:"vDef"`
	Damage       float32 `json:"damage"`
	Paralyze     float32 `json:"paralyze,omitempty"`
	Hits         int32   `json:"hits"`
}

// UnitLife is one unit's lifetime totals — a LIFE, not an id, because the
// engine recycles ids. Died is -1 for a unit alive when the game ended;
// MinHealthPct is the lowest health it was seen at, in percent of its
// maximum. Dealt/Taken exclude paralyzer damage; stored to 0.1 hp, XP to
// 0.001.
type UnitLife struct {
	UnitID       int32   `json:"id"`
	DefID        int32   `json:"def"`
	Team         int32   `json:"team"`
	Born         int32   `json:"born"`
	Died         int32   `json:"died"`
	Dealt        float32 `json:"dealt"`
	Taken        float32 `json:"taken"`
	Kills        int32   `json:"kills"`
	MinHealthPct int32   `json:"minHp"`
	XP           float32 `json:"xp"`
}

// Visibility is one sample's per-side visibility changes: for each unit in
// Units, Masks holds what each side in Allies could see of it — 2 bits per
// side in Allies order, bit 0 of a pair "in LOS", bit 1 "on radar". Only
// units whose state CHANGED since the previous record are listed (a unit's
// state is otherwise its last one); a Full record restates every unit.
type Visibility struct {
	Frame  int32    `json:"frame"`
	Full   bool     `json:"full,omitempty"`
	Allies []int32  `json:"allies"`
	Units  []int32  `json:"units"`
	Masks  []uint32 `json:"masks"`
}

// Sees reports what side index s (into Allies) could see of the i-th unit.
func (v Visibility) Sees(i, s int) (los, radar bool) {
	bits := v.Masks[i] >> (2 * uint(s)) & 3
	return bits&1 != 0, bits&2 != 0
}

// ---------------------------------------------------------------------------
// codecs (.brp sections G, D, S, V; each gzipped by the writer)

const (
	SecFacts      byte = 'G' // game facts, a JSON array
	SecDamage     byte = 'D' // damage windows
	SecLives      byte = 'S' // per-unit lifetime totals
	SecVisibility byte = 'V' // per-side visibility changes
)

func q10(f float32) uint64 {
	if f <= 0 || math.IsNaN(float64(f)) {
		return 0
	}
	return uint64(math.Round(float64(f) * 10))
}

// idPlus encodes an id where -1 means unknown as an unsigned value.
func idPlus(v int32) uint64 {
	if v < 0 {
		return 0
	}
	return uint64(v) + 1
}

func encodeFacts(facts []Fact) []byte {
	b, _ := json.Marshal(facts)
	return b
}

func decodeFacts(b []byte) ([]Fact, error) {
	var raws []json.RawMessage
	if err := json.Unmarshal(b, &raws); err != nil {
		return nil, err
	}
	facts := make([]Fact, 0, len(raws))
	for _, r := range raws {
		f, err := ParseFact(r)
		if err != nil {
			return nil, err
		}
		facts = append(facts, f)
	}
	return facts, nil
}

// encodeDamage: count, then per window the frame (delta) and row count, then
// the rows column by column — ids as id+1 (0 = unknown), damage in 0.1 hp.
func encodeDamage(ws []DamageWindow) []byte {
	var buf bytes.Buffer
	vw := &varintWriter{w: &buf}
	vw.uv(uint64(len(ws)))
	prev := int64(0)
	for _, w := range ws {
		vw.sv(int64(w.Frame) - prev)
		prev = int64(w.Frame)
		vw.uv(uint64(len(w.Rows)))
		cols := []func(r DamageRow) uint64{
			func(r DamageRow) uint64 { return idPlus(r.AttackerTeam) },
			func(r DamageRow) uint64 { return idPlus(r.AttackerDef) },
			func(r DamageRow) uint64 { return weaponPlus(r.WeaponDef) },
			func(r DamageRow) uint64 { return idPlus(r.VictimTeam) },
			func(r DamageRow) uint64 { return idPlus(r.VictimDef) },
			func(r DamageRow) uint64 { return q10(r.Damage) },
			func(r DamageRow) uint64 { return q10(r.Paralyze) },
			func(r DamageRow) uint64 { return uint64(max(r.Hits, 0)) },
		}
		for _, col := range cols {
			for _, r := range w.Rows {
				vw.uv(col(r))
			}
		}
	}
	return buf.Bytes()
}

func decodeDamage(b []byte) ([]DamageWindow, error) {
	vr := &varintReader{b: b}
	n, err := vr.uv()
	if err != nil {
		return nil, err
	}
	ws := make([]DamageWindow, 0, n)
	prev := int64(0)
	for i := uint64(0); i < n; i++ {
		d, err := vr.sv()
		if err != nil {
			return nil, err
		}
		prev += d
		nr, err := vr.uv()
		if err != nil {
			return nil, err
		}
		if nr > uint64(len(b)) {
			return nil, fmt.Errorf("snapshot: damage window row count %d exceeds section", nr)
		}
		rows := make([]DamageRow, nr)
		set := []func(r *DamageRow, v uint64){
			func(r *DamageRow, v uint64) { r.AttackerTeam = int32(v) - 1 },
			func(r *DamageRow, v uint64) { r.AttackerDef = int32(v) - 1 },
			func(r *DamageRow, v uint64) { r.WeaponDef = weaponFromPlus(v) },
			func(r *DamageRow, v uint64) { r.VictimTeam = int32(v) - 1 },
			func(r *DamageRow, v uint64) { r.VictimDef = int32(v) - 1 },
			func(r *DamageRow, v uint64) { r.Damage = float32(v) / 10 },
			func(r *DamageRow, v uint64) { r.Paralyze = float32(v) / 10 },
			func(r *DamageRow, v uint64) { r.Hits = int32(v) },
		}
		for _, s := range set {
			for j := range rows {
				v, err := vr.uv()
				if err != nil {
					return nil, err
				}
				s(&rows[j], v)
			}
		}
		ws = append(ws, DamageWindow{Frame: int32(prev), Rows: rows})
	}
	return ws, nil
}

// encodeLives: count, then one row per life (they are few — one per unit
// ever built): id and born delta-coded against the previous life, died as
// the lifetime + 1 (0 = alive at the end).
func encodeLives(ls []UnitLife) []byte {
	var buf bytes.Buffer
	vw := &varintWriter{w: &buf}
	vw.uv(uint64(len(ls)))
	prevID, prevBorn := int64(0), int64(0)
	for _, l := range ls {
		vw.sv(int64(l.UnitID) - prevID)
		prevID = int64(l.UnitID)
		vw.uv(idPlus(l.DefID))
		vw.uv(idPlus(l.Team))
		vw.sv(int64(l.Born) - prevBorn)
		prevBorn = int64(l.Born)
		if l.Died < 0 {
			vw.uv(0)
		} else {
			vw.uv(uint64(max(int64(l.Died)-int64(l.Born), 0)) + 1)
		}
		vw.uv(q10(l.Dealt))
		vw.uv(q10(l.Taken))
		vw.uv(uint64(max(l.Kills, 0)))
		vw.uv(uint64(max(l.MinHealthPct, 0)))
		vw.uv(uint64(math.Round(math.Max(float64(l.XP), 0) * 1000)))
	}
	return buf.Bytes()
}

func decodeLives(b []byte) ([]UnitLife, error) {
	vr := &varintReader{b: b}
	n, err := vr.uv()
	if err != nil {
		return nil, err
	}
	if n > uint64(len(b)) {
		return nil, fmt.Errorf("snapshot: life count %d exceeds section", n)
	}
	ls := make([]UnitLife, n)
	prevID, prevBorn := int64(0), int64(0)
	for i := range ls {
		var v [10]uint64
		var sv [2]int64
		if sv[0], err = vr.sv(); err != nil {
			return nil, err
		}
		for k := 0; k < 2; k++ {
			if v[k], err = vr.uv(); err != nil {
				return nil, err
			}
		}
		if sv[1], err = vr.sv(); err != nil {
			return nil, err
		}
		for k := 2; k < 8; k++ {
			if v[k], err = vr.uv(); err != nil {
				return nil, err
			}
		}
		prevID += sv[0]
		prevBorn += sv[1]
		l := &ls[i]
		l.UnitID, l.DefID, l.Team = int32(prevID), int32(v[0])-1, int32(v[1])-1
		l.Born, l.Died = int32(prevBorn), -1
		if v[2] > 0 {
			l.Died = int32(prevBorn + int64(v[2]) - 1)
		}
		l.Dealt, l.Taken = float32(v[3])/10, float32(v[4])/10
		l.Kills, l.MinHealthPct = int32(v[5]), int32(v[6])
		l.XP = float32(v[7]) / 1000
	}
	return ls, nil
}

// encodeVisibility: count, then per record the frame (delta), flags (bit 0 =
// full restatement), the side list, and the unit ids (delta-coded) and masks.
func encodeVisibility(vs []Visibility) []byte {
	var buf bytes.Buffer
	vw := &varintWriter{w: &buf}
	vw.uv(uint64(len(vs)))
	prev := int64(0)
	for _, v := range vs {
		vw.sv(int64(v.Frame) - prev)
		prev = int64(v.Frame)
		flags := uint64(0)
		if v.Full {
			flags |= 1
		}
		vw.uv(flags)
		vw.uv(uint64(len(v.Allies)))
		for _, a := range v.Allies {
			vw.uv(idPlus(a))
		}
		vw.uv(uint64(len(v.Units)))
		prevID := int64(0)
		for _, id := range v.Units {
			vw.sv(int64(id) - prevID)
			prevID = int64(id)
		}
		for _, m := range v.Masks {
			vw.uv(uint64(m))
		}
	}
	return buf.Bytes()
}

func decodeVisibility(b []byte) ([]Visibility, error) {
	vr := &varintReader{b: b}
	n, err := vr.uv()
	if err != nil {
		return nil, err
	}
	vs := make([]Visibility, 0, n)
	prev := int64(0)
	for i := uint64(0); i < n; i++ {
		d, err := vr.sv()
		if err != nil {
			return nil, err
		}
		prev += d
		flags, err := vr.uv()
		if err != nil {
			return nil, err
		}
		na, err := vr.uv()
		if err != nil {
			return nil, err
		}
		if na > 64 {
			return nil, fmt.Errorf("snapshot: visibility record with %d sides", na)
		}
		v := Visibility{Frame: int32(prev), Full: flags&1 != 0, Allies: make([]int32, na)}
		for k := range v.Allies {
			a, err := vr.uv()
			if err != nil {
				return nil, err
			}
			v.Allies[k] = int32(a) - 1
		}
		nu, err := vr.uv()
		if err != nil {
			return nil, err
		}
		if nu > uint64(len(b)) {
			return nil, fmt.Errorf("snapshot: visibility unit count %d exceeds section", nu)
		}
		v.Units, v.Masks = make([]int32, nu), make([]uint32, nu)
		prevID := int64(0)
		for k := range v.Units {
			dd, err := vr.sv()
			if err != nil {
				return nil, err
			}
			prevID += dd
			v.Units[k] = int32(prevID)
		}
		for k := range v.Masks {
			m, err := vr.uv()
			if err != nil {
				return nil, err
			}
			v.Masks[k] = uint32(m)
		}
		vs = append(vs, v)
	}
	return vs, nil
}

// ---------------------------------------------------------------------------
// BRPFile accessors. Each section is optional: an absent one (a capture that
// did not record it, every v5 file) yields nil, not an error.

func (f *BRPFile) section(tag byte, what string) ([]byte, bool, error) {
	sec, ok := f.Sections[tag]
	if !ok {
		return nil, false, nil
	}
	b, err := gunzip(sec)
	if err != nil {
		return nil, true, fmt.Errorf("snapshot: %s section: %w", what, err)
	}
	return b, true, nil
}

// Facts decodes the G section.
func (f *BRPFile) Facts() ([]Fact, error) {
	b, ok, err := f.section(SecFacts, "facts")
	if !ok || err != nil {
		return nil, err
	}
	return decodeFacts(b)
}

// Damage decodes the D section.
func (f *BRPFile) Damage() ([]DamageWindow, error) {
	b, ok, err := f.section(SecDamage, "damage")
	if !ok || err != nil {
		return nil, err
	}
	return decodeDamage(b)
}

// Lives decodes the S section.
func (f *BRPFile) Lives() ([]UnitLife, error) {
	b, ok, err := f.section(SecLives, "lives")
	if !ok || err != nil {
		return nil, err
	}
	return decodeLives(b)
}

// Visibility decodes the V section.
func (f *BRPFile) Visibility() ([]Visibility, error) {
	b, ok, err := f.section(SecVisibility, "visibility")
	if !ok || err != nil {
		return nil, err
	}
	return decodeVisibility(b)
}
