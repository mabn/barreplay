# .brepstream — the widget's binary capture stream

The append-only stream `assets/lua/replay_uploader.lua` writes, both during a
live game (`<write-dir>/<gameId>.brepstream`) and — since widget 1.8.0, when
the Go tool injects the same file with its re-simulation switches
substituted — during a headless re-simulation (to the path `cmd/barreplay` /
`internal/resim` hand it). It replaced the `.brsnap` text stream, which
nothing writes or reads any more. Decoder: `internal/capture/brep.go`
(`capture.ConsumeBrep`); `pack` converts it to `.brp`. A third, minimal
reader, `worker/src/worker/preamble.ts`, scans only the text preamble (header
line + GID/GAME) so the worker's `POST /api/upload` can validate and file a
dropped stream without decoding it. **The Lua encoder and Go decoder must
evolve in lockstep** (and the preamble scan with the preamble grammar); the
stream is versioned by its header line, and the widget copy on players'
machines can never be force-updated — readers must keep accepting every
version ever shipped. `tools/brep-harness/harness.lua` +
`TestHarnessGolden` (Go; one fixture per mode, each decoded and compared
line by line against a committed dump) + `worker/tests/preamble.test.ts` (TS)
pin the readers against the shared fixtures.

Design goals, in order: cheap to write from Lua mid-game (no per-unit
`string.format`, a handful of `VFS.Pack*` C calls per sample), small (delta
encoding: an unchanged unit costs zero bytes), crash-tolerant (append-only;
a truncated tail record is dropped, everything before it parses). Measured
~6.5x smaller than the retired `.brsnap` text stream, and ~4x cheaper per
sample (1.8 ms vs 7 ms at 2000 units, Lua 5.1).

## Layout

```
line  "BREPSTREAM 1"                      format header (version 1)
text  preamble: BRSNAP GID/GAME/DEF/T/P lines (the old .brsnap line grammar),
      terminated by the "BRSNAP READY" line
then  binary records until EOF:  <tag u8> <len u32le> <payload[len]>
```

All integers little-endian. Record tags:

| tag | payload |
|-----|---------|
| `F` | one sampled frame (below) |
| `E` | unit lifecycle event, text: `<frame> <kind> <id> <def> <team>`, plus — protocol ≥ 4 — optional `<aID> <aDef> <aTeam> <weapon>` (below) |
| `C` | a player comm — chat message or map drawing — JSON (widget ≥ 1.6.0; below) |
| `G` | a game fact, JSON (protocol ≥ 4; below) |
| `H` | every damage callin (re-sim only; below) |
| `U` | where unit lives ended (re-sim only; below) |
| `V` | per-side visibility (re-sim only; below) |
| `R` | closed projectile and beam tracks (re-sim only, protocol ≥ 5; below) |
| `B` | strong explosions: unit deaths and unmatched impacts (re-sim only, protocol ≥ 5; below) |
| `P` | engine profiler reading, JSON (re-sim only; below) |
| `D` | a damage window (older re-sims only; below) |
| `S` | unit lifetime totals (older re-sims only; below) |
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
else buys nothing here. `capture.parseComm` reads it.

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
income is 30x too high; the decoder repairs those streams (and streams with
no `GAME` line at all) by dividing the factor back out
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

## Protocol 4: re-simulation records and event causes (widget ≥ 1.8.0)

One widget file serves both modes. The Go tool substitutes `__RESIM__=1` and
the switches below when it injects it; every switch is tested against the
literal `"1"`, so the published copy (tokens left in place) is the uploader.
The `GAME` line carries `"resim":true` in that mode, and the decoder then
records no recorder and no widget build — the capture is the spectator view
and its widget is not something a player installed.

A re-simulation additionally: records units at `hp <= 0` rather than burying
them (the decoder's graveyard drops them once their destroyed event is
written — a crashing aircraft is drawn grey until then), sees everything
(`spectatorfullview 1`), runs at max speed, disables BAR's widget suite, and
quits at game over.

**`E` cause columns.** A `destroyed` event may carry the killer
`<aID> <aDef> <aTeam> <weapon>` (weapon = weapon-def id), `-1` where the
engine gave nothing; absent columns and all-`-1` both mean "unknown". The
live uploader never writes a killer (a playing client is not handed one for
units it cannot see, and it would be one-sided anyway). A new kind, `given`,
records a unit changing owner: `<team>` is the new owner and `<aTeam>` the
old one (the other three are `-1`). `UnitTaken` is not recorded — it is the
same transfer seen from the other side.

**`G` — game facts.** One JSON object per fact; `"k"` names it, `"f"` is its
sim frame when it has one. Both modes write the first three:

| kind | fields |
|------|--------|
| `end` | `f`, `winners` — the winning ALLY teams (empty: a draw) |
| `teamdied` | `f`, `team` |
| `playerleft` | `f`, `player`, `reason` (the engine's PlayerRemoved reason) |
| `wdefs` | `defs`: `[{id, name, description, type, range, reload, damage, paralyzer, aoe}]` — the weapon table (re-sim only, written once at start). Protocol ≥ 5 adds the explosion and flight keys to every weapon the capture **watches** (see `R`/`B` below) |
| `stock` | `f`, `unit`, `def`, `team`, `w` (weapon slot, 1-based), `old`, `n` — a stockpile count changed: a round finished building (`n > old`) or was fired (`n < old`). Protocol ≥ 5, re-sim only, only for stockpiled weapons the capture tracks |
| `blast` | `f`, `unit`, `def`, `team`, `x`, `z`, `weapon`, `byUnit`/`byDef`/`byTeam`, `damage`, `kills` — one big death explosion. No longer written: big blasts are derived from `H` (`snapshot.FactBlastData` is what `internal/combat` reports them as) |
| `teamstats` | `team`, `fields`, `rows` — the engine's `GetTeamStatsHistory` for the team, one row per stats interval (re-sim only, at game over) |

Facts are kept verbatim through the `.brp`, so a kind added here needs no
codec change.

**`H` — hits** (`__DAMAGE__`). Every damage callin, written as the engine
delivered it: the widget draws no conclusions. Crediting a chain of
exploding reactors to whoever killed the first one, removing overkill,
picking out the big blasts and summing damage per second and per unit are
all done when the file is READ (`internal/combat`), so they can change
without re-simulating a game. Hits are buffered and written once per
sample, before the frame record, covering the frames since the previous one.

```
u32 frame                         the window's first frame
u32 n                             hits
then n rows as COLUMNS:
  u16 df (frame - window)   u16 victim   u16 vDef   u8 vTeam
  u16 x   u16 z                     victim position, whole elmos
  u16 attacker   u16 aDef   u8 aTeam  as the engine named it
  u16 weapon
  u16 projOwner   u8 projTeam
  u8  flags                         bit 0 paralyzer, bit 1 the engine named a projectile
  f32 damage   f32 hpAfter          health right after the hit
```

Unknown ids are 255 (u8) / 65535 (u16). The seven `weapon` values just
below 65535 are damage the engine dealt itself, `65535 - k` for Recoil's
`CSolidObject::DamageType` k (the engine passes weaponDefID `-k`): 1 debris,
2 ground collision, 3 object collision, 4 fire, 5 water (lava), 6 killed by
Lua, 7 crushed. Decoders report these as weapon `-1 - k` (-2..-8).

`hpAfter` below zero is the overkill: the health the hit actually removed
is `damage + hpAfter` then. The engine names NO attacker for a unit's death
or self-destruct explosion, and sometimes names the exploding unit itself;
the victim's position and the unit defs' explosion weapons (DEF
`deathWeapon`/`selfdWeapon`, the `wdefs` fact's `aoe`) are what lets a
reader tell which dead unit a blast came from. `projOwner`/`projTeam` are
read off the projectile (`GetProjectileOwnerID`/`GetProjectileTeamID`) only
when the engine named no attacker: it resolves the attacker from the
shooter, which is gone once the shooter has died, so a shell still in flight
then arrives anonymously while the projectile still knows who fired it.

**`U` — unit ends** (`__DAMAGE__`). Where each unit's life ended: a row per
death, at the death, and one per survivor at game over. Flushed with `H`.

```
u32 frame   u32 n
then n rows as COLUMNS:
  u16 df   u16 unit
  u32 hit                           hits recorded before it: orders it exactly among them
  u16 x   u16 z   f32 xp
  u8  flags                         bit 0 alive at the end
```

A death's killer is on its `destroyed` event, also exactly as the engine
gave it.

**`D` — damage windows** and **`S` — unit lives** are what the widget wrote
before `H`/`U`: sums it computed itself, with chain explosions already
credited (D: `u32 frame, u16 n`, then columns `u8 aTeam, u16 aDef, u16
weapon, u8 vTeam, u16 vDef, f32 damage, f32 paralyze, u16 hits`, and in the
earliest streams a trailing `f32 overkill` the decoder subtracts; S: `u32
frame, u16 n`, then columns `u16 id, u16 def, u8 team, u32 born, u32 died
(0xFFFFFF = alive), f32 dealt, f32 taken, u16 kills, u8 minHp, f32 xp`).
Nothing writes them now; decoders still read them. The `blast` fact is the
same story.

**Every integer the widget writes stays below 2^24.** Spring's Lua numbers
are single-precision floats, which hold integers exactly only up to 2^24, and
`VFS.PackU32` converts whatever it is handed: 0xFFFFFFFF rounded to 2^32 and
was written as 0. That is why the old S alive marker was 0xFFFFFF, why U's
`hit` caps at 2^24 hits, and why the visibility
mask is two u16 halves rather than one u32 (decoders still accept 0xFFFFFFFF
as alive). The test harness refuses to pack a value a float cannot hold.

**`V` — visibility** (`__VISIBILITY__`). Which sides could see each unit, by
LOS or radar, once per sample. Only units that are new or whose mask CHANGED
are written;
every keyframe sample restates all (flag bit 0), and a sample with no change
writes no record at all.

```
u32 frame   u8 flags (bit0 = full restatement)
u8  nAllies   u8 allies[nAllies]          the sides the masks index, gaia excluded, at most 16
u16 n   u16 ids[n]   u16 lo[n]   u16 hi[n]
```

Each mask is `lo | hi << 16` and holds two bits per side, in `allies` order:
bit `2i` = in LOS of side `i`, bit `2i+1` = in its radar. A unit that leaves the frame (dead, or
gone) needs no V row: the frame's own dead list says so.

**`P` — profiler.** JSON
`{"f":frame,"u":units,"final":bool,"r":[[name,ms],...]}` — the engine's time
profiler: the game-over totals (`final`, top 80 scopes, every re-sim), plus a
reading at every heartbeat (top 30) under `-profile`. The Go
tool prints them; they never reach the `.brp`.

## Protocol 5: projectiles, beams and strong explosions (widget ≥ 1.9.0)

Re-simulation only, behind the `__PROJECTILES__` switch (`cmd/barreplay
-projectiles`, default on). Purely additive: a protocol-4 decoder skips the
two new record types and keeps the new fact keys verbatim. The design and the
engine behaviour it relies on are in `docs/projectiles-and-explosions.md`.

**What is watched.** Decided once, at `Initialize`, from `WeaponDefs` (never
from unit names: mods change the numbers). A weapon is **tracked** when it
falls in one of these classes, in this order (`damage` = `damages[0]`, the
whole shot; `range` in elmos):

| class | code | rule |
|---|---|---|
| — | | `customParams.bogus` (silo dummies, energy chargers): never |
| `antinuke` | 2 | `interceptor ≠ 0` |
| `juno` | 5 | `customParams.junotype` |
| `nuke` | 1 | `customParams.nuclear` and `range ≥ 10000` |
| `tactical` | 4 | `customParams.nuclear` (shorter range) |
| `beam` | 8 | `BeamLaser`/`LightningCannon`, `damage ≥ 2000`, `range ≥ 600` (an EMP beam is a beam) |
| `emp` | 3 | `paralyzer`, `damage ≥ 5000` |
| `tactical` | 4 | `stockpile` and `range ≥ 1500` (Perdition) |
| — | | `damage ≤ 1` (AA, utility): never |
| `artillery` | 6 | `Cannon`, `range ≥ 1500` |
| `rocket` | 7 | `StarburstLauncher`/`MissileLauncher`, `range ≥ 1000` |

A weapon is a **blast** weapon when a unit def names it as its
`deathExplosion` or `selfDExplosion` and it is strong: `damage ≥ 400` **and**
`damageAreaOfEffect ≥ 64` (the radius). That keeps fusions, metal makers,
commanders, Juggernauts, crawling bombs, mines and big buildings, and drops
the ordinary unit-death puffs (measured on a 60-minute 8v8: 2,535 of 100,066
exploding deaths kept). Every tracked weapon's `customParams.cluster_def`
sub-munition is watched too. The thresholds are constants in the widget, and
each watched weapon's `wdefs` entry says which role it was watched in.

**`R` — projectile and beam tracks.** One row per projectile of a tracked
weapon, from launch to its end; one row per **firing** of a tracked beam. A
row is written when its track closes. Rows are buffered and flushed once per
sample, before the frame record, like `H`.

```
u32 n                               rows
then n rows as COLUMNS:
  u32 birth   u32 end               sim frames: launch (a beam's first frame), and
                                    the explosion / last frame seen
  u32 id                            the projectile's id (a beam: the segment id of its
                                    first hit, 0xFFFFFF if it never hit); ids are
                                    recycled, so (id, birth) names a track
  u16 weapon  u16 owner  u8 team    weapon def; launcher unit and its team at launch
  u8  class                         code from the table above
  u8  end kind                      0 still open at game over, 1 exploded (an Explosion
                                    callin carried its id; a beam: it hit something),
                                    2 vanished (gone with no explosion; a beam: never hit)
  u8  flags                         bit 0 engaged: an interceptor targeted it
                                    (GetProjectileIsIntercepted read true)
                                    bit 1 intercepted: destroyed by the interceptor
                                    that targeted it
                                    bit 2 path truncated at the point cap
  s16 x0  s16 y0  s16 z0            launch position, whole elmos (a beam: its muzzle)
  f32 vx  f32 vy  f32 vz            launch velocity, elmos per frame (0 for a beam)
  f32 gravity                       the projectile's per-frame gravity (GetProjectileGravity)
  u8  targetType                    0 none, or the engine's byte: 'u' unit, 'g' ground,
                                    'f' feature, 'p' projectile
  u32 target                        unit / feature / projectile id; 0xFFFFFF none
  s16 tx  s16 ty  s16 tz            where the target was at launch
  s16 x1  s16 y1  s16 z1            end position (explosion, or last seen; a beam:
                                    its last hit point)
  u16 points                        path points this row contributes
then every row's path points, concatenated in row order, as COLUMNS:
  u16 df   s16 x   s16 y   s16 z    df = frames since birth
```

Path points: `nuke`, `antinuke`, `emp`, `tactical` and `juno` tracks sample
the projectile's position every 10 frames; a beam keeps its hit points (the
first, every 5th frame, any that jumped more than 64 elmos from the last kept
one, and the last); everything else stores none, since the arc follows from
the launch velocity and gravity. At most 400 points per row (flag bit 2).

Unknown ids are 65535 (u16), 255 (u8), 0xFFFFFF (u32; every value stays
below 2^24 — see above). How a launch is found: the widget watches each
tracked launcher's `reloadFrame`, which changes exactly when the weapon
fires, and in that frame's `GameFramePost` picks the new projectile out of a
`GetProjectilesInSphere` query around the muzzle, by owner and weapon def.
How a track ends: the `Explosion` callin, which LuaUI may watch itself
(`Script.SetWatchExplosion`) and which carries the projectile id; a sweep every
15 frames closes tracks whose projectile is gone with no explosion. A nuke
whose explosion falls within a frame of the explosion of an interceptor whose
target was that nuke is flagged intercepted.

**`B` — blasts.** One row per explosion of a watched weapon that is not the
end of an `R` track: a unit's death or self-destruct explosion (of a blast
weapon), or a tracked weapon's or sub-munition's explosion no track was open
for (cluster sub-munitions, which a gadget spawns at the impact). Buffered and
flushed with `H`.

```
u32 frame   u32 n
then n rows as COLUMNS:
  u16 df (frame - window)   u16 weapon
  s16 x   s16 y   s16 z             where it went off, whole elmos
  u16 unit  u8 team                 kind 1: the unit that exploded; kind 2: the owner
  u8  kind                          1 unit explosion (death or self-destruct — the
                                    weapon says which), 2 projectile with no track
```

The engine makes a unit's death explosion with the dying unit as owner and no
projectile, and only when the unit was finished and not reclaimed
(`CUnit::ForcedKillUnit`). What a blast did is in `H`: the hits of its weapon
around (x, z) from its frame on, since damage further out arrives
`distance / explosionSpeed` frames later.

**`wdefs` keys for watched weapons (protocol ≥ 5).** Present only on weapons
the capture watches, so the fact stays small (about 540 of 2,900 weapons in a
modded game):

| key | meaning |
|---|---|
| `role` | `"track"`, `"blast"`, `"sub"` (a cluster sub-munition) |
| `class` | the track class name (tracked weapons) |
| `edge`, `expSpeed` | `edgeEffectiveness`, `explosionSpeed` |
| `crater`, `impulse` | `craterAreaOfEffect`, `damages.impulseFactor` |
| `damages` | `{armorName: damage}` for the armour classes that differ from `damage` |
| `paralyzeTime` | `damages.paralyzeDamageTime`, when a paralyzer |
| `stockpile`, `stockpileTime` | when stockpiled |
| `interceptor`, `targetable`, `coverage` | bitmasks and the protected radius (anti-nukes, nukes) |
| `salvo`, `salvoDelay`, `projectiles` | shots per firing, frames between them, projectiles per shot |
| `speed`, `gravity`, `highTrajectory`, `flightTime` | flight shape (`projectilespeed`, `myGravity`) |
| `beamtime`, `sweepFire` | beam weapons |
| `cp` | the customParams that change what a weapon does, when present: `nuclear`, `junotype`, `cluster_def`, `cluster_number`, `area_onhit_damage`, `area_onhit_range`, `area_onhit_time`, `overrange_distance`, `stockpilelimit` |

## Preamble

The text line grammar the retired `.brsnap` stream used:
`GID` (the 32-hex gameId, always the first line after the header), `GAME`
(JSON: protocol, widgetVersion (semver of the emitting widget), widgetDate
(when that version was cut) and widgetSha (git SHA of the exact widget file,
stamped into the copy published for download — absent from a widget installed
straight from the repo; both widget >= 1.7.0), mode
live/replay, map, game/engine versions, sampleEvery, gameSpeed, recordEnemies
(whether the stream carries enemy units — see above), recording
player id/allyTeam/spectator), `DEF` (full unit-def
JSON), `T`, `P`, `READY`. The `GAME` line's `sampleEvery`/`gameSpeed` feed
velocity de-quantization and frame timestamps (`t = frame/gameSpeed`), and its
`protocol` selects the resource-income semantics (>= 3: written as the engine
reports it; <= 2 or absent: over-scaled by gameSpeed, repaired at decode — see
the frame-record section); metadata seeded by the caller (e.g. from the demo)
wins over `GAME` values.
