# Making BAR re-simulation faster: what was done and what it measured


## Context

barreplay ([replay.fogofwar.dev](https://replay.fogofwar.dev)) re-simulates
finished BAR games so a viewer can show every unit of every player. It plays
the game's demo file in `spring-headless` with a read-only widget that records
the units once a second. The demo holds only player inputs, so the engine
computes the whole game again.

Every change described here keeps the result **byte-identical**. The
recorded file of the whole benchmark game hashes to the same value on the
stock engine and on every build below, and a second, smaller game is used as a
quick gate. The demo also carries every player's sync checksum every 60
frames, so a change to any simulated value would show within two seconds of
game time.

The benchmark, "verylarge1" (game `6a37d06acbb455b1d19179d8ec965f10`), is a
16-player Supreme Isthmus game of 51 minutes on the 2026.07.04 engine. At
frame 63,780 it has 10,496 units, 5,711 of them aircraft (mostly fighters).
The host is a 4-core / 8-thread laptop (i7-4980HQ, 15 GB, no GPU).

Terms used below:

- **Exact**: a change that leaves every simulated value unchanged.
- **Serial loop**: a loop over units that has to visit them one at a time, in
  a fixed order, on the main thread.
- **Slow-update loop**: `CUnitHandler::SlowUpdateUnits`. Each frame it runs
  `CUnit::SlowUpdate` and the weapons' `SlowUpdate` for a slice of the units,
  so each unit gets one about twice a second. That is where resource upkeep,
  auto-heal and the weapons' search for a new target live.
- **Fork-join section**: a loop the engine already runs on its thread pool
  (`for_mt`), where the main thread takes a share and then waits for the
  slowest worker.
- **Late window**: the 450 frames (15 s of game time) after frame 63,780,
  timed from a saved checkpoint (see below).

## Result

![whole game](engine-speed/whole-game.svg)

| verylarge1, whole game (90,900 frames) | stock 2026.07.04 | all exact changes, 4 threads | best so far, 7 threads |
|---|---|---|---|
| active simulation time | 38m17s | ~14m39s | **13m21s** |
| speed-up | | 2.61x | **2.87x** |
| main-thread cycles | 8.44e12 | 3.27e12 | 2.98e12 |
| worker cycles | 6.07e12 | 2.97e12 | |
| peak memory | 6.48 GiB | | 6.09 GiB |

The best run uses seven threads with the main thread pinned alone to one core.
"Active" leaves out the pauses the benchmark takes to let the laptop cool (see
"How it is measured").

The stock engine's recording differs from the others only in its hit,
projectile and blast records. BAR's widget sandbox hides attackers and
explosions from a user widget, so a stock run
records hits without attackers and infers explosions. The patched engine logs
them itself and the widget reads that log. Unit positions, health, events and
economy are identical.

## How it is measured

On a big game almost all of the time is the late game:

![late game share](engine-speed/late-game-share.svg)

Whole games turned out to be a poor yardstick. A small game is fast on every
build, and a whole big game takes 15-40 minutes on a laptop whose clock speed
depends on its temperature: the same code took 19m14s on a cool day and 23m21s
heat-soaked. So every decision is made on the late window:

![checkpoint benchmark](engine-speed/checkpoint-bench.svg)

- The engine is re-simulated once to frame 63,780 and parked there. The
  process is then saved with CRIU (a Linux checkpoint/restore tool) and
  restored for every trial, so each trial starts from exactly the same state.
- Trials alternate (A B A B ...), the main thread is pinned to its own core,
  and results are read in main-thread **cycles** as well as wall time, since
  cycles do not depend on the clock.
- A checkpoint restores only into the binary that made it, so each build is
  dumped once. Most changes sit behind bits of one environment variable
  (`BARREPLAY_TOGGLES`), which lets one checkpoint compare many of them.
- Whole games are run only to check byte identity and the overall trend. Even
  then they swing by about ±10% with temperature.

One lesson from this: short trials and whole games can disagree. Early on,
seven threads won 6% in a short trial but lost over a whole game, because a
hotter chip slows the main thread more than extra workers help. So thread
counts are judged on whole games, and the parallel loops were re-tuned before
the 7-thread run above.

## Where the time goes

**The main thread waits for memory.** Over the late window, 55% of its cycles
stall on a memory load and 14% go to page-table walks (0.87 instructions per
cycle). Ten thousand unit objects of several KB each, plus their weapons and
move types, do not fit a 6 MB L3 cache, so every pass over the units streams
from main memory. This is why prefetching and huge pages paid off here and
did nothing on small games.

**The main thread is the bottleneck.** Workers run at about a third of a core
each: they mostly wait for the main thread's serial loops. The main thread's
late-window profile with every change in place but before the last one (P4,
below), as inclusive shares, so rows overlap:

| | % of the main thread |
|---|---|
| fork-join sections (main's own share): LOS 6.0, unit LOS states 5.6, ground moves 2.8, paths 1.8 | 19.9 |
| synced Lua (BAR's gadgets) | 14.0 |
| `CWeapon::SlowUpdate` | 10.6 |
| of which the target search (`GenerateWeaponTargets` 6.6, `TryTarget` 2.6) | 9.2 |
| the aircraft move-type loop (already parallel, see P1) | 9.7 |
| `CWeapon::Update` (5.9 of it beam lasers firing) | 8.8 |
| COB tick (`CCobEngine::Tick`) | 5.8 |
| `CUnit::SlowUpdate` (mostly the command AI) | 5.5 |
| explosions 3.8, projectiles 3.2, `CUnit::Update` 3.6 | |

Nothing left is bigger than about 10%, so what remains is either many small
wins or running more of the serial loops in parallel. The second needs engine
rules to change, which is what
[engine-changes-for-speed.md](engine-changes-for-speed.md) is about.

## The changes

They fall into four kinds: removing work nothing reads, running work in
parallel while proving the order of results is unchanged, making memory access
cheaper, and moving the capture widget's work into the engine. Gains are on the
late window unless stated otherwise, each measured on its own against the
build before it.

### Earlier rounds (in the published patched engine)

These are in the build re-sim hosts already download (revision 3 of the patch
series).

| change | gain |
|---|---|
| demo playback not paced by the client-CPU governor: in demo playback the local `CGameServer` holds the client's sim at 60% of the CPU (`LagProtection`); a replay has nothing to protect | -15% wall |
| a coarse grid of "exit-only" yardmap squares, so footprint checks skip blocks that have none ([upstream PR #3254](https://github.com/beyond-all-reason/RecoilEngine/pull/3254), open) | -16% instructions |
| no save of the previous frame's transforms (draw interpolation state) in headless runs | -3.7% instructions |
| no `.smt` map tile decode in headless runs | -25% load time |
| `StaticMemPool` pages zeroed when handed out, not all at startup (the loader already zeroed them) | -1.05 GiB memory |
| `TextureMemPoolSize = 0` in the engine config, so no 512 MB bitmap arena is zeroed at startup | -0.5 GB memory |
| PGO + LTO build | -10% |
| smaller cuts: a cached collision lookup, COB jump-table dispatch, animation ticks, thread-pool batching, path-grid relinking | -0.3% to -1.1% each |

### Revision 4 of the patch series (in this repo, not yet published)

| change | gain |
|---|---|
| Lua callin timers run only while the profiler is on (they wrapped every callin) | -5.3% together with the next |
| prefetch the unit 8 ahead (its move type and first weapon 4 ahead) in the four per-unit loops | (in the -5.3%) |
| a low-priority thread folds every large private anonymous mapping into huge pages every 2 s (no root, no host setting) | -19% main-thread user cycles on a fresh run |
| `Spring.GetUnitSampleData`: the widget's per-second sample in one engine call instead of ~8 per unit | part of revision 4 |
| the engine logs every write of a weapon's reload state, so the widget reads that log instead of polling every launcher every frame | -1.7% |

Changes on the widget and engine-config side, in use for every re-sim:

| change | gain |
|---|---|
| the Widget Selector's profiler column off (it wrapped every widget callin in a timer) | -2.4% wall |
| BAR's ~320 game widgets set to off in the seeded widget config, names read from the game package; BAR's 2026.10.13 sandbox took away the widget's old runtime way of doing this | -6.2% |
| a re-sim-only sample loop in the widget, without branches a full-view re-sim cannot take | -1.4% |

### Removing work nothing reads (branch only)

| change | gain |
|---|---|
| build with `SYNCCHECK=OFF`: the sync checker hashes every synced write, and only multiplayer desync detection reads the hash (needed four small compile fixes) | -7.9% |
| the per-animation checksum in `TickAllAnims` computed only with the sync checker | in the above |
| skip the eager piece-transform walk in headless demo playback; the transforms only feed drawing (the old `#ifdef HEADLESS` versions of such patches never compiled in `rts/Sim`) | -2.9% wall |
| a headless demo queues no unsynced height-map updates (their rectangle queue once grew to 4 GiB from garbage rectangles) | robustness, speed-neutral |
| `Spring.GetUnitSampleDelta`: the widget's whole sample loop done in the engine | -7.2% with its widget side |

### Running serial work in parallel, exactly (branch only)

Each of these runs work on several threads while proving that no unit can see
a difference. That proof is most of the work.

**P1: the aircraft move-type loop on all threads.** BAR sets `collide = false`
on every aircraft except four flying fortresses, so a flying fighter's update
reads only itself and its target.

![ordered parallel loop](engine-speed/ordered-parallel-loop.svg)

Later versions moved more cases into the parallel part: crashing aircraft that
cannot reach the ground this frame (their smoke trails deferred to loop
order), hovering, stunned and unfinished aircraft, and letting an item pass
the in-order start on before waiting for its target. The first version measured
-8.3% of main-thread cycles. Two hangs were found and fixed on the way: a
parallel loop started from inside a serial item (now runs inline), and a race
on the "how far have we got" counter, caused by x86 store buffering (now a
sequentially consistent store and fence, plus a periodic rescan).

**P2: unit LOS states** (`CUnit::UpdateLosStatus` for every ally team)
computed in parallel, then applied and evented in loop order. They are a pure
function of the unit and the LOS maps, so only the application has to be
ordered.

**N1: BAR's "AA Targeting Priority" `AllowWeaponTarget` done in C++.** It is a
per-unit-def multiplier, called about 3,100 times a frame in the late game. The
native version is used only after the gadget files hash to the known content
and the installed closure checks out, does the same single-precision multiply,
and falls back to Lua on any mismatch. P1, P2, N1, the crashing-aircraft
extension of P1 and the headless transform skip together measured -19.2%.

**P4: the slow-update loop's target searches on worker threads.** Each weapon's
`AutoTarget` search (`GenerateWeaponTargets` plus the `TryTarget` walk over
candidates) runs on a worker while the main thread goes on with the next
units' slow updates. Results are applied in launch order. Everything else stays
on the main thread where it was: the random draws (`NextVector` plus
`NextFloat`, about 7 per weapon), COB queries and Lua. The main thread waits
for running searches only before a write a search might read: an enemy moving
or dying inside a running search's circle, damage, quad changes, and Lua
functions that write sim state or read a weapon's target. A check mode compared
210,486 searches against the serial result with no mismatch. -4.1% wall, -4.4%
main-thread cycles.

One finding from P4: more search workers made the main thread wait longer. A
search the main thread runs itself is fast because its caches are warm from the
unit's own slow update; a worker's are cold.

### Cheaper memory access and smaller fixes (branch only)

| change | gain |
|---|---|
| unit loops hand out chunks of at most 32 units (the main thread used to wait for the slowest worker's quarter) | -2.2% |
| quad lookups (`GetQuads`) find each row's run of quads from its two ends | -1.7% |
| `GenerateWeaponTargets` prefetches the candidate 6 ahead | -1.2% (4 threads; costs time at 7, off there) |
| `MovedUnit` copies the quad list instead of taking a pooled buffer (a malloc and free per move) | not measured alone |
| `FindAnim` searches on one packed 64-bit key | noise level |
| `UpdatePhysicalState` reuses the ground height while the unit's x/z and the height map are unchanged | -2.2% at 7 threads |
| the Lua VM's table get and set do their first step inline | in the 7-thread result |
| `UpdateUnits` does `UpdateCollisionMap`'s rate test itself, so two units in three never touch their move type | in the 7-thread result |

At seven threads, three changes tuned at four (landed and taking-off aircraft
in P1, and two prefetches) cost time and are switched off in the best
configuration (-2.5%).

**A bug fix worth taking upstream:** `CRectangleOverlapHandler::StageSplitTooLarge`
wrote through a reference into a vector across `push_back`. That is a
use-after-free and corrupted the heap, seen as an RmlUi crash at frame 78 of
verylarge1 in some builds
([issue #3548](https://github.com/beyond-all-reason/RecoilEngine/issues/3548)).

### Written, not yet measured

**P5: the COB tick on all threads, exactly sequential.** A count over the late
window found that 64% of the COB tick's cycles are threads that only animate
their own unit and sleep (walk cycles, turret idles), so the ceiling is about
2.5% of the frame. A tick runs on a worker only when every function on its call
stack uses own-unit operations: script state, pieces, animations, sleep and
wait, signals, two own flags, and reads of unit values from a fixed list. Sleep
pushes commute, because the sleep queue orders by (wake time, id); other
bookkeeping is buffered and applied in tick order. `rand` and starting a new
script thread are serial points. Offline, 9,312 of BAR's 12,173 COB functions
qualify.

## Measured and ruled out

| idea | finding |
|---|---|
| approximate simulation | the demo carries every player's sync checksum every 60 frames; any changed value fails within 2 game seconds |
| run-ahead prefetch on the main thread's hyperthread sibling | +11.6% (slower) |
| LOS update running in the background, joined before every LOS read | noise: BAR's `api_teamstats` reads LOS at the top of every `GameFrame`, so only the frame's tail overlaps |
| targeting scans precomputed on all threads and replayed in order | 85% of scans replayed, but +1.8%: the precompute visited more than the scan |
| skip recomputing weapon vectors whose inputs did not change (two attempts) | -1.0% at best, and the bookkeeping cost more when off; the second attempt was noise because nearly every armed unit moves or animates |
| LOS update: a parallel pre-pass marking which units need work | noise: the pre-pass reads the same fields the loops did, so the cache misses moved to it |
| reordering `CSolidObject`/`CUnit` fields by the hottest cache lines | +1.1% |
| more prefetching (height map, command queues, quads, death flags) | -0.5% to +0.7%, noise |
| x86-64-v3 (AVX2) build | 1.2% fewer instructions, 0.9% more cycles |
| mimalloc large pages | only 61 MB became huge pages; replaced by the background collapse thread |
| transparent huge pages set to `always` on the host | much slower |
| Lua GC pacing at its minimum | +0.7%, noise; the cost is the garbage BAR's gadgets make |
| capping worker cores' clock to leave the main thread more headroom | no help: the cores share one clock domain |
| expiring unsynced projectiles early | crashed at frame 6597: a missile keeps updating its smoke trail |

## Where each change lives

- **Published patched engine** (revision 3: the series in
  `patches/engine-2026.07.04/series` up to 0009, plus the PGO+LTO recipe):
  what re-sim hosts download today. It also carries the engine-side event log
  (0004) that lets the widget record hits and explosions under BAR's sandbox. The memory config is in barreplay
  itself.
- **Revision 4** (patches 0010-0013): in this repo's patch series, but not yet
  built, gated, uploaded or pinned, so hosts still use revision 3.
- **Branch only** (patches 0014-0043, 0063-0067 and 0069-0070 under
  `patches/engine-2026.07.04/speed/`, plus Recoil branches up to `speed37`):
  everything from "Removing work nothing reads" on. These changes have not been
  merged into this repo's main branch and are only on `speed-optimization-2`.
  They are gated byte-identical, but no build of them has been published.
  Building with `SYNCCHECK=OFF` also means a re-sim no longer reports desyncs in
  its log; the byte-identity gate is what remains.

## Appendix: this repo's names for the changes

The work log and patch files use short IDs. The toggle bit is the value in
`BARREPLAY_TOGGLES` (hex); "always" means the change has no switch.

| ID | patch | toggle | change |
|---|---|---|---|
| 0001 | 0001 | always | unpaced demo playback |
| H30 | `experiments/H30-…` | always | exit-only yardmap grid (upstream PR #3254) |
| H1 | `experiments/H1-…` | always | no previous-frame transform save headless |
| H49 | `experiments/H49-…` | always | no `.smt` decode headless |
| 0003 | 0003 | always | lazy `StaticMemPool` zeroing |
| H65, H66 | 0010, 0011 | always | callin timers only while profiling; loop prefetch |
| H71 | 0012 | always (`BARREPLAY_NO_THP_COLLAPSE` turns it off) | huge-page collapse thread |
| W2, W3 | 0013 + widget | always | `GetUnitSampleData`; reload-state log |
| W1, W4, W5 | widget, config | always | widget profiler off; BAR widgets off; re-sim sample loop |
| SYNCCHECK=OFF | 0014-0017 | build option | no sync checker |
| H72 | 0021 | always | anim checksum only with the sync checker |
| H73 | 0024-0025 | `0x10` | no eager piece-transform walk headless |
| W6, W7 | 0032 + widget | always | `GetUnitSampleDelta` |
| — | 0033 | always | clamp unsynced height-map rectangles |
| — | 0039 | always | `StageSplitTooLarge` use-after-free fix (issue #3548) |
| P1 | 0018, 0020-0023, 0026 | `0x1` | parallel aircraft loop |
| P1 v3, v5, v6, v7 | 0021, 0027, 0034-0035, 0042 | `0x8`, `0x20`, `0x80`, `0x2000` | crashing / hovering / landed aircraft; early start pass-on |
| P2 | 0019 | `0x2` | parallel unit LOS states |
| N1 | 0019 | `0x4` | native AA-priority `AllowWeaponTarget` |
| H75, H77 | 0036, 0038 | `0x100`, `0x400` | weapon-loop and target-scan prefetch |
| H76 | 0037 | `0x200` | chunks of at most 32 |
| H78 | 0040 | `0x800` | `MovedUnit` copies the quad list |
| H79 | 0041 | `0x1000` | row runs in `GetQuads` |
| H80 | 0043 | `0x4000` | packed `FindAnim` key |
| H87 | 0063 | `0x80000` | no unsynced height-map queue headless |
| H89 | 0064-0065 | always | inline Lua table get/set |
| H88 | 0066 | `0x100000` | ground height reused |
| H91 | 0067 | `0x400000` | collision-map rate test in `UpdateUnits` |
| P4 | 0069-0070 | `0x800000` | target searches on workers |
| H92, H93, P5 | Recoil `speed36`/`speed37`, not exported | `0x4000000`, `0x8000000`, `0x10000000` | weapon-vector skip, LOS pre-pass (both noise); parallel COB tick |

The best whole-game configuration is `t=587fbf` at 7 threads; with P1 v6, H75
and H77 off it is `t=587a3f`, and P4 adds `0x800000` (`t=d87a3f`).
