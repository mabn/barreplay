package demofile

import (
	"encoding/binary"
	"math"
	"testing"
)

func le16(v int) []byte { return binary.LittleEndian.AppendUint16(nil, uint16(int16(v))) }
func le32(v int) []byte { return binary.LittleEndian.AppendUint32(nil, uint32(int32(v))) }

func cat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func TestSelfDOrders(t *testing.T) {
	o := orders{selection: map[uint8][]int16{}}
	// Player 3 selects two units and orders them to self-destruct.
	o.packet(cat([]byte{netSelect}, le16(0), []byte{3}, le16(101), le16(102)), 10)
	o.packet(cat([]byte{netCommand}, le16(0), []byte{3}, le32(cmdSelfD), le32(0), []byte{0}, le32(0)), 20)
	// A move order is not one.
	o.packet(cat([]byte{netCommand}, le16(0), []byte{3}, le32(10), le32(0), []byte{0}, le32(0)), 21)
	// A widget's direct order to one unit.
	o.packet(cat([]byte{netAICommand}, le16(0), []byte{4, 255, 0}, le16(200), le32(cmdSelfD), le32(0), []byte{0}, le32(0)), 30)
	// A batch: unit 300 and 301, commands differing, selfd second.
	f := math.Float32bits(1)
	o.packet(cat([]byte{netAICommands}, le16(0), []byte{5, 255, 0}, le32(0), []byte{0xFF}, le16(0xFFFF),
		le16(2), le16(300), le16(301),
		le16(2), le32(10), []byte{0}, le16(1), le32(int(f)), le32(cmdSelfD), []byte{0}, le16(0)), 40)
	want := []SelfD{{20, 3, 101}, {20, 3, 102}, {30, 4, 200}, {40, 5, 300}, {40, 5, 301}}
	if len(o.selfd) != len(want) {
		t.Fatalf("selfd = %v, want %v", o.selfd, want)
	}
	for i := range want {
		if o.selfd[i] != want[i] {
			t.Errorf("selfd[%d] = %v, want %v", i, o.selfd[i], want[i])
		}
	}
	// A truncated batch yields nothing rather than garbage.
	if got := aiCommandsSelfD([]byte{netAICommands, 0, 0, 5}); got != nil {
		t.Errorf("truncated = %v", got)
	}
}
