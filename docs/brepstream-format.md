# .brepstream — the Replay uploader widget's binary capture stream

The append-only stream `assets/lua/replay_uploader.lua` writes during a live
game (`<write-dir>/<gameId>.brepstream`). Decoder: `internal/capture/brep.go`
(`capture.ConsumeBrep`); `pack` converts it to `.brp`. A third reader,
`worker/src/breps/split.ts`, slices the stream into static R2 pieces without
decoding frame semantics (it walks the record framing and the text preamble
only). **The Lua encoder, Go decoder, and TS splitter must evolve in
lockstep**; the stream is versioned by its header line, and the widget copy
on players' machines can never be force-updated — readers must keep accepting
every version ever shipped. `tools/brep-harness/harness.lua` +
`TestBrepstreamMatchesTextFixture` (Go) + `worker/tests/split.test.ts` (TS)
pin the lockstep against one shared fixture.

Design goals, in order: cheap to write from Lua mid-game (no per-unit
`string.format`, a handful of `VFS.Pack*` C calls per sample), small (delta
encoding: an unchanged unit costs zero bytes), crash-tolerant (append-only;
a truncated tail record is dropped, everything before it parses). Measured
~6.5x smaller than the equivalent `.brsnap` text raw, and ~4x cheaper per
sample (1.8 ms vs 7 ms at 2000 units, Lua 5.1).

## Layout

```
line  "BREPSTREAM 1"                      format header (version 1)
text  preamble: BRSNAP GID/GAME/DEF/T/P lines (same grammar as .brsnap),
      terminated by the "BRSNAP READY" line
then  binary records until EOF:  <tag u8> <len u32le> <payload[len]>
```

All integers little-endian. Record tags:

| tag | payload |
|-----|---------|
| `C` | command state (protocol 3+, below); precedes its `F` record |
| `F` | one sampled frame (below) |
| `E` | unit lifecycle event, text: `<frame> <kind> <id> <def> <team>` |
| `X` | end of stream, text: reason (`gameover`/`shutdown`/`error`) |
| other | reserved; readers skip unknown tags |

A stream without an `X` record was cut short (crash/kill); everything read
up to the truncation point is valid.

## Segments (widget disable/enable, rejoin)

A file may contain **multiple segments**, each a full `header line + preamble
+ records` block, concatenated. The header line read where a record tag is
expected (first byte `B`, which is never a record tag) marks the restart; the
decoder re-scans the preamble (picking up a possibly different
`sampleEvery`/`gameSpeed` — the re-enabled widget can even be a newer
version), resets all unit state, and continues. The first frame of a segment
is always a keyframe (fresh encoder state).

Why: a player can disable and re-enable the widget mid-game. The `GameID`
callin fires only at game start, so the re-enabled instance recovers the id
from its saved widget config (`Get/SetConfigData`, guarded by map + game
version + a monotonic frame check) and **appends** a new segment — truncating
would destroy the only copy of the earlier game. A **rejoining** client
(crash, restart) instead re-simulates the whole game from frame 0 and
re-records everything, so at open time the widget distinguishes the cases by
the current frame: near zero → truncate (supersede the stale file), mid-game
→ append. Segments written this way never overlap in frames; the decoder
still guards (a frame ≤ the last emitted one is decoded for state but not
emitted) so downstream writers always see a monotonic frame sequence.

## `F` record

```
u32  frame          sim frame (30/s)
u8   flags          bit 0: keyframe
u16  nUnits         units restated in this record
u16  nDead          dead-list length (0 in keyframes)
u8   nRes           team-resource rows
```

Then columns, each an array of `nUnits` values (absent when `nUnits` is 0):

```
u16[]  id          unit id
u16[]  def         unit-def id
u8[]   team        owning team
s16[]  x           position, whole elmos (round(x))
s16[]  z
u32[]  hp          health, whole points (round(hp))
u32[]  maxHp
s16[]  dvx         velocity as displacement per sample interval:
s16[]  dvz         round(vel * sampleEvery) — same as .brp
u8[]   build       build progress, round(build * 255)
```

Then `u16[nDead]` dead unit ids, then resources (absent when `nRes` is 0):

```
u8[nRes]   team
f32[nRes]  metal      (raw, unquantized; 6 columns in this order)
f32[nRes]  energy
f32[nRes]  metalStorage
f32[nRes]  energyStorage
f32[nRes]  metalIncome    (per game-second)
f32[nRes]  energyIncome
```

Quantization matches `.brp`'s storage precision (whole elmos/hp, per-interval
velocity displacement, build 1/255); `y`/`vy` are not stored at all, exactly
like `.brp`. Rounding is `floor(v+0.5)` — this only defines the encoder; the
decoder never re-derives quantized values.

## Keyframes and deltas (the codec)

The decoder keeps one record per live unit (the quantized columns above).

- **Keyframe** (`flags & 1`): the record carries **every** visible unit; the
  decoder discards all prior state first. A unit missing from a keyframe is
  gone — no dead entry needed. The widget emits a keyframe every
  `keyframeEvery` (64) samples, bounding crash loss and making the stream
  re-synchronizable.
- **Delta frame**: carries only units that diverged from their prediction,
  plus the dead list. To reconstruct the frame: (1) remove dead ids, (2) for
  every tracked unit NOT restated in this record apply the prediction
  `x += dvx, z += dvz` (all other columns carry over), (3) upsert the restated
  units with their absolute column values (a new id is a new unit).

A unit is omitted by the encoder iff **all** columns match its prediction:
same def/team/hp/maxHp/dvx/dvz/build and `x == prev.x + dvx`,
`z == prev.z + dvz` — in the quantized domain. The encoder then advances its
own mirror state by the same rule, so encoder and decoder states are equal by
construction and cannot drift; there is no accumulated error, and a restated
unit is always absolute (no varint deltas — that is `.brp`'s job; `pack`
re-encodes).

Restated-unit values are absolute rather than delta-coded on purpose: the size
win comes overwhelmingly from *omitting* predicted units (~2/3 of records in a
real game), and absolute columns keep both the Lua encoder and the Go decoder
trivial.

## `C` record — command state (protocol 3, widget ≥ 1.2, `recordCommands`)

Each sample the widget also captures, for every unit whose command queue is
readable — the recorder's own ally team, or everything under full-view
spectating; **never** enemies/ghosts, their queues read back nil — the front of
the unit's command queue (`Spring.GetUnitCurrentCommand`) and the unit it is
currently nanolathing (`Spring.GetUnitIsBuilding`, which also catches a nano
turret auto-assisting on an empty queue). The `C` record is emitted immediately
**before** its paired `F` record (same `frame`), so a decoder attaches command
state to the frame it is about to emit. Old readers skip the unknown tag; the
header line stays `BREPSTREAM 1`.

```
u32  frame          sim frame (same as the paired F record)
u8   flags          bit 0: keyframe (mirrors the paired F)
u16  nCmd           command rows restated
u16  nClear         ids cleared to idle (0 in keyframes)
```

Then columns of `nCmd` values, then `u16[nClear]` cleared ids:

```
u16[]  id           unit id
u32[]  cmd          zigzag-encoded engine command id ((cmd<<1)^(cmd>>31));
                    negative = build order for unit-def -cmd; 0 = empty queue
                    (a buildee-only row)
u16[]  tgt          target unit id (0 = none)
s16[]  tx           target position, whole elmos (0 when none)
s16[]  tz
u16[]  bt           current buildee unit id (0 = none)
```

Exactly one of `tgt` / (`tx`,`tz`) is meaningful, decided by the command's
parameter shape at capture time: one parameter → `tgt` (guard/repair/
attack-unit/...), three or more → `tx`/`tz` from params 1 and 3 (move/patrol/
fight/build/area commands). The decoder keeps one tuple per **non-idle** unit
under the same discipline as the unit codec: a keyframe `C` discards all
command state and restates every non-idle unit; a delta `C` removes the
cleared ids, upserts the restated rows, and every unmentioned unit carries its
tuple unchanged (commands don't move — an unchanged command costs zero bytes).
A unit with an empty queue and no buildee is idle and has no state at all. A
unit on the `F` dead list drops its command state with it. The widget emits a
row only when the unit's whole quantized tuple changed (always at keyframes).

The text stream's equivalent is one `BRSNAP C <id> <cmd> <tgt> <tx> <tz> <bt>`
line per non-idle unit per sampled frame — the **full current state**, no
deltas (text is the stateless debug/reference format). The fixture test
cross-checks the reconstructed binary state against that dump exactly (the
tuples are all-integer, quantized identically before both emitters).

`worker/src/breps/split.ts` (parked) skips `C` records, so split pieces drop
command data; extend it alongside the planned transcoder if that path revives.

## Enemy units and ghosts (widget ≥ 1.1, `recordEnemies`)

Semantics only — the wire format above is unchanged, and no reader needs to
know. When the emitting widget records enemy units (the `recordEnemies` GAME
field, default on), a frame's unit set is *what the recording client knew*,
not ground truth: enemy units appear while in LOS or on radar, and a unit that
leaves visibility stays in the stream **frozen at its last-known state** with
`dvx = dvz = 0` (a "ghost") — exactly the delta codec's zero-byte predicted
case — until it is seen again or seen dying. Only witnessed deaths reach the
dead list (`UnitDestroyed` fires only for visible units); an enemy that dies
unseen remains a ghost to the end of the stream. `def` 0 means a radar
contact never identified (there is no unit-def 0); once the unit is typed the
def/team columns upgrade in place, and identity/health are carried over a
later radar-only phase rather than degrading back to 0. Radar-only positions
are the engine's wobbled readings.

## Preamble

Identical line grammar to `.brsnap` so `internal/capture`'s parser is shared:
`GID` (the 32-hex gameId, always the first line after the header), `GAME`
(JSON: protocol (3 = command state recorded, see the `C` record), widgetVersion
(semver of the emitting widget), mode
live/replay, map, game/engine versions, sampleEvery, gameSpeed, recordEnemies
(whether the stream carries enemy units/ghosts — see above), recordCommands
(whether `C` records are present), recording
player id/allyTeam/spectator), `DEF` (full unit-def
JSON), `T`, `P`, `READY`. The `GAME` line's `sampleEvery`/`gameSpeed` feed
velocity de-quantization and frame timestamps (`t = frame/gameSpeed`);
metadata seeded by the caller (e.g. from the demo) wins over `GAME` values.
