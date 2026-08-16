package demofile

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"testing"

	"github.com/mabn/barreplay/snapshot"
)

// packet builds one demo stream chunk: the DemoStreamChunkHeader (float32
// modGameTime, uint32 length) followed by the raw network packet.
func packet(b *bytes.Buffer, pkt []byte) {
	binary.Write(b, binary.LittleEndian, float32(0))
	binary.Write(b, binary.LittleEndian, uint32(len(pkt)))
	b.Write(pkt)
}

func chatPkt(from, dest byte, msg string) []byte {
	p := []byte{netChat, byte(4 + len(msg) + 1), from, dest}
	p = append(p, msg...)
	return append(p, 0)
}

func u32(v uint32) []byte {
	var b [4]byte
	binary.LittleEndian.PutUint32(b[:], v)
	return b[:]
}

func pointPkt(player byte, x, z uint32, label string) []byte {
	p := []byte{netMapDraw, 0, player, drawPoint}
	p = append(p, u32(x)...)
	p = append(p, u32(z)...)
	p = append(p, 0) // fromLua
	p = append(p, label...)
	p = append(p, 0)
	p[1] = byte(len(p))
	return p
}

func linePkt(player byte, x1, z1, x2, z2 uint32) []byte {
	p := []byte{netMapDraw, 21, player, drawLine}
	p = append(p, u32(x1)...)
	p = append(p, u32(z1)...)
	p = append(p, u32(x2)...)
	p = append(p, u32(z2)...)
	return append(p, 0) // fromLua
}

func erasePkt(player byte, x, z uint32) []byte {
	p := []byte{netMapDraw, 12, player, drawErase}
	p = append(p, u32(x)...)
	return append(p, u32(z)...)
}

// buildDemo assembles a minimal but structurally real .sdfz around a packet
// stream: the packed header, a startscript, then the stream.
func buildDemo(t *testing.T, stream []byte) []byte {
	t.Helper()
	script := "[GAME]\n{\n\tMapName=Test Map;\n\tGameType=BYAR;\n}\n\x00"

	var raw bytes.Buffer
	rh := rawHeader{Version: 5, HeaderSize: 352, ScriptSize: int32(len(script)), DemoStreamSize: int32(len(stream))}
	copy(rh.Magic[:], magicString)
	copy(rh.VersionString[:], "2025.06.24")
	if err := binary.Write(&raw, binary.LittleEndian, &rh); err != nil {
		t.Fatal(err)
	}
	// Pad out to the declared header size, exactly as the engine's larger
	// on-disk header does.
	for raw.Len() < 352 {
		raw.WriteByte(0)
	}
	raw.WriteString(script)
	raw.Write(stream)

	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(raw.Bytes())
	zw.Close()
	return gz.Bytes()
}

// The demo's packet stream is the authoritative source for chat and drawings:
// every channel, every side, and framed exactly by counting the frame packets
// that sit in the same stream.
func TestScanComms(t *testing.T) {
	var s bytes.Buffer
	// Pre-game: chat before the first frame packet lands on frame 0.
	packet(&s, chatPkt(3, chatToEveryone, "glhf"))
	packet(&s, chatPkt(255, 254, "> not a relay, a server announcement"))
	packet(&s, chatPkt(255, 254, "<LobbyOnly> relayed from the battleroom"))
	packet(&s, chatPkt(1, chatToEveryone, "")) // empty: dropped
	// Two sim frames.
	packet(&s, []byte{netNewframe})
	packet(&s, []byte{netNewframe})
	packet(&s, chatPkt(4, chatToAllies, "push north"))
	packet(&s, pointPkt(4, 1200, 3400, "here"))
	// A keyframe RESETS the counter to the frame it carries.
	packet(&s, append([]byte{netKeyframe}, u32(900)...))
	packet(&s, chatPkt(5, chatToSpectators, "nice game"))
	packet(&s, chatPkt(6, 2, "psst")) // a plain player number = a whisper
	packet(&s, linePkt(4, 1200, 3400, 1260, 3450))
	packet(&s, erasePkt(4, 5000, 5000))
	packet(&s, pointPkt(4, 1<<21, 10, "off the map")) // implausible: dropped
	// An unknown packet type must be skipped by its chunk length, not
	// misparsed — that is what keeps this robust across engine versions.
	packet(&s, []byte{99, 7, 1, 2, 3, 4, 5})
	packet(&s, []byte{netNewframe})
	packet(&s, chatPkt(3, chatToEveryone, "gg"))

	d, err := Parse(bytes.NewReader(buildDemo(t, s.Bytes())))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	want := []snapshot.Comm{
		{Frame: 0, Kind: snapshot.CommChat, PlayerID: 3, Dest: snapshot.DestAll, Text: "glhf"},
		{Frame: 0, Kind: snapshot.CommChat, PlayerID: -1, Name: "LobbyOnly", Dest: snapshot.DestLobby, Text: "relayed from the battleroom"},
		{Frame: 2, Kind: snapshot.CommChat, PlayerID: 4, Dest: snapshot.DestAlly, Text: "push north"},
		{Frame: 2, Kind: snapshot.CommPoint, PlayerID: 4, X: 1200, Z: 3400, Text: "here"},
		{Frame: 900, Kind: snapshot.CommChat, PlayerID: 5, Dest: snapshot.DestSpec, Text: "nice game"},
		{Frame: 900, Kind: snapshot.CommChat, PlayerID: 6, Dest: snapshot.DestPrivate, Text: "psst"},
		{Frame: 900, Kind: snapshot.CommLine, PlayerID: 4, X: 1200, Z: 3400, X2: 1260, Z2: 3450},
		{Frame: 900, Kind: snapshot.CommErase, PlayerID: 4, X: 5000, Z: 5000},
		{Frame: 901, Kind: snapshot.CommChat, PlayerID: 3, Dest: snapshot.DestAll, Text: "gg"},
	}
	if len(d.Comms) != len(want) {
		t.Fatalf("comms = %+v", d.Comms)
	}
	for i := range want {
		if d.Comms[i] != want[i] {
			t.Errorf("comm[%d] = %+v, want %+v", i, d.Comms[i], want[i])
		}
	}
}

// A demo cut short by a crash is common enough to be a supported input: the
// scan keeps everything it recovered before the break rather than failing the
// whole parse, and the header of such a file may not declare a stream size at
// all.
func TestScanCommsTruncated(t *testing.T) {
	var s bytes.Buffer
	packet(&s, chatPkt(3, chatToEveryone, "glhf"))
	packet(&s, []byte{netNewframe})
	packet(&s, chatPkt(3, chatToEveryone, "still here"))
	full := s.Bytes()

	for _, tc := range []struct {
		name string
		cut  int
	}{
		{"mid-packet", len(full) - 4},
		{"mid-chunk-header", len(full) - len(chatPkt(3, chatToEveryone, "still here")) - 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			demo := buildDemo(t, full[:tc.cut])
			d, err := Parse(bytes.NewReader(demo))
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if len(d.Comms) != 1 || d.Comms[0].Text != "glhf" {
				t.Errorf("comms = %+v, want just the recovered first message", d.Comms)
			}
		})
	}

	// No declared stream size (a header never rewritten): scan to EOF instead.
	demo := buildDemo(t, full)
	raw, err := gzipBytesFor(t, demo, func(b []byte) { binary.LittleEndian.PutUint32(b[16+4+4+256+16+8+4:], 0) })
	if err != nil {
		t.Fatal(err)
	}
	d, err := Parse(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(d.Comms) != 2 {
		t.Errorf("comms without a declared stream size = %+v, want 2", d.Comms)
	}
}

// gzipBytesFor re-gzips a demo after mutating its decompressed bytes.
func gzipBytesFor(t *testing.T, demo []byte, edit func([]byte)) ([]byte, error) {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(demo))
	if err != nil {
		return nil, err
	}
	var plain bytes.Buffer
	if _, err := plain.ReadFrom(zr); err != nil {
		return nil, err
	}
	b := plain.Bytes()
	edit(b)
	var out bytes.Buffer
	zw := gzip.NewWriter(&out)
	zw.Write(b)
	zw.Close()
	return out.Bytes(), nil
}
