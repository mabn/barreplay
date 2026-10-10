// Package breptest builds small .brepstream captures for tests outside
// internal/capture (the packer, the ingest daemon), which used to hand-write
// the retired BRSNAP text stream instead. It mirrors only as much of the
// widget's encoder (assets/lua/replay_uploader.lua) as those tests need:
// keyframe samples, events and the text preamble. The full encoder is pinned
// by internal/capture's harness golden.
package breptest

import (
	"bytes"
	"encoding/binary"
	"fmt"

	"github.com/mabn/barreplay/internal/capture"
)

// Unit is one unit in a sampled frame. Positions are whole elmos, velocities
// the per-sample displacement, Build 0..255 (255 = finished).
type Unit struct {
	ID, Def, Team   int
	X, Z, HP, MaxHP int
	DvX, DvZ, Build int
	Target          int
}

// Encoder accumulates a stream.
type Encoder struct {
	buf bytes.Buffer
}

// New starts a stream with the given preamble lines (each a full
// "BRSNAP ..." line ending in a newline; the caller ends it with READY).
func New(preamble string) *Encoder {
	e := &Encoder{}
	e.buf.WriteString(capture.BrepHeader + "\n")
	e.buf.WriteString(preamble)
	return e
}

func (e *Encoder) record(tag byte, payload []byte) {
	e.buf.WriteByte(tag)
	var n [4]byte
	binary.LittleEndian.PutUint32(n[:], uint32(len(payload)))
	e.buf.Write(n[:])
	e.buf.Write(payload)
}

// Keyframe writes a sample at frame holding exactly units (every unit
// absolute, so no prediction state is involved).
func (e *Encoder) Keyframe(frame int, units ...Unit) *Encoder {
	var b bytes.Buffer
	w16 := func(v int) { var s [2]byte; binary.LittleEndian.PutUint16(s[:], uint16(v)); b.Write(s[:]) }
	w32 := func(v int) { var s [4]byte; binary.LittleEndian.PutUint32(s[:], uint32(v)); b.Write(s[:]) }
	w32(frame)
	b.WriteByte(3) // keyframe + target column present
	w16(len(units))
	w16(0) // dead ids
	b.WriteByte(0)
	cols := []struct {
		width int
		get   func(Unit) int
	}{
		{2, func(u Unit) int { return u.ID }}, {2, func(u Unit) int { return u.Def }},
		{1, func(u Unit) int { return u.Team }}, {2, func(u Unit) int { return u.X }},
		{2, func(u Unit) int { return u.Z }}, {4, func(u Unit) int { return u.HP }},
		{4, func(u Unit) int { return u.MaxHP }}, {2, func(u Unit) int { return u.DvX }},
		{2, func(u Unit) int { return u.DvZ }}, {1, func(u Unit) int { return u.Build }},
		{2, func(u Unit) int { return u.Target }},
	}
	for _, c := range cols {
		for _, u := range units {
			switch c.width {
			case 1:
				b.WriteByte(byte(c.get(u)))
			case 2:
				w16(c.get(u))
			case 4:
				w32(c.get(u))
			}
		}
	}
	e.record('F', b.Bytes())
	return e
}

// Event writes a lifecycle event.
func (e *Encoder) Event(frame int, kind string, id, def, team int) *Encoder {
	e.record('E', []byte(fmt.Sprintf("%d %s %d %d %d", frame, kind, id, def, team)))
	return e
}

// Bytes is the stream so far.
func (e *Encoder) Bytes() []byte { return e.buf.Bytes() }

// Fact writes a G record (game fact) carrying json verbatim.
func (e *Encoder) Fact(json string) *Encoder {
	e.record('G', []byte(json))
	return e
}
