package demofile

// Chat and map drawings, recovered from the demo's packet stream.
//
// The stream is the game's deterministic input log, and specifically it is what
// the SERVER broadcast: CGameServer::Broadcast hands every outgoing packet to
// the demo recorder (rts/Net/GameServer.cpp). Two consequences make it the best
// possible source for player comms:
//
//   - It is COMPLETE. Chat is broadcast unfiltered — GotChatMessage broadcasts
//     every message and each CLIENT decides what to display from the
//     destination byte — so the demo holds every side's ally chat, the
//     spectator channel and whispers, each tagged with the destination its
//     sender chose rather than one viewer's rendering of it. Map draws are
//     broadcast the same way.
//   - It is EXACTLY FRAMED. The server emits one KEYFRAME (carrying the frame
//     number) or NEWFRAME per simulated frame, so counting them as the stream
//     is walked stamps every comm with the frame it actually landed on.
//
// The widgets' own capture (assets/lua/*.lua) can do neither: a client is only
// handed the channels and marks it is allowed to see, and chat reaches Lua via
// AddConsoleLine, which the engine flushes from its UNSYNCED update — a path
// the re-sim deliberately starves, so a stamp there can lag by seconds. The
// widget path therefore survives only as the fallback for a capture with no
// demo behind it (pack -no-demo, or a game the BAR API does not know).
//
// Packet layouts below are mirrored from rts/Net/Protocol/NetMessageTypes.h and
// the decoders in Game/ChatMessage.cpp and Game/InMapDraw.cpp.

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/mabn/barreplay/snapshot"
)

// Network message ids we care about. Every other packet is skipped by its
// chunk length, so no other layout has to be known here — which is what keeps
// this robust across engine versions.
const (
	netKeyframe = 1  // int32 frameNum
	netNewframe = 2  // (no payload)
	netChat     = 7  // uint8 size, from, dest; NUL-terminated message
	netMapDraw  = 32 // uint8 size, playerNum, drawType; then per drawType
)

// Chat destination byte (Game/ChatMessage.h). Anything else is a player
// number: a whisper addressed to that player.
const (
	chatToAllies     = 252
	chatToSpectators = 253
	chatToEveryone   = 254
)

// serverPlayer is the sender id the server/autohost uses (GameServer.h).
const serverPlayer = 255

// NETMSG_MAPDRAW sub-types (MapDrawAction in NetMessageTypes.h).
const (
	drawPoint = 0
	drawErase = 1
	drawLine  = 2
)

// maxDemoPacket bounds a chunk's declared length. Real packets are network
// sized; anything larger means the stream is corrupt or we lost sync with the
// chunk boundaries, and the scan stops rather than allocating on a bad number.
const maxDemoPacket = 1 << 20

// maxDrawCoord rejects an implausible map coordinate. Draw positions travel as
// uint32 (CInMapDraw casts the float straight across), so a position the
// engine would clamp arrives here as a huge number instead of a negative one;
// the biggest BAR maps are well under 100k elmos.
const maxDrawCoord = 1 << 20

// lobbyRelay matches the autohost's relay of battleroom chat: a server message
// whose text is itself a "<Name> said this" line. The engine renders it as
// "> <Name> said this"; anything else from the server is an announcement
// (vote results, kick notices) rather than something a person wrote, and is
// not recorded.
var lobbyRelay = regexp.MustCompile(`^<([^>]{1,64})> (.*)$`)

// machineChat marks a message BAR's own UI sent on the chat channel rather than
// a person typing: the player-list's "I need energy" / "gave 2186 energy to
// c0y" buttons publish an i18n KEY for the receiving client to localize, and it
// travels as an ordinary chat packet from that player.
//
// They must be dropped, and by volume this is not a detail — one real 8v8 sent
// 133 of them against 91 typed messages, so keeping them would leave a
// transcript that is 58% raw key paths like
// "> :ui.playersList.chat.giveEnergy:amount=2186:name=c0y". Dropping them also
// makes the demo agree exactly with what the widgets record: their console
// parser already rejects these, since after the "> " the line begins with ':'
// rather than a speaker.
//
// Deliberately NOT dropped: "!forcestart", "!cv resign" and friends. Those are
// autohost commands, but a person typed them, and reading them is often how a
// game's ending makes sense.
const machineChatPrefix = "> :"

// scanComms walks the packet stream and returns everything players wrote and
// drew, in stream order (non-decreasing frame).
//
// It is BEST-EFFORT by design: a demo can be cut short by a crash, and the
// header of such a file may not even declare its stream size. A truncated or
// unreadable tail ends the scan and keeps everything recovered before it,
// because a partial transcript beats none.
func scanComms(r io.Reader) []snapshot.Comm {
	var comms []snapshot.Comm
	var frame int32
	var hdr [8]byte
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return comms // EOF, or a truncated chunk header: done
		}
		// DemoStreamChunkHeader: float32 modGameTime, uint32 length. The time is
		// wall-ish and unused — the frame counter below is exact.
		n := binary.LittleEndian.Uint32(hdr[4:])
		if n == 0 {
			continue
		}
		if n > maxDemoPacket {
			fmt.Fprintf(os.Stderr, "demofile: implausible demo chunk length %d after %d comms; stopping scan\n", n, len(comms))
			return comms
		}
		pkt := make([]byte, n)
		if _, err := io.ReadFull(r, pkt); err != nil {
			return comms
		}
		switch pkt[0] {
		case netKeyframe:
			if len(pkt) >= 5 {
				frame = int32(binary.LittleEndian.Uint32(pkt[1:5]))
			}
		case netNewframe:
			frame++
		case netChat:
			if c, ok := chatComm(pkt, frame); ok {
				comms = append(comms, c)
			}
		case netMapDraw:
			if c, ok := drawComm(pkt, frame); ok {
				comms = append(comms, c)
			}
		}
	}
}

// chatComm decodes NETMSG_CHAT: id, size, from, dest, then the message as a
// NUL-terminated string (ChatMessage's own unpacker starts at offset 2).
func chatComm(pkt []byte, frame int32) (snapshot.Comm, bool) {
	if len(pkt) < 5 {
		return snapshot.Comm{}, false
	}
	from, dest := pkt[2], pkt[3]
	text := strings.TrimRight(cstr(pkt[4:]), " ")
	if text == "" || strings.HasPrefix(text, machineChatPrefix) {
		return snapshot.Comm{}, false
	}
	c := snapshot.Comm{Frame: frame, Kind: snapshot.CommChat, PlayerID: int32(from)}
	switch dest {
	case chatToAllies:
		c.Dest = snapshot.DestAlly
	case chatToSpectators:
		c.Dest = snapshot.DestSpec
	case chatToEveryone:
		c.Dest = snapshot.DestAll
	default:
		// Addressed to one player. The recipient is knowable here (it is the
		// destination byte) but is deliberately not recorded: the viewer shows
		// who SPOKE, and a whisper's target is not part of that.
		c.Dest = snapshot.DestPrivate
	}
	if from == serverPlayer {
		// The server is not a player, so it has no roster entry to name it.
		m := lobbyRelay.FindStringSubmatch(text)
		if m == nil {
			return snapshot.Comm{}, false // a server announcement, not a person
		}
		c.PlayerID, c.Name, c.Dest, text = -1, m[1], snapshot.DestLobby, m[2]
		if text == "" {
			return snapshot.Comm{}, false
		}
	}
	c.Text = text
	return c, true
}

// drawComm decodes NETMSG_MAPDRAW: id, size, playerNum, drawType, then per
// type (InMapDraw.cpp GotNetMsg, whose unpacker also starts at offset 2).
func drawComm(pkt []byte, frame int32) (snapshot.Comm, bool) {
	if len(pkt) < 4 {
		return snapshot.Comm{}, false
	}
	c := snapshot.Comm{Frame: frame, PlayerID: int32(pkt[2])}
	coord := func(off int) (float32, bool) {
		v := binary.LittleEndian.Uint32(pkt[off : off+4])
		if v > maxDrawCoord {
			return 0, false
		}
		return float32(v), true
	}
	var ok1, ok2, ok3, ok4 bool
	switch pkt[3] {
	case drawPoint: // uint32 x, z; uint8 fromLua; NUL-terminated label
		if len(pkt) < 13 {
			return snapshot.Comm{}, false
		}
		c.Kind = snapshot.CommPoint
		c.X, ok1 = coord(4)
		c.Z, ok2 = coord(8)
		c.Text = strings.TrimSpace(cstr(pkt[13:]))
		ok3, ok4 = true, true
	case drawLine: // uint32 x1, z1, x2, z2; uint8 fromLua
		if len(pkt) < 21 {
			return snapshot.Comm{}, false
		}
		c.Kind = snapshot.CommLine
		c.X, ok1 = coord(4)
		c.Z, ok2 = coord(8)
		c.X2, ok3 = coord(12)
		c.Z2, ok4 = coord(16)
	case drawErase: // uint32 x, z
		if len(pkt) < 12 {
			return snapshot.Comm{}, false
		}
		c.Kind = snapshot.CommErase
		c.X, ok1 = coord(4)
		c.Z, ok2 = coord(8)
		ok3, ok4 = true, true
	default:
		return snapshot.Comm{}, false
	}
	if !(ok1 && ok2 && ok3 && ok4) {
		return snapshot.Comm{}, false
	}
	return c, true
}
