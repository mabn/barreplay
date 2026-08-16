# .brepstream — the Replay uploader widget's binary capture stream

The append-only stream `assets/lua/replay_uploader.lua` writes during a live
game (`<write-dir>/<gameId>.brepstream`). Decoder: `internal/capture/brep.go`
(`capture.ConsumeBrep`); `pack` converts it to `.brp`. A third, minimal
reader, `worker/src/worker/preamble.ts`, scans only the text preamble (header
line + GID/GAME) so the worker's `POST /api/upload` can validate and file a
dropped stream without decoding it. **The Lua encoder and Go decoder must
evolve in lockstep** (and the preamble scan with the preamble grammar); the
stream is versioned by its header line, and the widget copy on players'
machines can never be force-updated — readers must keep accepting every
version ever shipped. `tools/brep-harness/harness.lua` +
`TestBrepstreamMatchesTextFixture` (Go) + `worker/tests/preamble.test.ts` (TS)
pin the readers against one shared fixture.

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
| `F` | one sampled frame (below) |
| `E` | unit lifecycle event, text: `<frame> <kind> <id> <def> <team>` |
| `C` | a player comm — chat message or map drawing — JSON (widget ≥ 1.6.0; below) |
| `X` | end of stream, text: reason (`gameover`/`shutdown`/`error`) |
| other | reserved; readers skip unknown tags |

A stream without an `X` record was cut short (crash/kill); everything read
up to the truncation point is valid.

## `C` record — chat and map drawings

**This is the fallback source.** When a demo is available its packet stream
supersedes these records wholesale (`capture.ReplaceComms`), because the stream
is what the server broadcast: every channel of every side, framed exactly. See
`internal/demofile/comms.go`. What follows is what a capture with no demo
behind it — `pack -no-demo`, or a game the BAR API does not know — still gets,
and it is the only source for a live game before it is published.

JSON, not columns: comms are rare (hundreds per game against millions of unit
records) and their text is free-form, so the encoding that pays off everywhere
else buys nothing here. The same payload rides the `.brsnap` text stream as a
`BRSNAP COMM <json>` line, which is why one parser
(`capture.parseComm`) reads both.

```
{"f":<frame>,"k":"chat","p":<playerID>,"d":"all|ally|spec|private|lobby","t":"<text>"}
{"f":<frame>,"k":"point","p":<playerID>,"x":<x>,"z":<z>,"t":"<label>"}
{"f":<frame>,"k":"line","p":<playerID>,"x":<x>,"z":<z>,"x2":<x2>,"z2":<z2>}
{"f":<frame>,"k":"erase","p":<playerID>,"x":<x>,"z":<z>}
```

`p` is `-1` when the author is not a player of this game (a battleroom relay),
and only then does `n` carry their name — otherwise the preamble's `P` lines
name them. Absent keys default to zero/empty; `t` is omitted for an unlabelled
marker. Coordinates are world elmos, floats as the engine reported them (the
`.brp` codec rounds them to whole elmos later).

**Point of view.** Comms are as recorder-limited as unit visibility. The engine
fires the map-draw callin only for marks the client may see — its own ally
team's while playing, everyone's when spectating — and delivers chat only on
the channels the client receives. A re-simulated demo is watched by a full-view
spectator and therefore records every side; one player's live upload does not.

**Where the text comes from, and why the frame is approximate.** BAR's widget
handler does not forward `GotChatMsg`, so chat has no structured callin: the
widget reads `AddConsoleLine` and reverses the console grammar
`CGame::HandleChatMsg` prints (`<Name> …` / `[Name] …` / `> <Name> …`, channel
as a body prefix), accepting a line only when the name belongs to a player of
this game. Inline colour codes are stripped before writing;
`capture.sanitizeCommText` re-sanitizes and length-caps on the way in, since
the text is player-authored and ends up in a browser.

That callin does not fire when the chat arrives, either: the engine buffers
console lines and flushes them from `CGame::UpdateUnsynced`, the draw-side
chain a re-sim starves with `-throttle-draw`. The widget can only stamp the
frame it was handed the line on, and nothing in the Lua console API carries a
frame or timestamp (`Spring.GetConsoleBuffer` exposes text and level only).
Measured on a real re-sim, the flush rate — which the widget's own `draws=`
heartbeat counter reports — is a median 375 per 300 sim frames, but 1-6 over
the first couple of minutes of game time, so an early message can be stamped
several game-seconds late. Ordering is never wrong. This is the main reason
the demo is preferred wherever one exists.

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
                    bit 1: the target column is present (widget >= 1.4.0)
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
u16[]  target      unit id being built/assisted (GetUnitIsBuilding; 0 = none)
                   — present only when flags bit 1 is set; older streams
                   decode with every target = 0
```

Then `u16[nDead]` dead unit ids, then resources (absent when `nRes` is 0):

```
u8[nRes]   team
f32[nRes]  metal      (raw, unquantized; 6 columns in this order)
f32[nRes]  energy
f32[nRes]  metalStorage
f32[nRes]  energyStorage
f32[nRes]  metalIncome    (per game-second; see the protocol note below)
f32[nRes]  energyIncome
```

Income semantics are versioned by the `GAME` line's `protocol` field: the
engine's `GetTeamResources` income return is already per game-second (it
accumulates over `TEAM_SLOWUPDATE_RATE` = 30 sim frames = 1 game-second), and
**protocol >= 3** streams write it as-is. Protocol <= 2 widgets multiplied it
by `gameSpeed` on the wrong assumption it was per sim frame, so their stored
income is 30x too high; the decoder repairs those streams (and `.brsnap`
streams with no `GAME` line at all) by dividing the factor back out
(`repairIncome` in `internal/capture/lines.go`).

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
same def/team/hp/maxHp/dvx/dvz/build/target and `x == prev.x + dvx`,
`z == prev.z + dvz` — in the quantized domain. The encoder then advances its
own mirror state by the same rule, so encoder and decoder states are equal by
construction and cannot drift; there is no accumulated error, and a restated
unit is always absolute (no varint deltas — that is `.brp`'s job; `pack`
re-encodes).

Restated-unit values are absolute rather than delta-coded on purpose: the size
win comes overwhelmingly from *omitting* predicted units (~2/3 of records in a
real game), and absolute columns keep both the Lua encoder and the Go decoder
trivial.

## Enemy units (widget ≥ 1.1, `recordEnemies`)

Semantics only — the wire format above is unchanged, and no reader needs to
know. When the emitting widget records enemy units (the `recordEnemies` GAME
field, default on), a frame's unit set is *what the recording client's
sensors report that sample*, not ground truth: enemy units appear while the
engine lists them in `GetAllUnits` (LOS, radar, or the engine's own
radar-memory dot), and a unit the engine stops listing **disappears from the
stream on that very sample** — its id goes on the frame's dead list with no
`destroyed` event (no death was witnessed; the unit may be alive in fog) and
it is simply recorded afresh under the same id if it is ever listed again.

Widgets 1.1–1.4 instead kept a vanished enemy in the stream **frozen at its
last-known state** with `dvx = dvz = 0` (a "ghost"), dropped only when seen
dying or its spot was scouted empty (a budgeted `IsPosInLos` check, widget
≥ 1.3.0); an enemy that died in fog nobody revisited stayed a ghost to the
end of the stream. Streams from those widgets still decode unchanged — the
persistence was baked into the frames by the emitter, not the format.

A witnessed death buries the
id for good (widget ≥ 1.1.1): the engine can keep returning a dead enemy's id
from `GetAllUnits` — a frozen radar-memory dot survives a death the player
did not see in LOS — so the widget tombstones the id at `UnitDestroyed` and
skips it until it is demonstrably a NEW unit reusing the id (readable
**positive** health, changed def/team, or a position away from the death
spot).

A killed unit is also readable *as itself* for a moment (widget ≥ 1.2.0): the
engine deletes it only once its death sequence finishes, and a morph kills it
at full health, so the sample right after `UnitDestroyed` can still find it in
`GetAllUnits`. Treating that read as "alive, so the id was reused" un-buried
the corpse and froze it into every later frame at 0 hp — a real 8v8 capture
ended with 57 dead units standing, one of them six minutes past its own
recorded death. So health of 0 no longer counts as proof of life (a live unit
never reads ≤ 0), `Spring.GetUnitIsDead` is consulted where the engine offers
it, and a unit sampled at 0 hp is buried on the spot even if no `UnitDestroyed`
ever arrived (the widget can be reloaded across a death). Streams written by
older widgets are repaired at decode time: `internal/capture` buries every id
the stream's own `destroyed` events name and drops its later records unless one
restates it with positive health (`graveyard`, lines.go). `def` 0 means a radar
contact never identified (there is no unit-def 0); once the unit is typed the
def/team columns upgrade in place, and identity/health are carried over a
later radar-only phase rather than degrading back to 0. Radar-only positions
are the engine's wobbled readings.

## Preamble

Identical line grammar to `.brsnap` so `internal/capture`'s parser is shared:
`GID` (the 32-hex gameId, always the first line after the header), `GAME`
(JSON: protocol, widgetVersion (semver of the emitting widget), mode
live/replay, map, game/engine versions, sampleEvery, gameSpeed, recordEnemies
(whether the stream carries enemy units — see above), recording
player id/allyTeam/spectator), `DEF` (full unit-def
JSON), `T`, `P`, `READY`. The `GAME` line's `sampleEvery`/`gameSpeed` feed
velocity de-quantization and frame timestamps (`t = frame/gameSpeed`), and its
`protocol` selects the resource-income semantics (>= 3: written as the engine
reports it; <= 2 or absent: over-scaled by gameSpeed, repaired at decode — see
the frame-record section); metadata seeded by the caller (e.g. from the demo)
wins over `GAME` values.
