package snapshot

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The v6 analysis sections round-trip through the writer and ParseBRP at
// their documented precision: damage and hp totals to 0.1, xp to 0.001.
func TestBRPAnalysisRoundTrip(t *testing.T) {
	meta, frames, events := testCapture()
	events[2].Cause = &EventCause{UnitID: 300, DefID: 2, Team: 1, WeaponDef: 7}
	events = append(events, Event{Frame: 80, Kind: EventGiven, UnitID: 200, DefID: 2, Team: 0,
		Cause: &EventCause{UnitID: -1, DefID: -1, Team: 1, WeaponDef: -1}})

	endFact, err := ParseFact([]byte(`{"k":"end","f":90,"winners":[1]}`))
	if err != nil {
		t.Fatal(err)
	}
	wdefs, err := ParseFact([]byte(`{"k":"wdefs","defs":[{"id":7,"name":"corllt_laser","range":430}]}`))
	if err != nil {
		t.Fatal(err)
	}
	facts := []Fact{wdefs, endFact}
	damage := []DamageWindow{
		{Frame: 60, Rows: []DamageRow{
			{AttackerTeam: 1, AttackerDef: 2, WeaponDef: 7, VictimTeam: 0, VictimDef: 1, Damage: 500.04, Hits: 5},
			{AttackerTeam: -1, AttackerDef: -1, WeaponDef: -1, VictimTeam: 1, VictimDef: 2, Damage: 12.5, Paralyze: 3.3, Hits: 1, Overkill: 2.1},
		}},
		{Frame: 90, Rows: []DamageRow{
			{AttackerTeam: 1, AttackerDef: 2, WeaponDef: 7, VictimTeam: 0, VictimDef: 1, Damage: 2500, Hits: 25, Overkill: 120},
		}},
	}
	lives := []UnitLife{
		{UnitID: 100, DefID: 1, Team: 0, Born: 0, Died: 75, Taken: 3000, MinHealthPct: 0},
		{UnitID: 200, DefID: 2, Team: 1, Born: 15, Died: -1, Dealt: 12.3, Taken: 400, MinHealthPct: 50, XP: 0.125},
		{UnitID: 300, DefID: 2, Team: 1, Born: 55, Died: -1, Dealt: 3000, Kills: 1, MinHealthPct: 12, XP: 1.5},
	}
	vis := []Visibility{
		{Frame: 30, Allies: []int32{0, 1}, Units: []int32{100, 200}, Masks: []uint32{0b0001, 0b1100}},
		{Frame: 60, Allies: []int32{0, 1}, Units: []int32{300}, Masks: []uint32{0b0110}},
		{Frame: 90, Full: true, Allies: []int32{0, 1}, Units: []int32{200, 300}, Masks: []uint32{0b0101, 0b0100}},
	}

	dir := t.TempDir()
	w, err := NewBRPWriter(dir, meta.GameID)
	if err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(w.WriteMeta(meta))
	for _, fr := range frames {
		must(w.WriteFrame(fr))
	}
	for _, e := range events {
		must(w.WriteEvent(e))
	}
	for _, f := range facts {
		must(w.WriteFact(f))
	}
	for _, d := range damage {
		must(w.WriteDamage(d))
	}
	for _, l := range lives {
		must(w.WriteLife(l))
	}
	for _, v := range vis {
		must(w.WriteVisibility(v))
	}
	must(w.Close())

	f, err := os.Open(filepath.Join(dir, meta.GameID+".brp"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	bf, err := ParseBRP(f)
	if err != nil {
		t.Fatal(err)
	}
	if bf.Version != BRPVersion {
		t.Errorf("Version = %d, want %d", bf.Version, BRPVersion)
	}

	evRaw, err := gunzip(bf.Sections[SecEvents])
	if err != nil {
		t.Fatal(err)
	}
	gotEvents, err := decodeEvents(evRaw)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotEvents, events) {
		t.Errorf("events:\n got %+v\nwant %+v", gotEvents, events)
	}

	gotFacts, err := bf.Facts()
	must(err)
	if len(gotFacts) != 2 || gotFacts[1].Kind != FactEnd || gotFacts[1].Frame != 90 {
		t.Fatalf("facts = %+v", gotFacts)
	}
	var end FactEndData
	must(gotFacts[1].Decode(&end))
	if !reflect.DeepEqual(end.Winners, []int32{1}) {
		t.Errorf("end winners = %v", end.Winners)
	}

	gotDamage, err := bf.Damage()
	must(err)
	q := func(f float32) float32 { return float32(roundq(f*10)) / 10 }
	for i := range damage {
		for j := range damage[i].Rows {
			r := &damage[i].Rows[j]
			r.Damage, r.Paralyze, r.Overkill = q(r.Damage), q(r.Paralyze), q(r.Overkill)
		}
	}
	if !reflect.DeepEqual(gotDamage, damage) {
		t.Errorf("damage:\n got %+v\nwant %+v", gotDamage, damage)
	}

	gotLives, err := bf.Lives()
	must(err)
	for i := range lives {
		lives[i].Dealt, lives[i].Taken = q(lives[i].Dealt), q(lives[i].Taken)
	}
	if !reflect.DeepEqual(gotLives, lives) {
		t.Errorf("lives:\n got %+v\nwant %+v", gotLives, lives)
	}

	gotVis, err := bf.Visibility()
	must(err)
	if !reflect.DeepEqual(gotVis, vis) {
		t.Errorf("visibility:\n got %+v\nwant %+v", gotVis, vis)
	}
	if los, radar := gotVis[0].Sees(1, 1); !los || !radar {
		t.Errorf("Sees(unit 200, side 1) = %v,%v; want both", los, radar)
	}
}

// A capture with no analysis writes none of the v6 sections, and the
// accessors answer "none" rather than failing.
func TestBRPNoAnalysisSections(t *testing.T) {
	meta, frames, events := testCapture()
	f, err := os.Open(writeBRP(t, t.TempDir(), meta, frames, events))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	bf, err := ParseBRP(f)
	if err != nil {
		t.Fatal(err)
	}
	for _, tag := range []byte{SecFacts, SecDamage, SecLives, SecVisibility} {
		if _, ok := bf.Sections[tag]; ok {
			t.Errorf("analysis-less capture wrote a %q section", tag)
		}
	}
	if v, err := bf.Visibility(); err != nil || v != nil {
		t.Errorf("Visibility() = %v, %v", v, err)
	}
}

// A v5 events section ends after the team column; the v6 decoder must read
// it unchanged, with no causes.
func TestDecodeV5Events(t *testing.T) {
	_, _, events := testCapture()
	v6 := encodeEvents(events)
	// With no causes every cause value is -1, one zigzag byte each.
	v5 := v6[:len(v6)-4*len(events)]
	got, err := decodeEvents(v5)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, events) {
		t.Errorf("v5 events:\n got %+v\nwant %+v", got, events)
	}
}

// A v5 file still parses; anything outside 5..6 does not.
func TestBRPAcceptsV5(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteContainer(&buf, BRPMagic, 5, []Section{{Tag: SecMeta, Payload: gzipCompress([]byte(`{"meta":{"gameId":"old"}}`))}}); err != nil {
		t.Fatal(err)
	}
	bf, err := ParseBRP(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("v5: %v", err)
	}
	if bf.Version != 5 {
		t.Errorf("Version = %d", bf.Version)
	}
	buf.Reset()
	if err := WriteContainer(&buf, BRPMagic, 7, []Section{{Tag: SecMeta, Payload: gzipCompress([]byte(`{}`))}}); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseBRP(bytes.NewReader(buf.Bytes())); err == nil {
		t.Error("want error for version 7")
	}
}
