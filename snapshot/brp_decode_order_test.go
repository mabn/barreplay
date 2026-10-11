package snapshot

import (
	"bytes"
	"strings"
	"testing"
)

// writeFrame hand-writes one core frame: frame delta, dead ids, changed ids
// (both as given, sorted or not) and, per changed unit, every core column as
// an absolute value (v for the def, team and x columns, 0 elsewhere).
func writeFrame(vw *varintWriter, fd int64, dead, changed []int32, v func(id int32) int64) {
	vw.sv(fd)
	for _, ids := range [][]int32{dead, changed} {
		vw.uv(uint64(len(ids)))
		last := int64(0)
		for _, id := range ids {
			vw.sv(int64(id) - last)
			last = int64(id)
		}
	}
	for ci := range coreColumns {
		for _, id := range changed {
			if ci < 3 {
				vw.sv(v(id))
			} else {
				vw.sv(0)
			}
		}
	}
}

// The encoder writes both id lists ascending and the decoder walks them as
// sorted lists; a stream that is not in order must still decode as the old
// map-based decoder read it: last change wins, a dead id must be alive.
func TestDecodeFramesUnsortedIDs(t *testing.T) {
	var buf bytes.Buffer
	vw := &varintWriter{w: &buf}
	writeFrame(vw, 30, nil, []int32{9, 2, 5, 2}, func(id int32) int64 { return int64(id) * 10 })
	writeFrame(vw, 30, []int32{9, 2}, []int32{7}, func(id int32) int64 { return 70 })
	frames, err := decodeFrames(newFrameCodec(30), buf.Bytes(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 2 {
		t.Fatalf("%d frames", len(frames))
	}
	var got []int32
	for _, u := range frames[0].Units {
		got = append(got, u.UnitID)
	}
	if want := []int32{2, 5, 9}; len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("frame 0 ids %v", got)
	}
	if u := frames[1].Units; len(u) != 2 || u[0].UnitID != 5 || u[1].UnitID != 7 || u[1].DefID != 70 {
		t.Fatalf("frame 1 %+v", u)
	}

	buf.Reset()
	writeFrame(vw, 30, nil, []int32{1}, func(int32) int64 { return 1 })
	writeFrame(vw, 30, []int32{3}, nil, nil)
	if _, err := decodeFrames(newFrameCodec(30), buf.Bytes(), nil); err == nil || !strings.Contains(err.Error(), "dead unit 3 was not alive") {
		t.Fatalf("dead unit not alive: %v", err)
	}
}
