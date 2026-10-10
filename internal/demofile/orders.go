package demofile

// Self-destruct orders, recovered from the demo's packet stream.
//
// A demo IS the game's input log, so every order a player gave is in it —
// but as the player gave it: a command addressed to "my current selection",
// with the selection sent separately. Only self-destruct is decoded, because
// it is the one order the viewer shows (a countdown over the unit) and the
// one the re-simulation cannot see from outside: a self-destructed unit
// simply dies, with no killer. Layouts mirror rts/Net/Protocol/
// BaseNetProtocol.cpp (Send*) and the readers in rts/Net/NetCommands.cpp;
// verified on a 2026.07.04 demo, whose commander self-destruct at frame 2416
// is followed by that commander's death 164 frames later (the engine's
// countdown plus a slow-update tick).

import (
	"encoding/binary"

	"github.com/mabn/barreplay/snapshot"
)

const (
	netCommand          = 11 // uint16 size, uint8 player; int32 cmd, timeout; uint8 opts; uint32 nparams; float params
	netSelect           = 12 // uint16 size, uint8 player; int16 unitIDs...
	netAICommand        = 14 // uint16 size, uint8 player, aiInst, aiTeam; int16 unit; int32 cmd, timeout; uint8 opts; ...
	netAICommands       = 15 // see aiCommandsUnits
	netAICommandTracked = 76 // as netAICommand, plus an int32 aiCommandId
)

// cmdSelfD is CMD_SELFD (rts/Sim/Units/CommandAI/Command.h).
const cmdSelfD = 65

// maxSelection bounds a decoded selection, like maxDemoPacket bounds a chunk.
const maxSelection = 1 << 15

// SelfD is one unit ordered to self-destruct (or, ordered again while
// counting down, to stop: the engine toggles).
type SelfD struct {
	Frame  int32
	Player int32
	Unit   int32
}

// orders tracks what the scan needs to resolve a command to its units.
type orders struct {
	selection map[uint8][]int16
	selfd     []SelfD
}

func (o *orders) packet(pkt []byte, frame int32) {
	switch pkt[0] {
	case netSelect:
		if len(pkt) < 4 {
			return
		}
		n := (len(pkt) - 4) / 2
		if n > maxSelection {
			return
		}
		sel := make([]int16, n)
		for i := range sel {
			sel[i] = int16(binary.LittleEndian.Uint16(pkt[4+2*i:]))
		}
		o.selection[pkt[3]] = sel
	case netCommand:
		if len(pkt) < 8 || int32(binary.LittleEndian.Uint32(pkt[4:8])) != cmdSelfD {
			return
		}
		for _, u := range o.selection[pkt[3]] {
			o.selfd = append(o.selfd, SelfD{Frame: frame, Player: int32(pkt[3]), Unit: int32(u)})
		}
	case netAICommand, netAICommandTracked:
		if len(pkt) < 12 || int32(binary.LittleEndian.Uint32(pkt[8:12])) != cmdSelfD {
			return
		}
		o.selfd = append(o.selfd, SelfD{Frame: frame, Player: int32(pkt[3]), Unit: int32(int16(binary.LittleEndian.Uint16(pkt[6:8])))})
	case netAICommands:
		for _, u := range aiCommandsSelfD(pkt) {
			o.selfd = append(o.selfd, SelfD{Frame: frame, Player: int32(pkt[3]), Unit: int32(u)})
		}
	}
}

// aiCommandsSelfD returns the units a NETMSG_AICOMMANDS packet orders to
// self-destruct: uint16 size, uint8 player, aiInst, pairwise; uint32
// sameCmdID; uint8 sameCmdOpt; uint16 sameCmdParamSize; int16 unitCount +
// units; int16 commandCount + commands, each {int32 id unless sameCmdID != 0;
// uint8 opt unless sameCmdOpt != 0xFF; uint16 nparams unless sameCmdParamSize
// != 0xFFFF; float params}. Pairwise, command i goes to unit i; otherwise
// every command goes to every unit. A packet that does not parse yields none.
func aiCommandsSelfD(pkt []byte) []int16 {
	p := 3
	need := func(n int) bool { return p+n <= len(pkt) }
	if !need(1 + 1 + 1 + 4 + 1 + 2 + 2) {
		return nil
	}
	pairwise := pkt[5] != 0
	same := int32(binary.LittleEndian.Uint32(pkt[6:10]))
	sameOpt := pkt[10]
	sameParams := binary.LittleEndian.Uint16(pkt[11:13])
	p = 13
	nu := int(int16(binary.LittleEndian.Uint16(pkt[p:])))
	p += 2
	if nu < 0 || !need(2*nu+2) {
		return nil
	}
	units := make([]int16, nu)
	for i := range units {
		units[i] = int16(binary.LittleEndian.Uint16(pkt[p:]))
		p += 2
	}
	nc := int(int16(binary.LittleEndian.Uint16(pkt[p:])))
	p += 2
	var out []int16
	for c := 0; c < nc; c++ {
		id := same
		if id == 0 {
			if !need(4) {
				return out
			}
			id = int32(binary.LittleEndian.Uint32(pkt[p:]))
			p += 4
		}
		if sameOpt == 0xFF {
			if !need(1) {
				return out
			}
			p++
		}
		np := int(sameParams)
		if sameParams == 0xFFFF {
			if !need(2) {
				return out
			}
			np = int(binary.LittleEndian.Uint16(pkt[p:]))
			p += 2
		}
		if !need(4 * np) {
			return out
		}
		p += 4 * np
		if id != cmdSelfD {
			continue
		}
		if pairwise {
			if c < len(units) {
				out = append(out, units[c])
			}
		} else {
			out = append(out, units...)
		}
	}
	return out
}

// SelfDEvents is the demo's self-destruct orders as capture events, each on
// the ordering player's team. An order from a player the startscript does not
// put on a team (a spectator; the engine refuses those) is dropped.
func (d *Demo) SelfDEvents() []snapshot.Event {
	team := map[int32]int32{}
	if d.Startscript != nil {
		for _, p := range d.Startscript.Players {
			if !p.Spectator {
				team[int32(p.Index)] = int32(p.Team)
			}
		}
	}
	var out []snapshot.Event
	for _, s := range d.SelfD {
		t, ok := team[s.Player]
		if !ok {
			continue
		}
		out = append(out, snapshot.Event{Frame: s.Frame, Kind: snapshot.EventSelfD, UnitID: s.Unit, DefID: -1, Team: t})
	}
	return out
}
