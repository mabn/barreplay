package viz

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"sync"

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
//     for structures, a metal cost for armed mobile defs (armyCost), and
//     CanFly read off the icon (BAR draws aircraft from "air*" bitmaps). Every
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
	// Pieces were last written by v5; v6 replays are published as a .brp.
	if version != 4 && version != 5 {
		return nil, nil, fmt.Errorf("head: unsupported version %d", version)
	}
	bf := &snapshot.BRPFile{Version: version, Sections: map[byte][]byte{}, Legacy: version == 4}
	var head legacyHead
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

	// Everything after the head is fetched at once, a few objects at a
	// time: one after another, the fifty-odd chunks of a long game were most
	// of an on-demand summary's wait.
	keys, chunks, resBody, resErr, err := fetchPieces(ctx, fetch, rid, head.Chunks)
	if err != nil {
		return nil, nil, err
	}
	bf.Sections[snapshot.SecKeyframes] = keys

	// The F section is the chunk files back to back, in index order; the
	// offsets are rebuilt from the lengths the head records.
	var frames bytes.Buffer
	var kOff int64
	for i, c := range head.Chunks {
		ch := snapshot.BRPChunk{Frame: c.Frame, Count: c.Count, KOff: kOff, KLen: c.KLen, FOff: int64(frames.Len()), FLen: c.Len}
		kOff += c.KLen
		frames.Write(chunks[i])
		bf.Chunks = append(bf.Chunks, ch)
	}
	bf.Sections[snapshot.SecFrames] = frames.Bytes()

	resources := map[int32][]snapshot.TeamResource{}
	if b, err := resBody, resErr; err == nil {
		var rf []legacyResFrame
		if err := json.Unmarshal(b, &rf); err != nil {
			return nil, nil, fmt.Errorf("resources: %w", err)
		}
		for _, f := range rf {
			var teams []snapshot.TeamResource
			for i := 0; i+legacyResStride <= len(f.R); i += legacyResStride {
				r := f.R[i : i+legacyResStride]
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

// pieceFetchers is how many pieces ReadStaticBundle fetches at once.
const pieceFetchers = 8

// fetchPieces fetches a bundle's keyframes, its delta chunks (in index order;
// nil for a chunk the head says is empty) and its economy, up to
// pieceFetchers at a time. The economy's own error is handed back rather than
// failing the rest, since a bundle may simply not have one.
func fetchPieces(ctx context.Context, fetch PieceFetcher, rid string, index []legacyChunk) (keys []byte, chunks [][]byte, res []byte, resErr, err error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	chunks = make([][]byte, len(index))
	var (
		mu    sync.Mutex
		first error
		wg    sync.WaitGroup
	)
	fail := func(e error) {
		mu.Lock()
		if first == nil {
			first = e
			cancel()
		}
		mu.Unlock()
	}
	sem := make(chan struct{}, pieceFetchers)
	run := func(f func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if ctx.Err() != nil {
				return
			}
			f()
		}()
	}
	run(func() {
		b, e := fetch(ctx, "replays/"+rid+".keys")
		if e != nil {
			fail(fmt.Errorf("keyframes: %w", e))
		}
		keys = b
	})
	for i, c := range index {
		if c.Len <= 0 {
			continue
		}
		run(func() {
			b, e := fetch(ctx, fmt.Sprintf("replays/%s/c%d", rid, i))
			if e != nil {
				fail(fmt.Errorf("chunk %d: %w", i, e))
				return
			}
			if int64(len(b)) != c.Len {
				fail(fmt.Errorf("chunk %d: %d bytes, head says %d", i, len(b), c.Len))
				return
			}
			chunks[i] = b
		})
	}
	run(func() { res, resErr = fetch(ctx, "replays/"+rid+".resources") })
	wg.Wait()
	if first != nil {
		return nil, nil, nil, nil, first
	}
	if ctx.Err() != nil {
		// The caller's context ended before every piece was asked for.
		return nil, nil, nil, nil, ctx.Err()
	}
	return keys, chunks, res, resErr, nil
}

// The published head's JSON, as this package wrote it into every .brw. It is
// declared here, apart from the encoder, on purpose: those pieces are
// immutable and stay in the bucket whatever the publisher writes next, so
// this reader has to keep reading them after the encoder changes or goes.
type legacyHead struct {
	GameID        string                     `json:"gameId"`
	EngineVersion string                     `json:"engineVersion"`
	GameVersion   string                     `json:"gameVersion"`
	MapName       string                     `json:"mapName"`
	SampleEvery   int32                      `json:"sampleEvery"`
	Bounds        legacyBounds               `json:"bounds"`
	Teams         []legacyTeam               `json:"teams"`
	UnitDefs      map[int32]string           `json:"unitDefs"`
	UnitNames     map[int32]string           `json:"unitNames"`
	UnitIcons     map[string]legacyIcon      `json:"unitIcons"`
	Footprints    map[string]legacyFootprint `json:"footprints"`
	ArmyCost      map[int32]int32            `json:"armyCost"`
	Players       []legacyPlayer             `json:"players"`
	FrameCount    int                        `json:"frameCount"`
	Chunks        []legacyChunk              `json:"chunks"`
}

type legacyBounds struct {
	MinX, MaxX, MinZ, MaxZ float64
}

type legacyTeam struct {
	TeamID   int32  `json:"team"`
	AllyTeam int32  `json:"ally"`
	Side     string `json:"side"`
	Player   string `json:"player"`
	Color    string `json:"color"`
}

type legacyIcon struct {
	Path string `json:"p"`
}

type legacyFootprint struct {
	W int32 `json:"w"`
	H int32 `json:"h"`
}

type legacyPlayer struct {
	ID        int32   `json:"id"`
	Name      string  `json:"name"`
	Team      int32   `json:"team"`
	Spectator bool    `json:"spec"`
	Country   string  `json:"country"`
	Rank      int32   `json:"rank"`
	Skill     float32 `json:"skill"`
}

type legacyChunk struct {
	Frame int32 `json:"frame"`
	Count int   `json:"count"`
	KLen  int64 `json:"kLen"`
	Len   int64 `json:"len"`
}

// legacyResFrame is one .resources record: a sim frame and, per team,
// [team, metal, energy, metalStore, energyStore, metalIncome, energyIncome].
type legacyResFrame struct {
	F int32   `json:"f"`
	R []int32 `json:"r"`
}

const legacyResStride = 7

// metaFromHead recovers as much of the capture Meta as the head carries.
func metaFromHead(h legacyHead) snapshot.Meta {
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
		// The head has no flight flag, but BAR's icon set draws every
		// aircraft (gunships included) from an "air*" bitmap, which is what
		// the summary's air category needs.
		if ic, ok := h.UnitIcons[name]; ok && strings.HasPrefix(path.Base(ic.Path), "air") {
			d.CanFly = true
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
