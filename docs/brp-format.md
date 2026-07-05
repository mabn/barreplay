# The BRP capture format, version 2

`.brp` is barreplay's on-disk (and effectively over-the-wire) format for a
recorded replay capture: periodic snapshots of every unit's state plus unit
lifecycle events, as sampled by the Lua widget during a headless re-simulation.

This document specifies the format byte-for-byte, explains *why* it is shaped
the way it is, and states the guarantees implementations may rely on.

Reference implementations (these three must stay in lockstep):

| What | Where |
| --- | --- |
| Encoder + decoder (Go) | `snapshot/brp.go` |
| Frame/event decoder (JS) | `internal/viz/web/app.js` (`decodeFrames`, `decodeEvents`) |
| Serving / wire container | `internal/viz/wire.go`, `internal/viz/server.go` |

Measured on a real 33-minute 8v8 game (1 952 sampled frames, 4 223 293 unit
records, 48 823 events): **476 MB** as v1 JSONL → **13.96 MB** as `.brp`
(~33×), of which the browser-relevant part is ~10 MB.

---

## 1. Design goals

1. **Small.** Unit state barely changes between 1 Hz samples, so the format is
   built around *temporal prediction*: store what changed, predict what can be
   predicted, entropy-code the residual.
2. **Cheap to serve.** A web server must be able to hand any part of the
   capture to a browser **byte-for-byte, with no re-encoding** — every
   independently-fetchable piece is its own gzip stream, decodable with the
   browser's native `DecompressionStream`.
3. **Random access.** Playback must be able to start instantly, seek to any
   timestamp, and *skim* (render sparse preview frames) without downloading or
   decoding the whole file. This is the video-codec model: keyframes + delta
   frames, grouped into self-contained chunks, described by an index.
4. **Full fidelity.** Everything the legacy JSONL carried is preserved
   (subject to fixed quantization, §8), including data the current viewer
   doesn't use — unit height, vertical velocity, build progress, per-team
   economy. That data lives in its own section so a viewer never pays for it.
5. **Deterministic.** The same capture always produces a byte-identical file.
   barreplay's "diff two runs to prove an engine optimization changed nothing"
   workflow depends on this.

## 2. Conventions and primitives

- **Endianness:** all fixed-width integers are little-endian.
- **`uvarint`:** unsigned LEB128, as encoded by Go's `encoding/binary.Uvarint`
  — 7 value bits per byte, high bit = continuation, least-significant group
  first.
- **`svarint`:** a signed value mapped through **zigzag** then written as a
  `uvarint`:

  ```
  zigzag(v)   = (v << 1) XOR (v >> 63)        // arithmetic shift; 0,-1,1,-2,2… -> 0,1,2,3,4…
  unzigzag(u) = (u >> 1) XOR -(u & 1)
  ```

- **`gzip(...)`:** a standalone RFC 1952 gzip stream. The reference writer uses
  compression level 6 (`gzip.DefaultCompression`; level 9 measured >10× slower
  for <2 % size on real data), but readers must accept any valid gzip stream.
- **Sim rate:** the engine simulates at a fixed **30 frames per game-second**.
  Frame *time* is therefore never stored: `t = frame / 30`.

## 3. Container framing

```
offset  size  value
0       4     magic "BRP1" (ASCII)
4       1     format version, u8. MUST be 2.
5       …     zero or more sections, back to back, until EOF:
              tag u8 | payloadLength u32le | payload (payloadLength bytes)
```

- The magic is `BRP1` for **all** versions; the version byte is what changes.
  Version 2 is the only defined version (a v1 existed only on an unmerged
  development branch and was never released; readers MUST reject any version
  byte other than 2).
- Readers MUST skip sections with unknown tags (that is the format's
  forward-compatibility mechanism: new sections can be added without a version
  bump).
- The writer emits sections in the order `M F X E`; readers MUST NOT rely on
  order.

### Section tags

| Tag | Name | Payload | Purpose |
| --- | --- | --- | --- |
| `M` (0x4D) | meta | one gzip stream of JSON | capture metadata + aggregates + **chunk index** |
| `F` (0x46) | frames | concatenated **chunks** (§5) | core per-unit columns — everything the viewer renders |
| `X` (0x58) | extra | concatenated chunks, same boundaries as `F` | full-fidelity extras: y, vertical velocity, build progress, team economy |
| `E` (0x45) | events | one gzip stream (§7) | unit lifecycle events |
| `J` (0x4A) | head | one gzip stream of JSON | **not used in files** — reserved for the viz wire container (§10) |

## 4. `M` — the meta section

`gunzip(payload)` yields UTF-8 JSON of this shape (Go: `brpMetaRecord`):

```jsonc
{
  "meta":        { ... },      // the capture Meta, see below
  "bounds":      { "minX": -2104, "maxX": 13234, "minZ": -849, "maxZ": 14436 },
  "frameTeams":  [0, 1, 2],    // every team id that appears in frames or events
  "frames":      1952,         // total sampled frames
  "events":      48823,        // total events
  "unitRecords": 4223293,      // total per-frame unit rows (sum of frame unit counts)
  "chunkFrames": 64,           // nominal samples per chunk (the last chunk may be short)
  "chunks":      [ ... ]       // the chunk index, see §5
}
```

- `bounds` is the min/max of all **quantized** unit x/z positions across every
  frame, precomputed at write time so consumers never scan frames to fit a
  viewport. Omitted when the capture contains no units.
- `frameTeams` (sorted ascending) exists so a consumer can colour/list teams
  that appear in frame or event data but are missing from `meta.teams`.

### 4.1 `meta` — the capture metadata

This is the `snapshot.Meta` structure, unchanged from the data model:

| Field | JSON key | Notes |
| --- | --- | --- |
| Game id | `gameId` | 32-hex-char id from the demo header |
| Engine version | `engineVersion` | e.g. `"2025.06.24"` — the exact build the replay pins |
| Game version | `gameVersion` | the game archive springname, e.g. `"Beyond All Reason test-30555-080a333"` |
| Map name | `mapName` | display name, e.g. `"Supreme Isthmus v2.1"` |
| Start time | `startUnix` | unix seconds |
| Sample interval | `sampleEvery` | sim frames between snapshots (30 = 1 Hz). If ≤ 0, decoders assume 30. |
| Unit definitions | `unitDefs` | object keyed by def id (as a string), values below |
| Teams | `teams` | array of team info, below |
| Players | `players` | array of player info, below (optional) |

`unitDefs` values (`snapshot.UnitDef`; every field after `name` is optional):
`id`, `name` (internal name, e.g. `armcom`), `humanName`, `metalCost`,
`energyCost`, `buildTime`, `maxHealth`, `speed`, `xsize`/`zsize` (build
footprint in 8-elmo squares), `iconType` (BAR `icontypes.lua` key),
`isBuilder`, `isBuilding`, `isFactory`, `canFly`, `canMove`, `weaponCount`.
The **full** def table is recorded (not just id→name) because mods add and
modify unit types and the id space depends on the exact game build.

`teams` entries (`snapshot.TeamInfo`): `teamId`, `allyTeam`, `side`
(`armada`/`cortex`/…, optional), `player` (display name, optional), `color`
(`#rrggbb`, optional).

`players` entries (`snapshot.PlayerInfo`): `id`, `name`, `team`, `spectator`,
`country`, `rank`, `skill` (OpenSkill "OS"), `skillUncertainty`, `accountId`,
`boss` — the richer fields come from the demo startscript when available.

### 4.2 The chunk index

Each entry of `chunks` locates one chunk (§5) inside the `F` and `X` sections:

```jsonc
{
  "frame":   1920,   // sim frame of the chunk's FIRST sample
  "count":   64,     // samples in this chunk
  "fOff":    433201, // byte offset of the chunk in the F section payload
  "fKeyLen": 10233,  // bytes of the keyframe gzip stream within it
  "fLen":    331890, // total chunk bytes in F (keyframe + delta streams)
  "xOff":    150114, // same three, for the X section
  "xKeyLen": 3021,
  "xLen":    99852
}
```

- Offsets are **relative to the owning section's payload start**, *not* to the
  file. This avoids a chicken-and-egg problem (the `M` section, which contains
  the index, precedes `F`/`X` in the file, so absolute offsets would depend on
  `M`'s own compressed size). To compute an absolute file range — e.g. to serve
  chunks via HTTP Range requests from a static host — add the section's payload
  offset, which any container scan yields (`snapshot.ReadContainer` reports it
  as `Section.Offset`).
- Chunks tile their section contiguously and in order
  (`chunks[i+1].fOff == chunks[i].fOff + chunks[i].fLen`), but readers should
  navigate by the index, not by that property.

## 5. Chunking — the random-access model

Frames are grouped into **chunks of `chunkFrames` consecutive samples**
(64 by default ≈ one minute of game at 1 Hz; the final chunk holds whatever
remains). Two properties make a chunk the unit of random access:

1. **The codec's prediction state resets at every chunk boundary.** All
   temporal deltas (§6) are computed against the previous frame *within the
   same chunk*; the chunk's first frame therefore encodes every unit through
   the "new unit" path — fully absolute values. That first frame is the
   **keyframe**. A chunk decodes correctly with zero bytes from outside it.
2. **A chunk's bytes are two standalone gzip streams**, concatenated:

   ```
   [ gzip(keyframe codec bytes) ][ gzip(delta frames codec bytes) ]
     `- fKeyLen bytes            `- (fLen - fKeyLen) bytes
   ```

   The second stream is **absent when the chunk has exactly one frame**
   (`fLen == fKeyLen`). The split exists so a consumer can fetch and decode
   *only the keyframe* — ~10 KB for a 2 000-unit game — which is what makes
   skimming (rendering one preview frame per minute while scrubbing) nearly
   free. To decode a full chunk, gunzip both streams and concatenate the
   *decompressed* bytes; the result is a single codec stream (§6) containing
   `count` frames.

Do **not** rely on the two streams being decodable as one concatenated
multi-member gzip: some `DecompressionStream` implementations stop at the
first member's end. Split at `fKeyLen` and gunzip each part separately.

The `X` section chunks at exactly the same frame boundaries (its columns share
the same prediction-state lifetime), with its own byte ranges in the index.

Chunk-size trade-off: smaller chunks seek at finer granularity but repeat
keyframes more often. At 64 frames the measured overhead versus one monolithic
delta stream is ~+4 % file size.

## 6. `F` — the core frame codec

The decompressed codec stream of one chunk is a sequence of frames, each:

```
svarint  frameDelta        // this frame's sim frame − previous frame's (0 at chunk start)
uvarint  n                 // unit count
n × svarint                // column 0: unit id
n × svarint                // column 1: def
n × svarint                // column 2: team
n × svarint                // column 3: x
n × svarint                // column 4: z
n × svarint                // column 5: hp
n × svarint                // column 6: maxHp
n × svarint                // column 7: dvx
n × svarint                // column 8: dvz
```

Frames continue until the stream is exhausted (the chunk's `count` in the
index says how many to expect; the Go reader cross-checks).

### 6.1 The id column

Units within a frame are **sorted by unit id, ascending** (the writer sorts;
original in-frame order is not preserved). The id column is delta-coded
*within the frame*: each value is `id[i] − id[i−1]`, with `id[−1] = 0`.

While reading the id column, the decoder also resolves, per unit, whether that
id existed in the **previous frame of the same chunk** — this drives the
prediction of every other column.

### 6.2 Value columns and prediction

Every value column entry is `svarint(actual − predicted)`. The prediction
depends only on the *same unit's* record in the previous frame (`prev`):

| Column | Predicted value when the id existed in the previous frame | When new |
| --- | --- | --- |
| `def` | `prev.def` | 0 (absolute) |
| `team` | `prev.team` | 0 |
| `x` | `prev.x + prev.dvx` | 0 |
| `z` | `prev.z + prev.dvz` | 0 |
| `hp` | `prev.hp` | 0 |
| `maxHp` | `prev.maxHp` | 0 |
| `dvx` | `prev.dvx` | 0 |
| `dvz` | `prev.dvz` | 0 |

`dvx`/`dvz` are the unit's **velocity displacement per sample interval**:
`round(velocity × sampleEvery)`, in whole elmos. Two things fall out of that
choice:

- The x/z predictor `prev.pos + prev.dv` is dead reckoning: a unit moving at
  constant velocity encodes as an all-zero residual. This is the single
  biggest size win in the format.
- `dv` is *exactly* the Hermite tangent the viewer uses to interpolate motion
  between samples, so no unit conversion happens at render time.

After each frame, the decoder replaces its `prev` map with the frame just
decoded (state is per-chunk; see §5).

### 6.3 Worked example

A chunk's first two frames; two units in frame 30, one destroyed and one built
by frame 60. `sv(v)` denotes the zigzag varint of `v`.

Frame 30 (keyframe — no previous frame, everything absolute):

| unit | def | team | x | z | hp | maxHp | dvx | dvz |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 10 | 1 | 100 | 200 | 50 | 50 | 3 | 0 |
| 9 | 12 | 2 | 400 | 401 | 80 | 100 | 0 | 0 |

```
sv(30) uv(2)
ids:   sv(5)  sv(4)          // 5, then 9−5
def:   sv(10) sv(12)         // absolute (new ids)
team:  sv(1)  sv(2)
x:     sv(100) sv(400)
z:     sv(200) sv(401)
hp:    sv(50) sv(80)
maxHp: sv(50) sv(100)
dvx:   sv(3)  sv(0)
dvz:   sv(0)  sv(0)
```

Frame 60: unit 5 moved to (103, 200) still at dv (3, 0); unit 9 is gone; new
unit 11 (def 10, team 1) at (500, 7) with hp 20/50, dv (0, 0):

```
sv(30) uv(2)                 // frame 60 − 30; two units
ids:   sv(5)  sv(6)          // 5, then 11−5
def:   sv(0)   sv(10)        // unit 5: 10−10; unit 11: absolute
team:  sv(0)   sv(1)
x:     sv(0)   sv(500)       // unit 5: 103 − (100+3) = 0 — dead reckoning hit
z:     sv(0)   sv(7)         // unit 5: 200 − (200+0)
hp:    sv(0)   sv(20)
maxHp: sv(0)   sv(50)
dvx:   sv(0)   sv(0)         // unit 5: 3−3
dvz:   sv(0)   sv(0)
```

Unit 9 needs no "removal" record — it is simply absent from frame 60's id set
(its destruction is also logged in the `E` section).

## 7. `X` — the extra section

Everything the current viewer does *not* render, kept for full fidelity and
future UI (height display, build-progress bars, economy graphs). Same chunk
boundaries as `F`; per frame, the decompressed stream is:

```
n × svarint                // column: y      (predicted prev.y + prev.dvy | 0)
n × svarint                // column: dvy    (predicted prev.dvy          | 0)
n × svarint                // column: build  (predicted prev.build        | 0)
uvarint  r                 // team-resource record count
r × {                      // sorted by team id, ascending
  svarint team             //   absolute
  svarint Δ(metal×10)      //   each field: delta vs the SAME TEAM's value
  svarint Δ(energy×10)     //   in the previous frame of this chunk
  svarint Δ(metalStorage×10)   (0-predicted when the team is new to the chunk)
  svarint Δ(energyStorage×10)
  svarint Δ(metalIncome×10)
  svarint Δ(energyIncome×10)
}
```

`build` is `round(buildProgress × 255)` (255 = finished). Incomes are per
game-second.

**`X` is not self-describing:** it has no unit counts or ids of its own — the
column lengths, unit order, and the existed-in-previous-frame flags all come
from decoding the same chunk of `F` first. Decode them together
(`snapshot.ReadBRP` / `BRPFile.DecodeChunk` do).

## 8. Quantization

All quantization happens **once, at write time**; decoders return the
quantized values (there is no way, and no need, to recover the raw floats).

| Quantity | Stored as | Resolution |
| --- | --- | --- |
| Position x, y, z | whole elmos, `round()` | 1 elmo (the map is 10 000+ elmos across) |
| Health, max health | whole points, `round()` | 1 hp |
| Velocity | displacement per sample interval: `round(vel × sampleEvery)` | 1 elmo / interval (= 1/30 elmo/frame at 1 Hz) |
| Build progress | `round(progress × 255)` | 1/255 |
| Resources (all six fields) | `round(value × 10)` | 0.1 metal/energy |
| Frame time | *not stored* — `t = frame / 30` | exact |

On decode, velocities come back as `dv / sampleEvery` (per sim frame, matching
the engine's `GetUnitVelocity` units), build as `build / 255`, resources as
`value / 10`.

## 9. `E` — the events section

One gzip stream for the whole capture (events are small — ~190 KB compressed
for 49 k events — and the viewer wants them all upfront for its feed, so they
are not chunked). Decompressed layout, columnar like frames:

```
uvarint  count
uvarint  k                       // kind string-table size
k × { uvarint len; len bytes }   // kind names, in order of first appearance
count × svarint                  // frame:  delta vs previous event's frame (from 0)
count × uvarint                  // kind:   index into the table
count × svarint                  // unitId: delta vs previous event's unitId (from 0)
count × svarint                  // defId:  absolute
count × svarint                  // team:   absolute
```

Known kinds are `created`, `finished`, `destroyed`; the string table means new
kinds can appear without a format change. Events are stored in capture order
(non-decreasing frame), but the frame column is zigzag-coded so a
non-monotonic stream still round-trips.

## 10. The BRW wire container (how the viz server uses all this)

Not part of the file format, but specified here because it reuses the same
framing and the same chunk bytes. `barreplay-viz` serves:

- **`GET /api/replay?file=<name>.brp`** → a container with magic **`BRW1`**,
  version 2, sections:
  - `J`: gzip(JSON head) — a *viewer-shaped* projection of `M`: `gameId`,
    `engineVersion`, `gameVersion`, `mapName`, `sampleEvery`, `bounds`,
    `teams` (meta teams + `frameTeams` fill-ins), `unitDefs` (id→name only),
    `unitIcons`, `footprints`, `frameCount`, and `chunks` — the index reduced
    to `{frame, count, keyLen, len}` (the browser addresses chunks by ordinal,
    so it needs the keyframe split point but not file offsets).
  - `E`: the file's events section, **byte-for-byte**.
- **`GET /api/replay/chunk?file=<name>.brp&i=<n>`** → the raw bytes
  `F[fOff : fOff+fLen]` of chunk *n* — again byte-for-byte from the file; with
  **`&key=1`**, only `F[fOff : fOff+fKeyLen]` (the keyframe stream).

This zero-re-encoding property is the reason chunks are independently gzipped:
the server's cost per request is a byte-range copy, and the storage format *is*
the transfer format. The `X` section is never sent to the browser.

## 11. Guarantees and non-guarantees

Implementations may rely on:

- **Determinism:** encoding the same capture (same meta, frames, events)
  produces a byte-identical file for a given writer version.
- **Chunk independence:** any chunk decodes from its indexed byte range alone.
- **Round-trip fidelity:** decode(encode(capture)) preserves everything except
  (a) unit order within a frame (always sorted by id afterwards),
  (b) sub-quantization precision (§8), and
  (c) `TimeSec`, which is re-derived as `frame/30`.
- **Forward compatibility:** unknown section tags are skipped, and unknown
  JSON keys in `M` are ignored, so both can be extended without a version
  bump. Anything that changes how existing bytes must be *interpreted* —
  column set, column order, prediction rules, chunk framing — requires
  incrementing the version byte, and readers reject versions they don't know.

Explicitly **not** guaranteed:

- Byte-stability *across* writer versions (a gzip level change alone breaks
  it). Determinism holds per build; the diff-two-runs workflow assumes both
  runs used the same binary.
- Any particular gzip compression level in files being read.
- Section order within the container.

## 12. Reading a file, end to end

```
1. Read 4-byte magic "BRP1"; read version byte; reject if != 2.
2. Scan sections (tag, u32le length, payload) until EOF, remembering each
   payload's absolute offset. Skip unknown tags.
3. gunzip M; parse JSON → meta, bounds, counts, chunk index.
4. For whatever part of the timeline you need:
   a. Pick chunk i from the index (its "frame"/"count" map sim time ranges
      to chunks; t = frame/30).
   b. Slice F[fOff : fOff+fLen]. gunzip [0 : fKeyLen) and, if fLen > fKeyLen,
      [fKeyLen : fLen); concatenate the decompressed bytes.
   c. Decode frames per §6 with fresh prediction state.
   d. (Optional, for y/build/resources:) slice and gunzip the X ranges the
      same way and decode per §7, driven by F's ids/order.
5. gunzip E and decode per §9 when events are needed.
```

Go entry points: `snapshot.ParseBRP` (steps 1–3, leaves sections compressed),
`BRPFile.DecodeChunk(i)` (step 4), `snapshot.ReadBRP` (everything).
