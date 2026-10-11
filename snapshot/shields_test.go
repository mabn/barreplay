package snapshot

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The Q section round-trips through the writer and ParseBRP exactly, sorted
// by frame whatever order the readings were written in.
func TestBRPShieldsRoundTrip(t *testing.T) {
	meta, frames, _ := testCapture()
	shields := []Shield{
		{Frame: 900, Unit: 501, Power: 6175, Enabled: true},
		{Frame: 60, Unit: 501, Power: 0, Enabled: true},
		{Frame: 900, Unit: 0, Power: 3020, Enabled: false},
		{Frame: 1200, Unit: -1, Power: 66500, Enabled: true},
	}
	dir := t.TempDir()
	w, err := NewBRPWriter(dir, meta.GameID)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.WriteMeta(meta); err != nil {
		t.Fatal(err)
	}
	for _, fr := range frames {
		if err := w.WriteFrame(fr); err != nil {
			t.Fatal(err)
		}
	}
	for _, s := range shields {
		if err := w.WriteShield(s); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(filepath.Join(dir, meta.GameID+".brp"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	bf, err := ParseBRP(f)
	if err != nil {
		t.Fatal(err)
	}
	got, err := bf.Shields()
	if err != nil {
		t.Fatal(err)
	}
	want := []Shield{shields[1], shields[0], shields[2], shields[3]}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("shields:\n got %+v\nwant %+v", got, want)
	}
}
