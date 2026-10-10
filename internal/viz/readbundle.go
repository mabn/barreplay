package viz

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/mabn/barreplay/snapshot"
)

// ErrNotFound is what a PieceFetcher returns for a piece that does not exist.
var ErrNotFound = errors.New("not found")

// PieceFetcher reads one published object by its bucket key, such as
// "replays/<rid>.brw".
type PieceFetcher func(ctx context.Context, key string) ([]byte, error)

// ReadStaticBundle rebuilds a replay from the split pieces WriteStaticBundle
// published for revision rid: the head, the keyframes, every delta chunk and
// the economy. It is the inverse of WriteStaticBundle, for replays whose .brp
// was never kept, and it recovers less than the .brp held:
//
//   - Unit defs: only what the head carries — names, human names, a footprint
//     for structures, and a metal cost for armed mobile defs (armyCost). Every
//     other def has no cost, so callers must not treat a missing cost as free.
//   - No X section: the economy comes back separately, keyed by frame.
//   - No recorder record, so no point of view.
//
// A v4 head (published before build progress and build targets joined the
// core columns) yields a file marked Legacy, which decodes those as
// "finished" and "no target".
func ReadStaticBundle(ctx context.Context, fetch PieceFetcher, rid string) (*snapshot.BRPFile, map[int32][]snapshot.TeamResource, error) {
	brw, err := fetch(ctx, "replays/"+rid+".brw")
	if err != nil {
		return nil, nil, fmt.Errorf("head: %w", err)
	}
	version, sections, err := snapshot.ReadContainer(bytes.NewReader(brw), snapshot.BRWMagic)
	if err != nil {
		return nil, nil, fmt.Errorf("head: %w", err)
	}
	if version != 4 && version != snapshot.BRPVersion {
		return nil, nil, fmt.Errorf("head: unsupported version %d", version)
	}
	bf := &snapshot.BRPFile{Sections: map[byte][]byte{}, Legacy: version == 4}
	var head wireHead
	for _, s := range sections {
		switch s.Tag {
		case snapshot.SecHead:
			raw, err := gunzipAll(s.Payload)
			if err != nil {
				return nil, nil, fmt.Errorf("head JSON: %w", err)
			}
			if err := json.Unmarshal(raw, &head); err != nil {
				return nil, nil, fmt.Errorf("head JSON: %w", err)
			}
		case snapshot.SecEvents, snapshot.SecComms:
			bf.Sections[s.Tag] = s.Payload
		}
	}
	bf.Meta = metaFromHead(head)
	bf.Bounds = &snapshot.BRPBounds{MinX: head.Bounds.MinX, MaxX: head.Bounds.MaxX, MinZ: head.Bounds.MinZ, MaxZ: head.Bounds.MaxZ}
	bf.FrameCount = head.FrameCount

	keys, err := fetch(ctx, "replays/"+rid+".keys")
	if err != nil {
		return nil, nil, fmt.Errorf("keyframes: %w", err)
	}
	bf.Sections[snapshot.SecKeyframes] = keys

	// The F section is the chunk files back to back, in index order; the
	// offsets are rebuilt from the lengths the head records.
	var frames bytes.Buffer
	var kOff int64
	for i, c := range head.Chunks {
		ch := snapshot.BRPChunk{Frame: c.Frame, Count: c.Count, KOff: kOff, KLen: c.KLen, FOff: int64(frames.Len()), FLen: c.Len}
		kOff += c.KLen
		if c.Len > 0 {
			b, err := fetch(ctx, fmt.Sprintf("replays/%s/c%d", rid, i))
			if err != nil {
				return nil, nil, fmt.Errorf("chunk %d: %w", i, err)
			}
			if int64(len(b)) != c.Len {
				return nil, nil, fmt.Errorf("chunk %d: %d bytes, head says %d", i, len(b), c.Len)
			}
			frames.Write(b)
		}
		bf.Chunks = append(bf.Chunks, ch)
	}
	bf.Sections[snapshot.SecFrames] = frames.Bytes()

	resources := map[int32][]snapshot.TeamResource{}
	if b, err := fetch(ctx, "replays/"+rid+".resources"); err == nil {
		var rf []wireResFrame
		if err := json.Unmarshal(b, &rf); err != nil {
			return nil, nil, fmt.Errorf("resources: %w", err)
		}
		for _, f := range rf {
			var teams []snapshot.TeamResource
			for i := 0; i+resourceStride <= len(f.R); i += resourceStride {
				r := f.R[i : i+resourceStride]
				teams = append(teams, snapshot.TeamResource{
					Team:  r[0],
					Metal: float32(r[1]), Energy: float32(r[2]),
					MetalStorage: float32(r[3]), EnergyStorage: float32(r[4]),
					MetalIncome: float32(r[5]), EnergyIncome: float32(r[6]),
				})
			}
			resources[f.F] = teams
		}
	} else if !errors.Is(err, ErrNotFound) {
		return nil, nil, fmt.Errorf("resources: %w", err)
	}
	return bf, resources, nil
}

// metaFromHead recovers as much of the capture Meta as the head carries.
func metaFromHead(h wireHead) snapshot.Meta {
	m := snapshot.Meta{
		GameID:        h.GameID,
		EngineVersion: h.EngineVersion,
		GameVersion:   h.GameVersion,
		MapName:       h.MapName,
		SampleEvery:   h.SampleEvery,
		UnitDefs:      map[int32]snapshot.UnitDef{},
	}
	for id, name := range h.UnitDefs {
		d := snapshot.UnitDef{DefID: id, Name: name, HumanName: h.UnitNames[id], CanMove: true}
		if fp, ok := h.Footprints[name]; ok {
			d.IsBuilding, d.CanMove = true, false
			d.XSize, d.ZSize = fp.W/8, fp.H/8
		}
		if cost, ok := h.ArmyCost[id]; ok {
			// armyCost only lists armed mobile defs, so that is what it
			// tells us about them; the exact speed and weapon count are lost.
			d.MetalCost = float32(cost)
			d.WeaponCount, d.Speed, d.CanMove = 1, 1, true
		}
		m.UnitDefs[id] = d
	}
	for _, t := range h.Teams {
		m.Teams = append(m.Teams, snapshot.TeamInfo{TeamID: t.TeamID, AllyTeam: t.AllyTeam, Side: t.Side, PlayerName: t.Player, Color: t.Color})
	}
	for _, p := range h.Players {
		m.Players = append(m.Players, snapshot.PlayerInfo{PlayerID: p.ID, Name: p.Name, Team: p.Team, Spectator: p.Spectator, CountryCode: p.Country, Rank: p.Rank, Skill: p.Skill})
	}
	return m
}

func gunzipAll(b []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(zr)
}
