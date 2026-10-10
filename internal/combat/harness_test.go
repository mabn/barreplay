package combat

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/mabn/barreplay/internal/capture"
	"github.com/mabn/barreplay/snapshot"
)

// TestDeriveHarness runs the derivation over the stubbed-engine harness's
// re-simulation capture (internal/capture/testdata, see tools/brep-harness)
// after a round trip through the .brp, so the widget's raw record, the
// codec and the derivation are exercised together.
func TestDeriveHarness(t *testing.T) {
	f, err := os.Open("../capture/testdata/harness_resim.brepstream")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	dir := t.TempDir()
	w, err := snapshot.NewBRPWriter(dir, "harness")
	if err != nil {
		t.Fatal(err)
	}
	if err := capture.ConsumeBrep(f, snapshot.Meta{GameID: "harness"}, w); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "harness.brp"))
	if err != nil {
		t.Fatal(err)
	}
	bf, err := snapshot.ParseBRP(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	meta, _, events, err := snapshot.ReadBRP(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	facts, err := bf.Facts()
	if err != nil {
		t.Fatal(err)
	}
	hits, err := bf.Hits()
	if err != nil {
		t.Fatal(err)
	}
	ends, err := bf.UnitEnds()
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 || len(ends) == 0 {
		t.Fatalf("harness .brp has %d hits, %d unit ends", len(hits), len(ends))
	}
	r := Derive(meta, events, facts, hits, ends, DefaultOptions())

	if r.Stats.Hits != len(hits) || r.Stats.FromChain == 0 || r.Stats.FromProjectile == 0 || r.Stats.EngineCause == 0 {
		t.Errorf("stats %+v over %d hits", r.Stats, len(hits))
	}
	// Unit 159's blast is the harness's advanced fusion: 3500 damage on a
	// teammate, credited to whoever killed 159.
	var big *snapshot.FactBlastData
	for i := range r.Blasts {
		if r.Blasts[i].Unit == 159 {
			big = &r.Blasts[i]
		}
	}
	if big == nil || big.ByTeam == nil || big.Damage < 3000 {
		t.Errorf("no credited big blast for unit 159: %+v", r.Blasts)
	}
	// Every death has an end, and every life is closed.
	deaths := 0
	for _, e := range events {
		if e.Kind == snapshot.EventDestroyed {
			deaths++
			if _, ok := r.Kills[KillKey{e.Frame, e.UnitID}]; !ok {
				t.Errorf("death %+v has no derived kill", e)
			}
		}
	}
	died := 0
	for _, l := range r.Lives {
		if l.Died >= 0 {
			died++
		}
	}
	if died != deaths {
		t.Errorf("%d lives ended for %d deaths", died, deaths)
	}
	// Overkill never counts: the damage summed equals the health removed.
	var sum float64
	for _, w := range r.Windows {
		for _, row := range w.Rows {
			sum += float64(row.Damage)
		}
	}
	var removed float64
	for _, h := range hits {
		removed += float64(h.Removed())
	}
	if d := sum - removed; d > 0.5 || d < -0.5 {
		t.Errorf("windows sum %v, hits removed %v", sum, removed)
	}
}
