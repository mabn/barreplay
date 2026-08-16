// Package demofile parses the header and embedded startscript of a BAR/Recoil
// replay file (.sdfz).
//
// A .sdfz is a gzip-compressed Spring demo (.sdf). The layout is:
//
//	[DemoFileHeader]                     (byte-packed, little-endian)
//	[startscript / setup text]           headerSize .. headerSize+scriptSize
//	[demo packet stream]                 the deterministic input log
//	[player stats][team stats][winners]
//
// We need the header (for engine version + gameID), the startscript (a TDF
// document describing map, game/mod, players and teams), and — from the packet
// stream — the chat and map drawings (see comms.go). Unit positions are
// deliberately NOT read from the stream: they are recovered by re-simulating
// the replay in the engine. Comms are the exception because the stream is the
// only place they exist at all, and there they are complete and exactly framed.
package demofile

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"

	"github.com/mabn/barreplay/snapshot"
)

const magicString = "spring demofile"

// Header is the decoded fixed-size demo header (the fields we use).
type Header struct {
	Magic          string
	Version        int32
	HeaderSize     int32
	EngineVersion  string // versionString[256], e.g. "2025.06.24"
	GameID         string // 16 bytes, hex; equals the BAR gameId
	UnixTime       uint64
	ScriptSize     int32
	DemoStreamSize int32
	GameTime       int32 // total game-time seconds
}

// Demo bundles the parsed header and startscript, plus the player comms
// recovered from the packet stream.
type Demo struct {
	Header      Header
	ScriptRaw   string
	Startscript *Startscript
	// Comms is everything the players wrote and drew, in frame order — the
	// authoritative record of it (see comms.go). Empty for a demo whose stream
	// is absent or truncated, which is not an error.
	Comms []snapshot.Comm
}

// rawHeader mirrors the on-disk packed layout for binary.Read. Field order and
// sizes match rts/System/LoadSave/demofile.h exactly.
type rawHeader struct {
	Magic              [16]byte
	Version            int32
	HeaderSize         int32
	VersionString      [256]byte
	GameID             [16]byte
	UnixTime           uint64
	ScriptSize         int32
	DemoStreamSize     int32
	GameTime           int32
	WallclockTime      int32
	NumPlayers         int32
	PlayerStatSize     int32
	PlayerStatElemSize int32
	NumTeams           int32
	TeamStatSize       int32
	TeamStatElemSize   int32
	TeamStatPeriod     int32
	WinningAllyTeams   int32
}

func cstr(b []byte) string {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		return string(b[:i])
	}
	return string(b)
}

// Parse reads a .sdfz from r (gzip-compressed) and returns the header plus the
// parsed startscript.
func Parse(r io.Reader) (*Demo, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, fmt.Errorf("demofile: gunzip: %w", err)
	}
	defer gz.Close()

	// Read enough to cover the header; then continue reading the script.
	var rh rawHeader
	if err := binary.Read(gz, binary.LittleEndian, &rh); err != nil {
		return nil, fmt.Errorf("demofile: read header: %w", err)
	}
	if got := cstr(rh.Magic[:]); got != magicString {
		return nil, fmt.Errorf("demofile: bad magic %q (want %q)", got, magicString)
	}

	h := Header{
		Magic:          cstr(rh.Magic[:]),
		Version:        rh.Version,
		HeaderSize:     rh.HeaderSize,
		EngineVersion:  cstr(rh.VersionString[:]),
		GameID:         hex.EncodeToString(rh.GameID[:]),
		UnixTime:       rh.UnixTime,
		ScriptSize:     rh.ScriptSize,
		DemoStreamSize: rh.DemoStreamSize,
		GameTime:       rh.GameTime,
	}

	// The header may be larger than our struct in future versions; skip any
	// padding up to HeaderSize before the startscript begins.
	consumed := int32(binary.Size(rh))
	if h.HeaderSize > consumed {
		if _, err := io.CopyN(io.Discard, gz, int64(h.HeaderSize-consumed)); err != nil {
			return nil, fmt.Errorf("demofile: skip header padding: %w", err)
		}
	}

	if h.ScriptSize <= 0 || h.ScriptSize > 64*1024*1024 {
		return nil, fmt.Errorf("demofile: implausible scriptSize %d", h.ScriptSize)
	}
	scriptBuf := make([]byte, h.ScriptSize)
	if _, err := io.ReadFull(gz, scriptBuf); err != nil {
		return nil, fmt.Errorf("demofile: read startscript: %w", err)
	}
	scriptRaw := cstr(scriptBuf)

	ss, err := ParseStartscript(scriptRaw)
	if err != nil {
		return nil, fmt.Errorf("demofile: parse startscript: %w", err)
	}

	// The packet stream follows the script. Unit positions are NOT read from it
	// (that is what the engine re-simulation is for), but chat and map drawings
	// are only in here — and here they are complete and exactly framed, which
	// no client-side capture can be. Bounded by the declared stream size when
	// the header carries one; a demo cut short by a crash may not have had its
	// header rewritten, in which case the scan runs to EOF and stops itself on
	// the first chunk that does not parse.
	var stream io.Reader = gz
	if h.DemoStreamSize > 0 {
		stream = io.LimitReader(gz, int64(h.DemoStreamSize))
	}
	comms := scanComms(stream)

	return &Demo{Header: h, ScriptRaw: scriptRaw, Startscript: ss, Comms: comms}, nil
}
