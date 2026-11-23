package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// writeCapture packs a tiny capture: one frame, the given hits and blasts.
func writeCapture(t *testing.T, name string, hits []snapshot.Hit, blasts []snapshot.Blast, hp float32) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	w, err := snapshot.NewBRPWriter(dir, "g")
	if err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(w.WriteMeta(snapshot.Meta{GameID: "g", SampleEvery: 30}))
	must(w.WriteFrame(snapshot.Frame{Frame: 30, Units: []snapshot.UnitState{{UnitID: 1, DefID: 2, Team: 0, Health: hp, MaxHealth: 100}}}))
	for _, h := range hits {
		must(w.WriteHit(h))
	}
	for _, b := range blasts {
		must(w.WriteBlast(b))
	}
	must(w.Close())
	return filepath.Join(dir, "g.brp")
}

func TestGateCompare(t *testing.T) {
	anon := snapshot.Hit{Frame: 40, Victim: 1, VictimDef: 2, Attacker: -1, AttackerDef: -1, AttackerTeam: -1, WeaponDef: -1, ProjOwner: -1, ProjTeam: -1, Damage: 5, HPAfter: 95}
	named := anon
	named.Attacker, named.AttackerDef, named.AttackerTeam, named.WeaponDef, named.Projectile = 7, 8, 1, 9, true
	death := snapshot.Blast{Frame: 50, Weapon: 3, X: 10, Z: 20, Unit: 1, Kind: 1}
	shell := snapshot.Blast{Frame: 45, Weapon: 9, X: 11, Z: 21, Unit: 7, Team: 1, Kind: 1}

	stock := writeCapture(t, "stock", []snapshot.Hit{anon}, []snapshot.Blast{death}, 95)
	for _, c := range []struct {
		name   string
		other  string
		ok     bool
		reason string
	}{
		{"identical", writeCapture(t, "same", []snapshot.Hit{anon}, []snapshot.Blast{death}, 95), true, "identical"},
		{"event log", writeCapture(t, "log", []snapshot.Hit{named}, []snapshot.Blast{death, shell}, 95), true, "equivalent"},
		{"frames differ", writeCapture(t, "frames", []snapshot.Hit{named}, []snapshot.Blast{death, shell}, 94), false, "section"},
		{"stock blast missing", writeCapture(t, "noblast", []snapshot.Hit{named}, []snapshot.Blast{shell}, 95), false, "stock blast"},
		{"damage differs", writeCapture(t, "dmg", []snapshot.Hit{func() snapshot.Hit { h := named; h.Damage = 6; return h }()}, []snapshot.Blast{death}, 95), false, "beyond its attacker"},
	} {
		ok, how, err := gateCompare(stock, c.other)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if ok != c.ok || !strings.Contains(how, c.reason) {
			t.Errorf("%s: ok=%v %q, want ok=%v containing %q", c.name, ok, how, c.ok, c.reason)
		}
	}

	// A stock capture that names attackers had the real handler: any hit
	// difference is then a real one.
	stockNamed := writeCapture(t, "stocknamed", []snapshot.Hit{named}, nil, 95)
	other := named
	other.Attacker = 6
	if ok, how, _ := gateCompare(stockNamed, writeCapture(t, "named2", []snapshot.Hit{other}, nil, 95)); ok || !strings.Contains(how, "not a sandboxed widget") {
		t.Errorf("named stock: ok=%v %q", ok, how)
	}
}
