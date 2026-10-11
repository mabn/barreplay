# The BRP capture format, version 6

`.brp` is barreplay's on-disk (and effectively over-the-wire) format for a
recorded replay capture: periodic snapshots of every unit's state plus unit
lifecycle events, as sampled by the Lua widget during a headless re-simulation.

This document specifies the format byte-for-byte, explains *why* it is shaped
the way it is, and states the guarantees implementations may rely on.

Reference implementations (these three must stay in lockstep):

| What | Where |
| --- | --- |
| Encoder + decoder (Go) | `snapshot/brp.go` |
| Decoder + Range reader (JS) | `worker/public/app.js` (`loadBrpHead`, `headFromBrp`, `decodeFrames`, `decodeEvents`, `decodeComms`, `decodeEconomy`) |
| Publishing (the file IS the published replay) | `internal/viz/static.go`, `snapshot.IndexBRP` |

Measured on a real 33-minute 8v8 game (1 952 sampled frames, 4 223 293 unit
records, 48 823 events): **476 MB** as v1 JSONL → **7 993 143 bytes (7.6 MiB)**
as `.brp` v4 (~62×; v2 of the format measured 14.0 MiB). Section split on that
capture: K 0.55 MB, F 6.72 MB, X 0.46 MB, E 0.20 MB, M 0.06 MB.

The ideas that took v2 → v3 → v4 (see `docs/brp-optimizations.md` for the full
evaluation, including the ideas that were measured and rejected):

1. **Skip unchanged units** (v3). In a real game ~2/3 of all per-frame unit
   records are byte-for-byte predictable from the previous sample. Delta
   frames list only the units that *changed* (plus an explicit dead list);
   everything else is reconstructed by the decoder.
2. **Drop the elevation columns** (v3). y/dvy were ~28 % of all column changes
   (terrain-following noise on every walking unit) and nothing consumed them:
   the viewer renders the x/z plane, and a ground unit's height is implied by
   the map heightmap. They are not stored; decoded frames return y = 0.
3. **Keyframes together, outside the chunks** (v4). All core keyframes moved
   into one gzip stream (the `K` section) so a viewer downloads them FIRST —
   one request, decoded progressively while it streams — making the whole
   timeline scrubbable within seconds, before any chunk arrives. Chunks now
   hold only delta frames (no byte is fetched twice), and merging the
   near-duplicate adjacent keyframes into one stream compresses ~12 % better
   than the per-chunk keyframe streams it replaced.
4. **Build progress and build target in the core columns** (v5). The viewer
   draws construction progress bars and builder→target lines, so `build`
   moved from the X stream into the core columns and a tenth column `target`
   (the unit id this unit is constructing/assisting, 0 = none) was added. X
   now carries only team economy.
5. **What happened, not just where** (v6). The re-simulation records why
   things happened: the killer of each unit (four cause columns on `E`), the
   game's facts (who won, who was eliminated, the weapon table, the engine's
   team statistics — `G`), damage per (attacker, weapon, victim) per second
   (`D`), each unit's lifetime totals (`S`) and which side could see each
   unit (`V`). No frame column changed: v6 readers decode v5 files as they
   always did, those files simply have none of it. None of the new sections
   is sent to the browser; they feed the game summary.

---

## 1. Design goals

1. **Small.** Unit state barely changes between 1 Hz samples, so the format is
   built around *temporal prediction*: store only what changed, predict what
   can be predicted, entropy-code the residual.
2. **Cheap to serve.** A web server must be able to hand any part of the
   capture to a browser **byte-for-byte, with no re-encoding** — every
   independently-fetchable piece is its own gzip stream, decodable with the
   browser's native `DecompressionStream`.
3. **Random access.** Playback must be able to start instantly, seek to any
   timestamp, and *skim* (render sparse preview frames) without downloading or
   decoding the whole file. This is the video-codec model: keyframes + delta
   frames, grouped into self-contained chunks, described by an index.
4. **Fidelity by decision, not accident.** Everything stored is exact up to a
   fixed, documented quantization (§8). What is *not* stored is a deliberate
   choice: unit elevation and vertical velocity (see above). Per-team economy
   is kept in its own section, so a viewer never pays for it.
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
4       1     format version, u8. 6 (written) or 5 (still read).
5       …     zero or more sections, back to back, until EOF:
              tag u8 | payloadLength u32le | payload (payloadLength bytes)
```

- The magic is `BRP1` for **all** versions; the version byte is what changes.
  Versions 6 (what the writer emits) and 5 (identical frames, no event
  causes or analysis sections) are readable — v1 (unchunked), v2 (every live unit
  re-encoded in every frame; y/dvy columns) and v3 (keyframes inside the
  chunks) existed only pre-release; v4 (no build/target core columns, build in
  X) was released and is still decoded by the JS viewer (so published bundles
  keep playing), but the Go reader rejects it. Readers MUST reject any other
  version byte. Older files cannot be converted in place; regenerate them from
  their source `.brepstream` with `pack`.
- Readers MUST skip sections with unknown tags (that is the format's
  forward-compatibility mechanism: new sections can be added without a version
  bump).
- `M` is always the FIRST section (a reader holding only the head of the file
  finds everything else through it, §4). The writer then emits `E C K F X` —
  the sections a viewer needs before it can draw, then the bulk — and records
  that order in `M`'s section layout, followed by v6's optional analysis
  sections `G V H U R W` (`D S` in older v6 files), which no viewer reads. Files written before the layout existed
  have `M K F X E C`. Readers MUST NOT rely on the order of anything after `M`:
  scan the headers, or follow the layout.

### Section tags

| Tag | Name | Payload | Purpose |
| --- | --- | --- | --- |
| `M` (0x4D) | meta | one gzip stream of JSON | capture metadata + aggregates + **chunk index** |
| `K` (0x4B) | keyframes | **one gzip stream**: every chunk's core keyframe, concatenated in chunk order | the keys-first download; also the prediction base every chunk's deltas decode from |
| `F` (0x46) | frames | concatenated **chunks** (§5): each chunk's DELTA frames as one gzip stream | core per-unit columns — everything the viewer renders |
| `X` (0x58) | extra | concatenated chunks, same frame boundaries as `F` (keyframe gzip + delta gzip per chunk) | extras: team economy |
| `E` (0x45) | events | one gzip stream (§9) | unit lifecycle events |
| `C` (0x43) | comms | one gzip stream (§9.1) | player chat + map drawings; **omitted entirely** when the capture recorded none |
| `G` (0x47) | facts | one gzip stream (§9.2), v6 | game facts; omitted when none |
| `D` (0x44) | damage | one gzip stream (§9.2), v6 | damage windows; only in older v6 files (now derived from `H`) |
| `S` (0x53) | lives | one gzip stream (§9.2), v6 | per-unit lifetime totals; only in older v6 files (now derived from `H`/`U`) |
| `V` (0x56) | visibility | one gzip stream (§9.2), v6 | per-side LOS/radar per unit; omitted when none |
| `H` (0x48) | hits | one gzip stream (§9.2), v6 | every damage callin, raw; omitted when none |
| `U` (0x55) | unit ends | one gzip stream (§9.2), v6 | where each unit's life ended; omitted when none |
| `R` (0x52) | projectiles | one gzip stream (§9.2), v6 | tracks of long-range projectiles and heavy beams; omitted when none |
| `W` (0x57) | blasts | one gzip stream (§9.2), v6 | strong unit-death explosions and impacts no track ended; omitted when none |
| `J` (0x4A) | head | one gzip stream of JSON | **not used in files** — the head of the older `.brw` wire container (§10) |

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
  "facts": 157, "hits": 53074, "unitEnds": 5909, "visibility": 1916,
  "projectiles": 778, "blasts": 847,  // analysis record counts (v6; each omitted when 0)
  "chunkFrames": 64,           // nominal samples per chunk (the last chunk may be short)
  "chunks":      [ ... ],      // the chunk index, see §5
  "sections":    [             // the LAYOUT: every section after M, in file order
    { "tag": "E", "len": 201733 },
    { "tag": "K", "len": 551210 }, ...
  ]
}
```

- `bounds` is the min/max of all **quantized** unit x/z positions across every
  frame, precomputed at write time so consumers never scan frames to fit a
  viewport. Omitted when the capture contains no units.
- `frameTeams` (sorted ascending) exists so a consumer can colour/list teams
  that appear in frame or event data but are missing from `meta.teams`.
- The analysis counts (`facts`, `damageWindows`, `lives`, `visibility`,
  `hits`, `unitEnds`, `projectiles`, `blasts`) say how many records each
  analysis section holds without decoding it; a key is absent when its section
  is.
- `unitRecords` counts **full frame contents** (live units per frame, summed),
  not stored changed-records — it is unaffected by delta-frame skipping.
- `sections` lists every section after `M` — its one-character tag and its
  payload length, in file order. `M` is the first section, so its end is known
  from the 10 bytes in front of it (`10 + M's length`), and walking the layout
  from there (each section is a 5-byte header plus `len` bytes) gives every
  section's absolute payload offset. That is what lets a browser that has read
  only the head of a published file Range-read any section directly, instead
  of walking the headers one round trip at a time. Files written before it
  existed lack it; `snapshot.IndexBRP` adds it (and every publish runs through
  that, so a published file always has one).

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
| Recorder | `recorder` | live-capture point of view, below (optional) |
| Widget | `widget` | the uploader-widget build that produced the capture, below (optional) |

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

`recorder` (`snapshot.RecorderInfo`, optional): `playerId`, `allyTeam`,
`spectator` — the client whose point of view a live-game capture records
(from the uploader widget's `GAME` preamble line). Absent for the engine
re-sim pipeline, which sees the whole game.

`widget` (`snapshot.WidgetInfo`, optional): `version`, `date`, `sha` — which
build of the uploader widget wrote the stream, also from its `GAME` line. A
player's installed copy can be arbitrarily old, so the capture is the only
place this can be learned. `version`/`date` are the constants the widget bumps
together; `sha` is the git SHA stamped into the copy served for download
(worker/tools/sync-assets.mjs) and is absent when a player installed the widget
straight from the repo. Absent wholesale for re-sim captures (whose sampler is
injected by this tool) and for streams written before widget >= 1.7.0 — except
`version`, which the widget has always reported.

### 4.2 The chunk index

Each entry of `chunks` locates one chunk (§5) inside the `F` and `X` sections:

```jsonc
{
  "frame":   1920,   // sim frame of the chunk's FIRST sample
  "count":   64,     // samples in this chunk
  "kOff":    482112, // the keyframe's RAW byte range inside the DECOMPRESSED K
  "kLen":    31544,  //   (kOff/kLen are decompressed-byte offsets, see below)
  "fOff":    433201, // the chunk's delta gzip stream in the F section payload
  "fLen":    321657, //   (fLen == 0 when count == 1: no delta frames at all)
  "xOff":    150114, // the X section pieces: keyframe gzip [xOff, xOff+xKeyLen)
  "xKeyLen": 3021,   //   then delta gzip up to xOff+xLen
  "xLen":    99852
}
```

- `kOff`/`kLen` are offsets into the **decompressed** K payload — they are the
  slice boundaries a consumer needs while *streaming* the keys download
  through a decompressor (each keyframe is decoded the moment its bytes are
  complete, no trial parsing), and the random-access index into K for
  everything else.
- F/X offsets are compressed-byte offsets **relative to the owning section's
  payload start**, *not* to the file. This avoids a chicken-and-egg problem
  (the `M` section, which contains the index, precedes `F`/`X` in the file, so
  absolute offsets would depend on `M`'s own compressed size). To compute an
  absolute file range — e.g. to serve chunks via HTTP Range requests from a
  static host — add the section's payload offset, which any container scan
  yields (`snapshot.ReadContainer` reports it as `Section.Offset`).
- Chunks tile their sections contiguously and in order (in K:
  `chunks[i+1].kOff == chunks[i].kOff + chunks[i].kLen`; likewise in F/X),
  but readers should navigate by the index, not by that property.

## 5. Chunking — the random-access model

Frames are grouped into **chunks of `chunkFrames` consecutive samples**
(64 by default ≈ one minute of game at 1 Hz; the final chunk holds whatever
remains). The codec's prediction state resets at every chunk boundary: all
temporal deltas (§6) are computed against the previous frame *within the same
chunk*, so the chunk's first frame has no prior state — every unit is "new"
and appears in the changed list with fully absolute values. That first frame
is the **keyframe**.

The pieces are stored by role (v4):

1. **All keyframes live in the K section, as ONE gzip stream**, concatenated
   in chunk order; the index locates keyframe *i* at decompressed
   `[kOff, kOff+kLen)`. A consumer downloads K once, decoding keyframes
   progressively while the stream arrives (each is one self-contained frame),
   and can render any minute of the game — skimming/scrubbing — before any
   chunk is fetched. One merged stream also compresses ~12 % better than the
   per-chunk keyframe streams of v3 (adjacent keyframes are near-duplicates),
   and a static host serves it as one contiguous range.
2. **A chunk's F bytes are its DELTA frames only**, one standalone gzip
   stream (absent entirely — `fLen == 0` — when the chunk has exactly one
   frame). Decoding a chunk requires its keyframe first: run keyframe *i*
   through a fresh codec, then the delta bytes through the same codec (§6).
   No byte is ever downloaded twice: skim fetches the keyframe (via K),
   playback adds only deltas.

The `X` section chunks at the same frame boundaries but keeps its
keyframe+delta gzip pair per chunk (`[xOff, xOff+xKeyLen)` +
`[xOff+xKeyLen, xOff+xLen)`) — browsers never fetch X, so it gains nothing
from the K treatment. Do **not** rely on adjacent gzip streams being
decodable as one concatenated multi-member gzip: some `DecompressionStream`
implementations stop at the first member's end; slice at the index boundaries
and gunzip each stream separately.

Chunk-size trade-off: smaller chunks seek at finer granularity but repeat
keyframes more often; keyframes also weigh more, relatively, now that delta
frames skip unchanged units (on the reference capture K is ~7 % of the file).

## 6. The core frame codec (`K` + `F`)

A decompressed codec stream is a sequence of frames. **Every frame — keyframe
included — uses the same layout** (a keyframe is simply a frame encoded
against empty prior state, so its lists degenerate to "nothing died,
everything changed"). Decoding order for chunk *i*: feed keyframe *i* (its
`[kOff, kOff+kLen)` slice of the decompressed K) through a fresh codec, then
the chunk's decompressed F bytes through the same codec.

```
svarint  frameDelta        // this frame's sim frame − previous frame's (0 at chunk start)
uvarint  nDead             // units present in the previous sample, absent now
nDead × svarint            //   their ids: ascending, delta-coded from 0
uvarint  nChanged          // new units + units with ≥1 changed column
nChanged × svarint         //   their ids: ascending, delta-coded from 0
nChanged × svarint         // column: def
nChanged × svarint         // column: team
nChanged × svarint         // column: x
nChanged × svarint         // column: z
nChanged × svarint         // column: hp
nChanged × svarint         // column: maxHp
nChanged × svarint         // column: dvx
nChanged × svarint         // column: dvz
nChanged × svarint         // column: build
nChanged × svarint         // column: target
```

Frames continue until the stream is exhausted (keyframe slice: exactly one
frame; chunk delta stream: `count − 1` frames; the Go reader cross-checks).

### 6.1 Implicitly-unchanged units — the core of v3

A unit that was alive in the previous sample and appears in **neither** list
is *implicitly unchanged*: it is still alive, and its state one sample later
is fully determined by prediction. The decoder MUST re-materialise it as

```
x   += dvx        // dead reckoning by the velocity displacement
z   += dvz
def, team, hp, maxHp, dvx, dvz, build, target   unchanged
```

The encoder puts a unit in the changed list exactly when its actual quantized
state differs from that prediction in **any** stored column — so skipping is
lossless by construction: "skipped" *means* "the prediction is exact".

This is the dominant size mechanism of the format: on the reference capture
65.7 % of all delta-frame unit records are skipped (stationary structures,
and units moving at constant velocity, cost zero bytes per frame), and a
frame where nothing died and nothing changed costs 3 bytes total.

Deaths must be explicit (the `nDead` list) precisely because absence from the
changed list means "unchanged", not "gone". A unit destroyed between samples
appears in the dead list of the next sampled frame (its destruction is also
logged in the `E` section). The decoded frame is the full live set —
survivors + changed — **sorted by unit id** (both input lists are sorted, so
this is a linear merge).

### 6.2 Value columns and prediction

Every value column entry is `svarint(actual − predicted)`. The prediction
depends only on the *same unit's* record in the previous frame (`prev`) and is
the same "advance" rule the decoder applies to skipped units:

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
| `build` | `prev.build` | 0 |
| `target` | `prev.target` | 0 |

`dvx`/`dvz` are the unit's **velocity displacement per sample interval**:
`round(velocity × sampleEvery)`, in whole elmos. Two things fall out of that
choice:

- The x/z predictor `prev.pos + prev.dv` is dead reckoning: a unit moving at
  constant velocity has a zero residual — and therefore, if nothing else about
  it changed, is skipped entirely (§6.1).
- `dv` is *exactly* the Hermite tangent the viewer uses to interpolate motion
  between samples, so no unit conversion happens at render time.

After each frame, the decoder's `prev` state is the frame just decoded —
including the re-materialised skipped units (state is per-chunk; see §5).

### 6.3 Worked example

A chunk's first three frames. `sv(v)` denotes the zigzag varint of `v`.

Frame 30 (the chunk's keyframe, stored in K — no prior state, so every unit
is in the changed list with absolute values):

| unit | def | team | x | z | hp | maxHp | dvx | dvz | build | target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 10 | 1 | 100 | 200 | 50 | 50 | 3 | 0 | 255 | 0 |
| 9 | 12 | 2 | 400 | 401 | 80 | 100 | 0 | 0 | 255 | 0 |

```
sv(30)                        // frame delta from 0 (the codec was just reset)
uv(0)                         // nDead
uv(2)                         // nChanged
ids:    sv(5)  sv(4)          // 5, then 9−5
def:    sv(10) sv(12)         // absolute (new ids)
team:   sv(1)  sv(2)
x:      sv(100) sv(400)
z:      sv(200) sv(401)
hp:     sv(50) sv(80)
maxHp:  sv(50) sv(100)
dvx:    sv(3)  sv(0)
dvz:    sv(0)  sv(0)
build:  sv(255) sv(255)
target: sv(0)  sv(0)
```

Frame 60 (the first frame of the chunk's delta stream, in F): unit 5 moved to
(103, 200), exactly its dead-reckoned position, nothing else about it changed
→ **unit 5 is not encoded at all**. Unit 9 took damage (80 → 60):

```
sv(30) uv(0)                  // +30 sim frames; nothing died
uv(1)  sv(9)                  // one changed unit: id 9
def:    sv(0)                 // 12 − 12
team:   sv(0)
x:      sv(0)                 // 400 − (400+0)
z:      sv(0)
hp:     sv(-20)               // 60 − 80
maxHp:  sv(0)
dvx:    sv(0)
dvz:    sv(0)
build:  sv(0)
target: sv(0)
```

The decoder reconstructs frame 60 as: unit 5 at (103, 200) — advanced by its
dv — and unit 9 with hp 60. 14 bytes for the frame (`sv(-20)` is 1 byte;
zigzag values ≥ 64 take 2).

Frame 90: unit 9 is destroyed; unit 5 still cruising:

```
sv(30)
uv(1)  sv(9)                  // dead: unit 9
uv(0)                         // nothing changed
```

4 bytes. The decoder drops unit 9 and advances unit 5 to (106, 200).

## 7. `X` — the extra section

Team economy, which the viewer reads once, whole, and decodes for the player
list and team statistics (`decodeEconomy` in app.js). Same frame
boundaries as the core codec, stored as a keyframe gzip stream + delta gzip
stream per chunk (§5); per frame, the decompressed stream is:

```
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

Incomes are per game-second. (Until v4 the stream additionally began with a
per-changed-unit `build` column; v5 moved it into the core columns so the
browser gets it.)

Since v5 the X stream decodes standalone: it is one record per sample, in
sample order, and needs nothing from the core stream. What it does NOT carry
is the sample's sim frame — that is in the core stream — so a standalone
reader keys records by sample position (record k of chunk i is the chunk's
k-th sample) and takes the frame number from the decoded frames. Deriving it
as `frame + k × sampleEvery` is wrong wherever a capture skipped a sample.
(Until v4 X began with per-changed-unit columns and could only be decoded
together with the core stream.)

## 8. Quantization and dropped fields

All quantization happens **once, at write time**; decoders return the
quantized values (there is no way, and no need, to recover the raw floats).

| Quantity | Stored as | Resolution |
| --- | --- | --- |
| Position x, z | whole elmos, `round()` | 1 elmo (the map is 10 000+ elmos across) |
| Health, max health | whole points, `round()` | 1 hp |
| Velocity (x, z) | displacement per sample interval: `round(vel × sampleEvery)` | 1 elmo / interval (= 1/30 elmo/frame at 1 Hz) |
| Build progress | `round(progress × 255)` | 1/255 |
| Build target | unit id, unquantized (0 = none) | exact |
| Resources (all six fields) | `round(value × 10)` | 0.1 metal/energy |
| Frame time | *not stored* — `t = frame / 30` | exact |
| Position y, velocity y | **not stored** (since v3) | decoded as 0 |

On decode, velocities come back as `dv / sampleEvery` (per sim frame, matching
the engine's `GetUnitVelocity` units), build as `build / 255`, resources as
`value / 10`.

y/dvy were dropped in v3 because they changed in ~28 % / ~23 % of all unit
records (a walking unit's height tracks the terrain under it every sample)
while nothing consumed them — the viewer renders the x/z plane, and a ground
unit's elevation is recoverable from the map heightmap at (x, z) if ever
needed. They were ~25 % of a v2 file. The BRSNAP source stream still carries
them, so a future format revision could reintroduce elevation (e.g. for air
units only) from the original captures.

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
-- v6 only (detected by bytes remaining after the team column):
count × svarint                  // cause unit:   the killer's unit id, -1 = unknown
count × svarint                  // cause def:    the killer's unit def
count × svarint                  // cause team:   the killer's team; for "given", the PREVIOUS owner
count × svarint                  // cause weapon: the weapon def that dealt the blow
```

Known kinds are `created`, `finished`, `destroyed` and (v6) `given` — a unit
changing owner, `team` the new one; the string table means new kinds can
appear without a format change. `selfd` is a player's ORDER to self-destruct (or,
given again while counting down, to stop — the engine toggles), read from the
demo's input stream at pack time: `def` is -1 and `team` the ordering
player's. An event whose four cause values are all -1
has no cause. A v5 section simply ends after the team column, so a v6 reader
needs no flag to tell them apart; the writer emits the cause columns whenever
there is at least one event. Events are stored in capture order
(non-decreasing frame), but the frame column is zigzag-coded so a
non-monotonic stream still round-trips.

### 9.1 `C` — the comms section

Everything the capture's players **wrote or drew**: chat messages and map
drawings, one record each, in capture order (non-decreasing frame). One gzip
stream for the whole capture, like `E`, and like `E` it is served to the
browser inside the head payload — the viewer needs the lot upfront to render
the chat transcript and to know which marks are on the map at any playhead.
Cheap: a real 33-minute 8v8 with 336 comms spends 3.8 KB, 0.2% of its file.

The source is normally the **demo's own packet stream** (see
`internal/demofile/comms.go`), which holds every side's chat on every channel
with exact frames; the capture stream's own records are the fallback when
there is no demo behind the pack.

The section is **absent** when a capture has no comms, which is what every
`.brp` packed from a pre-1.6.0 widget stream looks like. Readers must treat a
missing `C` as "none", never as an error.

```
uvarint  count
uvarint  nk                      // kind string-table size
nk × { uvarint len; len bytes }  // kind names, in order of first appearance
uvarint  nd                      // destination string-table size
nd × { uvarint len; len bytes }  // destination names (chat channels; "" for drawings)
count × svarint                  // frame:    delta vs previous comm's frame (from 0)
count × uvarint                  // kind:     index into the kind table
count × uvarint                  // dest:     index into the destination table
count × svarint                  // playerId: absolute (-1 = unresolved author)
count × {                        // positions, in WHOLE ELMOS:
  svarint                        //   x:  delta vs the previous comm's x (from 0)
  svarint                        //   z:  delta vs the previous comm's z (from 0)
  svarint                        //   x2: delta vs THIS comm's x
  svarint                        //   z2: delta vs THIS comm's z
}
count × { uvarint len; len bytes }   // text: message body / marker label, UTF-8
count × { uvarint len; len bytes }   // name: author's name, "" unless playerId is -1
```

Kinds are `chat`, `point`, `line` and `erase`; destinations (chat only) are
`all`, `ally`, `spec`, `private` and `lobby`. The string tables mean new ones
can appear without a format change.

Both position deltas exist for the same reason: **freehand drawing dominates**
the record count. Dragging the mouse emits a run of short `line` segments
walking across the map (the engine caps them at one per 50 ms), so both the
step from one segment to the next and the span of a single segment are small
numbers — one or two varint bytes each. A `chat` record, which uses no
positions at all, pays a handful of bytes for the columns it leaves at zero;
that is the deliberate trade, since chat is the rare record type.

Positions round to whole elmos: a map mark has no meaningful sub-elmo
precision. Everything else round-trips exactly.

**`erase` semantics.** An erase is recorded as an event, not applied at capture
time: it clears every mark whose ANCHOR (a `point`'s position, a `line`'s first
end) lies within **100 elmos** of it — `snapshot.CommEraseRadius`, the engine's
own hardcoded `CInMapDrawModel::EraseNear` radius. Consumers resolve it
themselves, which keeps the record faithful to what happened rather than to one
reader's idea of what should still be visible.

### 9.2 The analysis sections — `G`, `H`, `U`, `V`, `R`, `W`, `D`, `S` (v6)

Written only by a re-simulation (see `docs/brepstream-format.md`, protocol 4,
for what each record means and how the widget collects it), each one gzip
stream and each omitted when empty. Go accessors: `BRPFile.Facts`, `Hits`,
`UnitEnds`, `Visibility`, `Projectiles`, `Blasts`, `Damage`, `Lives`
(`snapshot/analysis.go`, `snapshot/projectiles.go`). `R` and `W` were added
inside v6: a reader that predates them skips the tags, so no version bump.

The file keeps SOURCE data: `H` and `U` are what the engine reported, and
everything concluded from them — damage per second, lifetime totals, who
gets the credit for a chain explosion, which blasts were big — is derived on
read by `internal/combat`, so it can change without re-simulating. `D` and
`S` are the sums older captures stored instead (with chain credit already
applied); they are still read.

**`H` — hits.** One row per damage callin, column by column. Ids as `id + 1`
(0 = unknown).

```
uvarint  hits
hits × svarint  frame (delta vs previous hit, from 0)
hits × uvarint  victim + 1      hits × uvarint victim def + 1
hits × uvarint  victim team + 1
hits × svarint  x (delta vs previous)   hits × svarint z (delta vs previous)
hits × uvarint  attacker + 1    hits × uvarint attacker def + 1
hits × uvarint  attacker team + 1       (as the engine named them)
hits × uvarint  weapon, coded as in D below
hits × uvarint  flags (bit 0 paralyzer, bit 1 the engine named a projectile)
hits × uvarint  projectile owner + 1    hits × uvarint projectile team + 1
hits × uvarint  damage × 10
hits × svarint  health right after the hit × 10 (negative: the overkill)
```

**`U` — unit ends.**

```
uvarint  count
per row:
  svarint  frame (delta)   uvarint unit + 1
  svarint  hit index (delta): hits recorded before this end
  svarint  x (delta)       svarint z (delta)
  uvarint  xp × 1000       uvarint flags (bit 0 alive at the end)
```

**`R` — projectile and beam tracks.** One row per track (see
`docs/brepstream-format.md`, protocol 5, for what a track is), sorted by birth
frame, then projectile id. Column by column; ids as `id + 1` (0 = unknown).

```
uvarint  rows
rows × svarint  birth (delta vs previous row, from 0)
rows × uvarint  end - birth
rows × uvarint  projectile id + 1
rows × uvarint  weapon + 1        rows × uvarint owner + 1
rows × uvarint  team + 1
rows × uvarint  class             rows × uvarint end kind
rows × uvarint  flags
rows × svarint  x0   rows × svarint y0   rows × svarint z0      launch, whole elmos
rows × svarint  vx × 100   vy × 100   vz × 100                 elmos per frame
rows × svarint  gravity × 100000                               elmos per frame²
rows × uvarint  target type (0, 'u', 'g', 'f', 'p')
rows × uvarint  target id + 1
rows × svarint  tx - x0   rows × svarint ty   rows × svarint tz - z0
rows × svarint  x1 - x0   rows × svarint y1   rows × svarint z1 - z0
rows × uvarint  path points
then each row's points in row order:
  uvarint  df (frames since birth)
  svarint  x - previous x   svarint y   svarint z - previous z
                            (the previous point; the launch for the first)
```

Velocity and gravity are quantized here (the stream carries them as f32):
velocity to 0.01 elmo per frame and gravity to 1e-5 elmo per frame², so an
arc rebuilt from them (`y(t) = y0 + vy·t + gravity·t(t+1)/2`, see the stream
doc) drifts at most ~1.5 elmos after 10 s of flight. Every other column is
exact. Rows are sorted by birth, then projectile id (then weapon, owner), so
a capture always packs to the same bytes.

Go: `BRPFile.Projectiles()` returns `[]snapshot.Projectile` — `Birth`, `End`,
`ID`, `Weapon`, `Owner`, `Team` (-1 = unknown), `Class` (`ProjNuke` … `ProjBeam`,
named by `ProjectileClassName`), `EndKind` (`TrackOpen`, `TrackExploded`,
`TrackVanished`), `Flags` (`TrackEngaged`, `TrackIntercepted`,
`TrackPathTruncated`; `Intercepted()`), launch `X0/Y0/Z0`, `VX/VY/VZ`,
`Gravity`, `TargetType` (the engine's byte, 0 none), `Target`, `TX/TY/TZ`,
end `X1/Y1/Z1`, `Path []PathPoint{DF, X, Y, Z}`. What each means — when a
launch is seen, why a track vanishes, how an interception is flagged, how a
beam's points are kept, which classes are steered and which fly an arc — is
in `docs/brepstream-format.md`, "Protocol 5", with real decoded rows.

Measured on four real 8v8 captures: `R` is 20–75 KB, 0.5–4.4% of the file.

**`W` — blasts.** One row per explosion the widget watched that ended no
track: kind 1, a unit's own death or self-destruct explosion (weapon strong
enough to be watched); kind 2, a projectile explosion with no open track
(cluster sub-munitions). Sorted by frame.

```
uvarint  rows
rows × svarint  frame (delta vs previous row, from 0)
rows × uvarint  weapon + 1
rows × svarint  x (delta)   rows × svarint y   rows × svarint z (delta)
rows × uvarint  unit + 1    rows × uvarint team + 1
rows × uvarint  kind
```

Go: `BRPFile.Blasts()` returns `[]snapshot.Blast` — `Frame`, `Weapon`,
`X/Y/Z`, `Unit`, `Team` (-1 = unknown), `Kind` (`BlastUnit` = 1: the unit
that exploded; `BlastStray` = 2: a projectile's owner). The weapon's strength
(damage per armour class, radius, falloff, blast-wave speed) is its entry in
the `wdefs` fact; what it hit is in `H`. Measured: 3–5 KB per capture.

**`G` — facts.** A JSON array of the widget's fact objects, verbatim (each
has `"k"`, its kind, and usually `"f"`, its frame). Kept verbatim so a new
kind needs no codec change.

**`D` — damage windows.** Ids are stored as `id + 1` (0 = unknown); amounts
in tenths of a hit point.

```
uvarint  windows
per window:
  svarint  frame (delta vs previous window, from 0)
  uvarint  rows
  rows × uvarint  attacker team + 1
  rows × uvarint  attacker def + 1
  rows × uvarint  weapon def + 1, or 2^20 + 1 + k for engine damage source k
                  (decoded weapon -1-k: 1 debris … 7 crushed; see brepstream §D)
  rows × uvarint  victim team + 1
  rows × uvarint  victim def + 1
  rows × uvarint  damage × 10 (health actually removed: a killing blow
                  counts only what the victim had left)
  rows × uvarint  paralyze damage × 10
  rows × uvarint  hits
```

**`S` — unit lives.** One row per unit ever recorded (they are few):

```
uvarint  count
per life:
  svarint  unit id (delta vs previous)
  uvarint  def + 1     uvarint team + 1
  svarint  born frame (delta vs previous)
  uvarint  0 = alive at the end, else (died - born) + 1
  uvarint  dealt × 10  uvarint taken × 10  uvarint kills
  uvarint  lowest health, % of max         uvarint xp × 1000
```

**`V` — visibility.** Change records: a unit's mask holds until a later record
restates it, and a record with `full` set restates every unit.

```
uvarint  records
per record:
  svarint  frame (delta)
  uvarint  flags (bit 0 = full restatement)
  uvarint  sides; sides × uvarint ally team + 1
  uvarint  units; units × svarint unit id (delta vs previous in the record)
  units × uvarint  mask — bit 2i = in side i's LOS, bit 2i+1 = in its radar
```

## 10. How a replay is served

The published replay IS the file: a publish (`viz.WriteStaticBundle`, used by
`pack -upload`, the ingest daemon and `cmd/barreplay-static`) uploads
`replays/<id>.brp` and nothing else, and the static/R2 deployment (see
`worker/`) serves it with HTTP Range support. The viewer reads it like this:

1. **The head**: `Range: bytes=0-262143`. That holds the header, `M`, and —
   since the writer puts them right behind it — `E` and `C` for any ordinary
   game. If `M` runs past the read, one more Range read fetches the rest of
   it; if `E`/`C` do, one more fetches both (they are adjacent in either
   writer order). A short 206 means the read reached the end of the file,
   which is then kept whole; so is a 200 from a server that ignored Range.
2. **The view** is derived from `M` in the browser: unit internal and human
   names, structure footprints, army costs, teams (plus `frameTeams`), players,
   bounds, and the chunk index with absolute ranges. Icons resolve against the
   viewer's own icon table (`/icons/icontypes.json`, generated from BAR's
   `icontypes.lua`) — it is fixed per BAR version, so it never rides in a
   replay.
3. **Keyframes**: the `K` payload's range, streamed through
   `DecompressionStream` and sliced at the cumulative `kLen` boundaries, so
   the whole timeline is scrubbable within the first seconds.
4. **Chunk *n***: `F[fOff : fOff+fLen]` at its absolute offset, decoded seeded
   with keyframe *n*. Not requested when `fLen == 0`.
5. **Economy**: the whole `X` payload, once (§7).

This zero-re-encoding property is the reason the keyframes section and each
chunk are independently gzipped: the server's cost per request is a byte-range
copy, and the storage format *is* the transfer format — which is also what
makes the no-server R2 deployment possible.

Replays published earlier are served from what was uploaded then, and keep
playing: a `BRW1` container at `/replays/<id>.brw` (same framing, version byte
= the file's; sections `J` — gzip(JSON) of exactly the view step 2 now derives,
with the chunk index reduced to `{frame, count, kLen, len, off}` and the `K`
range as `keys` — plus `E` and `C` byte-for-byte), the economy as JSON at
`/replays/<id>.resources`, and the frames either Range-read from
`/replays/<id>.brp` (heads with `keys`) or split into `/replays/<id>.keys`
and one `/replays/<id>/c<n>` per chunk (heads without). The viewer tries the
`.brp` first and falls back to the `.brw` when there is none. The JS decoder
still accepts version 4 there, so published v4 bundles keep playing.

## 11. Guarantees and non-guarantees

Implementations may rely on:

- **Determinism:** encoding the same capture (same meta, frames, events)
  produces a byte-identical file for a given writer version.
- **Chunk independence:** any chunk decodes from its keyframe (its indexed
  slice of K) plus its own delta byte range — nothing from any other chunk.
- **Full-frame decode:** every decoded frame contains the complete live unit
  set, sorted by id — delta-frame skipping is an encoding detail, invisible in
  the decoded data.
- **Round-trip fidelity:** decode(encode(capture)) preserves everything except
  (a) unit order within a frame (always sorted by id afterwards),
  (b) sub-quantization precision (§8),
  (c) `TimeSec`, which is re-derived as `frame/30`, and
  (d) `Pos.Y`/`VelY`, which are not stored and decode as 0.
- **Forward compatibility:** unknown section tags are skipped, and unknown
  JSON keys in `M` are ignored, so both can be extended without a version
  bump. Anything that changes how existing bytes must be *interpreted* —
  column set, column order, prediction rules, frame layout, chunk framing —
  requires incrementing the version byte, and readers reject versions they
  don't know (exactly what v3 did over v2, and v4 over v3).

Explicitly **not** guaranteed:

- Byte-stability *across* writer versions (a gzip level change alone breaks
  it). Determinism holds per build; the diff-two-runs workflow assumes both
  runs used the same binary.
- Any particular gzip compression level in files being read.
- The order of the sections after `M` (follow the layout or scan headers).

## 12. Reading a file, end to end

```
1. Read 4-byte magic "BRP1"; read version byte; reject unless 5 or 6.
2. Scan sections (tag, u32le length, payload) until EOF, remembering each
   payload's absolute offset. Skip unknown tags.
3. gunzip M; parse JSON → meta, bounds, counts, chunk index.
4. gunzip K (once; or stream it, slicing keyframes at the kOff/kLen
   boundaries as bytes arrive).
5. For whatever part of the timeline you need:
   a. Pick chunk i from the index (its "frame"/"count" map sim time ranges
      to chunks; t = frame/30).
   b. Decode keyframe i — K[kOff : kOff+kLen] — through a fresh codec (§6).
      For skimming, stop here: that IS the chunk's first frame.
   c. If fLen > 0: gunzip F[fOff : fOff+fLen] and decode it through the SAME
      codec: apply each frame's dead list, decode its changed units, advance
      every other live unit by its dv.
   d. (Optional, for resources:) gunzip the X keyframe and delta streams
      and decode per §7 — one record per sample, the frame number taken
      from the core decode.
6. gunzip E and decode per §9 when events are needed.
7. (v6) gunzip G/V/H/U (or D/S) when present and decode per §9.2.
```

Over HTTP, without the whole file: read the head of it, take `M` (first
section, its length at bytes 6–9), and place every other section with `M`'s
`sections` layout (§4) — then Range-read only what you need (§10).

Go entry points: `snapshot.ParseBRP` (steps 1–3, leaves sections compressed),
`BRPFile.DecodeChunk(i)` (step 4), `snapshot.ReadBRP` (everything).
