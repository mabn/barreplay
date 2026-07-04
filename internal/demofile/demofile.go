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
// We only need the header (for engine version + gameID) and the startscript (a
// TDF document describing map, game/mod, players and teams). We deliberately do
// NOT parse the packet stream: unit positions are recovered by re-simulating the
// replay in the engine, not by reading the demo.
package demofile

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
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

// Demo bundles the parsed header and startscript.
type Demo struct {
	Header      Header
	ScriptRaw   string
	Startscript *Startscript
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

	return &Demo{Header: h, ScriptRaw: scriptRaw, Startscript: ss}, nil
}
