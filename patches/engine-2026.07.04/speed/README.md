# Speed work on top of the published series (2026-10-16/17)

The Recoil engine branches of the verylarge1 speed work
([docs/worklog-engine-speed.md](../../../docs/worklog-engine-speed.md)), as
patch files. None of them is listed in `../series`, so they are not part of
any published revision. `SeriesDigest` hashes only the files listed there
plus `../pgo/`, so adding them changes no pinned digest. Making them a
revision means listing them in `series`, which needs a new digest pinned,
a gate and a publish.

Numbering: the 4-digit prefixes continue the series (`../0001`-`0013`), so
every patch number under `engine-2026.07.04/` is unique: 0014-0043,
0063-0067, 0069-0070, 0073-0091, 0095-0099, 0101, 0104, 0106-0109, 0111-0112 and 0116-0123 here,
0044-0045, 0052-0062, 0068, 0071-0072, 0092-0094, 0100, 0102-0103, 0105, 0110 and 0113-0115 in
`rejected/`, 0046-0051 in `tools/`. Change
identifiers continue the work log's H-series (H1-H73), with H74-H104 for the
ones below.
P1 (with its versions v2-v9), P2, P3, P4, P5, P7, N1, N2 and the widget-side
W1-W7 are families of their own.

## Result

Both runs: same barreplay (widget 1.13.0), 4 threads, the engine paused at
88 C and resumed at 55 C, started from 50 C. Details and why the stock
capture differs in its hit/projectile/blast sections only: work log,
2026-10-18 00:55.

| verylarge1, whole game (90,900 frames), governed | stock 2026.07.04 | `speed24` `t=7fbf` (0014-0043) | ratio |
|---|---|---|---|
| active sim | 38m17s | ~14m39s | 2.61x |
| sim including thermal pauses | 1h0m38s | 38m19s | |
| main-thread cycles | 8.44e12 | 3.27e12 | 2.58x |
| main-thread average clock | 3.66 GHz | 3.68 GHz | |
| worker cycles (3 workers) | 6.07e12 | 2.97e12 | 2.04x |
| peak memory | 6.48 GiB | — | |

Best so far: `speed32` (= `speed24h` + H87 + H88 + H89 + H91, Recoil branch
`speed32`), `t=587fbf`, `-worker-threads 7`, the main thread pinned alone on a
core, the same governor: **13m21.3s active** (-8.9% against `speed24`),
identical (`a26e920d…`), peak memory 6.09 GiB (work log, 2026-10-18).

Best so far: `speed43`, `t=50d87a3f`, `t2=1f` (everything below on except P1
v8 and v9), the same threads, pinning and governor: **13m07.8s active**,
identical (`a26e920d…`). Against `speed32` that is only -1.7%: the main thread
executes 8.2% fewer instructions at 7.1% lower IPC (2.941e12 cycles against
2.978e12), and the workers run 56% more cycles (work log, 2026-10-19).

Best so far: `speed44` (= `speed43` + 0091, P7 gated by unit count), the same
settings: **12m41.4s active**, identical (`a26e920d…`), -5.0% against
`speed32`. P7 cost +7.6% at 1,405 units and +2.9% at 3,719 until gated; the
main thread's IPC is back to 1.024 (work log, 2026-10-19). A/Bs now run five
windows (15,000, 35,000, 63,780, 72,000, 82,000): the late window alone
stands for a fifth of the game's time, and its air-heavy mix flatters the
parallel items.

Best so far: `speed44`, `t=d0d87abf`, `t2=37` (P1 v6, v8 and v9 added; P5 with
3 workers): **12m18.2s active**, identical (`a26e920d…`), -7.9% against
`speed32` and 3.11x stock. v6, v8 and v9 each lose alone and win together
(-1.4 to -3.3% late): they remove different serial aircraft, so only all
three shorten P1's start chain (work log, 2026-10-19).

Best so far: `speed54` (= `speed44` + 0092-0109), `t=d0d87abf`, `t2=e3837`
(H98, H99, H100, H103, H104 and P7 v4 added): **11m38.6s active**, identical
(`a26e920d…`), -5.4% against `speed44`'s 12m18.2s, -12.8% against `speed32`
and 3.29x stock. `speed53` without 0109 ran 11m34.0s but its capture differed
(the simulation did not): BAR's unsynced "Widget Events" gadget forwards
`UnitGiven` to LuaUI and the capture widget records both calls, and P7 v4
moved a dying unit's lingering sight (work log, 2026-10-19).

Best so far: `speed57` (= `speed54` + 0110-0111, built for Haswell with
128-bit vectors and no FMA: `-DMARCH_FLAG=haswell -DSSE_FLAGS='-mno-fma
-mno-fma4 -ffp-contract=off -mprefer-vector-width=128'`, with a PGO profile
trained on that build), `t=d0d87abf`, `t2=e3837`: **11m36.1s active**,
identical (`a26e920d…`), -0.4% against `speed54` (late windows -1.6% to
-2.3% for the flags and the profile together; work log, 2026-10-19/20).

Best so far: `speed58` (= `speed57` + 0112-0121, same flags, `speed57`'s
profile), `t=d0d87abf`, `t2=1ee3837` (P8, P9, the data exemption and P10 on):
**11m04.2s active**, identical (`a26e920d…`), -4.6% against `speed57`. P9
loses in the late windows and H92 now wins (work log, 2026-10-20), so `speed59`
measures `t=d4d87abf`, `t2=1ae3837`.

## Applying

From a clean checkout of the `2026.07.04` tag:

```sh
P=patches/engine-2026.07.04
git am $(grep -v '^#' $P/series | sed "s|^|$P/|")   # the published series, 0001-0013
git am $P/speed/00*.patch                          # 0014-0043, in order
```

That reproduces the work tree's branch `speed24h` exactly (checked: no
difference in `git diff`). The current line, Recoil branch `speed44`, is the
series, then 0014-0070, then `rejected/0071-0072` (H92 and H93: toggled off,
but P5 was written on top of them and P7 uses H93's predicate), then
0073-0091 (checked the same way for `speed43`; 0091 is one patch on top):

```sh
git am $(grep -v '^#' $P/series | sed "s|^|$P/|")
git am $(ls $P/speed/00*.patch | awk -F/ '$NF < "0071"')
git am $P/speed/rejected/0071-*.patch $P/speed/rejected/0072-*.patch
git am $(ls $P/speed/00*.patch | awk -F/ '$NF > "0072"')
```

The line after it, Recoil branch `speed54`, is `speed44` plus 0092-0109 in
number order, kept and rejected alike (the rejected ones are toggled off;
later patches were written on top of them). Checked: applied to `speed44`,
0092-0108 give `speed53` with no difference; 0109 is one commit on top.

```sh
git am $(ls $P/speed/0*.patch $P/speed/rejected/0*.patch | awk -F/ '{print $NF" "$0}' | awk '$1 >= "0092"' | sort | cut -d' ' -f2)
```

`tools/pgo-profile-speed39.tar.xz` is the profile `speed43` to `speed53` build with
(retrained on `speed39`: -3.6% in the late window against the `speed31` one). It is `speed24`, the branch the measured builds
came from, with only identifiers in comments renamed. Build with
`-DSYNCCHECK=OFF`. Patches 0014-0017 make that configuration compile, and
the sync checker hashes every synced write: 7.9% of the late game, read only
by multiplayer desync detection. `tools/build-pgolto-g.sh` is the PGO+LTO
build used throughout (with `-g`, plus `EXTRA_CMAKE`, `LDEXTRA` and `PROFILE`
hooks). `tools/pgo-profile-speed31.tar.xz` is the profile retrained on
0063-0066 (and H90), which `speed32` builds with. `tools/pgo-profile-speed22.tar.xz` is a PGO profile trained on this
code with every toggle on (-1.1% in the late window against revision 3's
profile, which `../pgo/profile.tar.xz` still is).

All of it together (`t=7fbf`, the new profile): the late window runs 10.54 s
against 14.82 s with every toggle off (-28.9%).

## Toggles

Most changes are behind bits of one switch, read from `BARREPLAY_TOGGLES`
(hex) at startup, or from the bench harness's go file (`t=<hex>`) on each
checkpoint restore. `0` is stock behaviour for everything toggled. Every bit
below keeps the output byte-identical: medium gate `0558d354…` and, for
everything up to `0xfbf`, the whole verylarge1 game `a26e920d…`.

| bit | id | patches | what | late window, measured | status |
|---|---|---|---|---|---|
| `0x1` | P1 | 0018, 0020-0023, 0026 | the general move-type (aircraft) loop on all threads, exactly sequential: in-order start, target edges, serial items as barriers, RNG draws wait for every earlier item | with 0x2-0x20: -19.2% (`speed14`, `t=1f` vs `t=0`) | on |
| `0x2` | P2 | 0019 | unit LOS states computed on all threads, applied in order | (in the -19.2%) | on |
| `0x4` | N1 | 0019 | BAR's AA-priority `AllowWeaponTarget` done natively when its Lua is verified unchanged | (in the -19.2%) | on |
| `0x8` | P1 v3 | 0021 | crashing aircraft that cannot reach the ground this frame in parallel, trails deferred in loop order | (in the -19.2%) | on |
| `0x10` | H73 | 0024-0025 | headless demo: skip the eager piece-transform walk (run-time test; `#ifdef HEADLESS` never reaches `rts/Sim`) | (in the -19.2%) | on |
| `0x20` | P1 v5 | 0027 | hover aircraft flying or hovering, and stunned or unfinished aircraft, in parallel | `speed15`: -18% vs all off | on |
| `0x40` | H74 | 0028-0031 | run-ahead prefetch helper on the main thread's hyperthread sibling | **+11.6%** (slower) | **rejected**, leave off |
| `0x80` | P1 v6 | 0034-0035 | landed aircraft and aircraft taking off in parallel | -0.8% (noise level); alone +0.5 to +3.6% in `speed44`, with v8 and v9 -1.4 to -3.3% | on (with v8 and v9) |
| `0x100` | H75 | 0036 | serial weapon loop prefetches every weapon 4 units ahead, and their targets 2 ahead | -0.5% (noise level) | on |
| `0x200` | H76 | 0037 | the unit loops' `for_mt_chunk` hand out chunks of at most 32 (the main thread waited for the slowest worker's quarter) | **-2.2%** | on |
| `0x400` | H77 | 0038 | `GenerateWeaponTargets` prefetches the candidate 6 ahead (three lines) | **-1.2%** | on |
| `0x800` | H78 | 0040 | `MovedUnit` copies the quad list instead of taking the pooled buffer (a malloc + free per move) | not measured alone | on |
| `0x1000` | H79 | 0041 | `GetQuads` finds each row's run of quads by its two ends | **-1.7%** | on |
| `0x2000` | P1 v7 | 0042 | an item passes the in-order start on before waiting for its targets | **-1.5%** | on |
| `0x4000` | H80 | 0043 | `FindAnim` searches on one packed 64-bit key | -0.4% (noise level) | on |
| `0x800000` | P4 | 0069-0070 | the slow-update loop's weapon target searches (`GenerateWeaponTargets` + the `TryTarget` walk) on worker threads, applied in launch order; the main thread waits only before writes a search may read (an enemy of a running search's weapon inside its circle, Lua's writing functions, deaths, damage, moves, quad changes...) | **-4.1%** wall, -4.4% main cycles (`speed34`, `t=d87a3f` vs `587a3f`) | on |
| bits 24-25 | P4 workers | 0070 | 2 + 2k workers take searches (0 = `BARREPLAY_P4_WORKERS`, default 2) | 6 workers +1.5% against 2 | 0 |
| `0x40000000` | H94 | 0080 | the LOS types' height-map updates (each type scans all its instances per crater) on all threads | **-1.8%** | on |
| `0x80000000` | P1 v8 | 0081 | hover aircraft standing still in the air (flying or hovering, not stopping or crashing) as parallel items | -0.4% alone; part of the v6 + v8 + v9 trio, exact over the whole game | on (with v6 and v9) |
| `0x10000000` | P5 | 0073-0078 | the COB engine's thread ticks on the workers with the sequential result: a tick runs out of order when every function its thread can be in uses only own-unit operations (decided once per function from the bytecode); `RAND` and `START` wait for every earlier tick; the global bookkeeping (sleeps, thread ends, the animation list, visual sfx) is applied in tick order at each segment's end. `BARREPLAY_P5_STATS=<frames>` logs counters | **-1.2%** wall and cycles, -6.3% instructions (`speed39`, `t=1cd87a3f` vs `cd87a3f`) | on |

The second word, `BARREPLAY_TOGGLES2` / the go file's `t2=<hex>` (0084 on):

| bit | id | patches | what | late window, measured | status |
|---|---|---|---|---|---|
| `0x1` | N2 | 0082-0083, 0086, 0088 | BAR's gadget-handler callin wrapper and handler loop for `UnitPreDamaged`, `UnitDamaged`, `Explosion` and `ProjectileDestroyed` done in C when their bytecode hashes are on the built-in list (verified against BAR's source; anything else, tweakdefs included, runs interpreted). `BARREPLAY_N2_HASHES` adds hashes | **-2.2%** | on |
| bits 1-3 | P5 workers | 0084 | the COB tick's worker count (0 = `BARREPLAY_P5_WORKERS`, default 6) | 2 workers +0.7%; 3 against 7: -0.3 to -1.1% | 3 (`t2=17`/`37`) |
| `0x10` | P7 | 0084-0085, 0091 | the LOS update's per-unit tests (H93's read-only predicate, every sensor type) on the workers during the script tick; the LOS point runs the real update for the flagged and the changed units in order. 0091 (v3): only in frames with at least `BARREPLAY_P7_MINUNITS` (6,000) active units, and no per-frame clear of a 32,000-entry index | **-1.5%** late; ungated +7.6% early (1,405 units), +2.9% middle (3,719) | on |
| `0x20` | P1 v9 | 0087 | P1's items claimed in batches of consecutive planned-parallel units (bits 6-7: 8/4/16/32 a batch) | alone +0.2 to +1.8%; with v6 and v8 -1.4 to -3.3% (late), exact over the whole game | on (`t2=37`) |
| bits 8-9 | H96 | 0092-0093 (rejected) | pool workers spin 2 ms (`0x100`) or 20 ms (`0x200`) after their last task, sleeping at most 0.5 ms | +7.0% / +28.2% | off |
| `0x400` | H97 | 0094 (rejected) | each unit's slot in its quad lists kept, so leaving a quad needs no search | +1.0%; on huge-page memory -0.1% / +1.1% | off |
| `0x800` | H98 | 0095 | the unit loop prefetches the quad bookkeeping (the unit's `quads` line, the list's buffer, the first quads) of the units whose collision-map update runs this frame | -0.5% / -0.3% | on |
| `0x1000` | H99 | 0098, 0101 | the per-frame Lua GC step on its own thread during the LOS update (the collector is stopped between calls and runs on a wall-clock budget; the LOS update runs no Lua) | -0.4 to -1.9% / -3.4 to -3.5% | on |
| `0x2000` | H100 | 0099 | the ground system's two single-threaded loops (heading changes, the final `Update`) on all threads; serial while a Lua unit script defines `ChangeHeading` or anything listens to `UnitMoved`; from 512 entries | -1.4% / -2.6% | on |
| `0x4000` | H101 | 0100, 0103, 0105 (rejected) | `CUnit::Update` on all threads in runs between serial points (busy builders and factories, units firing a synced-received air/water event) | +2.0% / +3.9%; refined +1.5% / +0.5% (752 busy builders a frame) | off |
| `0x8000`, `0x10000` | H102 | 0102 (rejected) | a push wakes any sleeping worker; worker 1 spins 1 ms | -2.1% beside the first H101, noise without | off |
| `0x20000` | H103 | 0104 | synced `next` calls `lua_next` directly instead of the original `next` through `lua_call` | -0.7% / -0.7% (noise level) | on |
| `0x40000` | H104 | 0106-0107, 0109 | in a demo replay the unsynced halves of LuaRules and LuaGaia receive no events and no `SendToUnsynced` messages (the arguments are still checked) | -2.2% / -2.4% | on |
| `0x80000` | P7 v4 | 0108-0109 | P7's phase A runs each sensor type's per-unit loop itself (a task per type); the handler's event functions and the height-map hook join it; `Update` discards an instance created and released before it | -1.2% / -0.8% | on |
| `0x100000` | P7 v4.1 | 0110 (rejected) | phase A in two stages: the tests in chunks on all threads, then each type's `UpdateUnit` over the flagged units only | no gain (Haswell-128 build, both windows) | off |
| `0x200000` | P8 | 0112, 0116-0118 | the weapon vectors computed by the workers in unit order while the weapon loop runs behind them; every unit made ready (computed by whoever claims it, else waited for) before its weapons update and before anything in the loop writes or reads another unit's vector inputs: damage, kills, stuns, team and hold-fire changes, moves and turns, transport changes and Lua writes (all units), collision tests (piece matrices), the shield query, Lua's unit lookups, `CallAsUnit`, interceptable projectiles; from 2048 units (`BARREPLAY_P8_MINUNITS`) | -2.7% / -2.9% (against `speed58` with nothing new on) | on |
| `0x400000` | P9 | 0113-0115 (rejected), 0117 | `UpdateUnits`' collision-map decision on all threads before the loop, used at the unit's turn only while every input it read is bitwise unchanged (needs H91) | +0.9% / -0.1% | off |
| `0x800000` | P8 data writes | 0118 | Lua writes of rules params and team resources make no unit ready | +1.0% / -0.4% (noise) | on |
| `0x1000000` | P10 | 0119-0120, 0123 | the fighters' enemy-aircraft searches (`CAirCAI`: fight, auto-targeting) launched at the slow-update slice's start on P4's workers; an answer is taken when the slow update's own arguments are bitwise the predicted ones and nothing was drained since the launch (and the synced tempNum is drawn as the search would have); entering the crash state drains | -2.2% / -0.7% (instructions -2.6% / -2.4%) | on |
| `0x2000000` | P4 v2 | 0122 | P4's enemy drain waits only for the searches whose scan reads the unit: not for one its ally team neither sees nor has on radar, nor for a seen one out of the scan's range (the same test on the same inputs) | in `speed59` | |

Not toggled (always on in these builds):

| patches | what |
|---|---|
| 0014-0017 | `SYNCCHECK=OFF` compiles: `float3::bitExactEquals`, includes, the in-synced counter kept, the sync-history dump only with the checker |
| 0021 (H72) | the per-anim checksum in `TickAllAnims` only with `SYNCCHECK` (it fed nothing else) |
| 0032 | W6: `Spring.GetUnitSampleDelta`, the capture widget's bulk sample loop in the engine (with widget W7, -7.2% of the late window, governed whole game 16m39s -> 15m25s active) |
| 0033 | clamp unsynced height-map update rectangles to the map (a symptom of the next one) |
| 0039 | **upstream bug fix**: `CRectangleOverlapHandler::StageSplitTooLarge` wrote through a reference into a vector across `push_back` (use-after-free, heap corruption; seen as an RmlUi crash at frame 78 of verylarge1 in some builds) |
| 0063 (H87, toggle `0x80000`) | a headless demo replay queues no unsynced height-map updates: their rectangle queue blew up to 4 GiB from garbage rectangles (the runaway memory of 10-17/18); speed-neutral, kept for robustness |
| 0064-0065 (H89, no toggle) | the Lua VM's table gets and sets do `luaV_gettable` / `luaV_settable`'s first step inline |
| 0066 (H88, toggle `0x100000`) | `UpdatePhysicalState` reuses the ground height while the unit's x/z and the height map are unchanged |
| 0067 (H91, toggle `0x400000`) | `UpdateUnits` does `UpdateCollisionMap`'s rate test itself, so two units in three never touch their move type |
| 0079 | measurement: P1's main-thread waits by kind, its serial items by type, state and speed; P4 and P5 counters on the bench harness's result line |
| 0089 | P1's crash bound compiles with the sync checker on (`std::min<float>` over a `SyncedFloat`) |
| 0096-0097 | bench harness: after a restore the engine waits until transparent huge pages cover what a real run has (98%, or until the share stops growing for 6 s; at most 120 s) before the window. A restored heap is on 4 KiB pages until H71's collapser runs over it again, and a window started at once ran ~19% slower than a fresh run (now ~4%) |
| 0090 | **P4 fix**: `CWeapon::TryTargetHeading` turns its unit for a moment (heading and dir vectors, written directly) and back; first it waits for the running searches of the unit's ally team (or any, if the unit is neutral) whose area holds it, since their line-of-fire rays read their own side's units. Without it P4 diverged in about half the whole-game runs (work log, 2026-10-19) |
| 0111 | measurement for P8: Lua writes, damage and kill calls in the weapon loop and the index of the first Lua write per frame (`BARREPLAY_P8_STATS`) |
| 0121 | bench harness: a `p4check` word in `park.go` (`P4CHECK=1`) turns P4's and P10's check mode on after a restore; 0123 makes P4's first-slice init keep it |

## rejected/

| patch | what | measured |
|---|---|---|
| `0044-H64…` | prefetch `tempNum`/`losStatus` of the candidate 4 ahead in `GenerateWeaponTargets` (2026-10-15) | 23.32 -> 23.36 s, nothing; reverted. H77 (0038) later measured -1.2% with `aimPos` too, 6 ahead |
| `0045-H67…` | H67: prefetch height-map cells under upcoming units; H68: prefetch aircraft command-queue fronts | 19076 -> 19024 ms, -0.3%, noise (2026-10-16 04:35); dropped |
| `0052-`, `0053-H81…` | H81: skip recomputing weapon vectors whose inputs (piece transforms by a per-model change counter, the unit's script, position and direction vectors bit for bit, a height-map write counter) did not change since the last computation; in the beam laser, the weapon-vectors pass and `CWeapon::SlowUpdate` (toggle `0x8000`, on top of 0043) | on: -1.0%, mixed pairs; but the bookkeeping, always on, made the build +1.5% slower with the toggle off (speed24 vs speed26, both `t=7fbf`): a wash, dropped |
| `0054-H82…` | H82: `GenerateWeaponTargets` prefetches through the next quads (Quad 3 ahead, list header 2 ahead, pointer array 1 ahead, first 6 candidates) (toggle `0x10000`, on top of 0053) | -0.5%, noise level; dropped |
| `0055-H83…` | H83: layout only — `CSolidObject`'s direction vectors and mid/aim positions next to `physicalState`/`allyteam`, `CUnit`'s state flags (`activated`, `isDead`, `onTempHoldFire`, `deathScriptFinished`, `beingBuilt`, `stunned`, `forceUseWeapons`/`allowUseWeapons`) next to `moveType`/`script`, from the latency profile's hottest unit cache lines (on top of 0043) | +1.1% wall, +0.9% cycles, mixed pairs (2026-10-17 23:45); dropped |
| `0056-`, `0060-H84…` | H84: the LOS update runs on the workers in the background; every LOS read and every write to what it reads (unit sensor fields and mid position, height maps, global LOS, 256 synced Lua controls) joins first; `0060` logs join waits and sites (toggle `0x8000`) | identical (medium); -0.1% wall, noise (2026-10-18 03:20). BAR's `api_teamstats` reads LOS (`GetPositionLosState`) at the top of every `GameFrame`, so the overlap is only the frame's tail |
| `0057-H85…` | H85: the LOS-state apply pass visits only the units whose status changed (toggle `0x10000`) | identical; +0.3% wall, -1.2% instructions, noise |
| `0058-`, `0061-`, `0062-P3…` | P3: the slow-update slice's targeting scans precomputed on all threads (every enemy unit in a superset of the quads, with its LOS state and target position) and replayed in order, checked against write marks on units, quads and everything (toggle `0x20000`); `0061` gives the precompute's quad queries their own thread's pool (the first build crashed), `0062` narrows the marks (built, not measured) | identical; 85% of scans replayed, but +1.8% wall, +1.4% cycles: the precompute visits more than the scan (larger radius, no dedup) and is a fork-join section of its own |
| `0059-H86…` | H86: `QueueDeleteUnits` prefetches the death flag 16 units ahead (toggle `0x40000`) | +0.7% wall, noise or worse |
| `0071-H92…` | H92: `UpdateWeaponVectors` keeps its outputs while every input is bitwise unchanged (toggle `0x4000000`) | identical; noise level (`speed36`). **With P8 it pays** (-1.4% / -0.7%, `speed58`): the beam laser's own update repeats the frame's computation and hits, and the misses run on the workers. On from `speed59` |
| `0072-H93…` | H93: the LOS types' per-unit tests in one parallel pre-pass, each type's loop visits only the units that need it (toggle `0x8000000`) | identical; noise level (`speed36`); P5 applies without 0071-0072 |
| `0092-`, `0093-H96…` | H96: every pool worker spins 2 ms or 20 ms after its last task and sleeps at most 0.5 ms (toggle2 bits 8-9). Kept in the line (toggled off) | +7.0% / +28.2%: the main thread ran 40% more instructions, polling the queue against the spinners; 20 ms of spin hit the package power limit (3.26 GHz) |
| `0094-H97…` | H97: each unit's slot in its quad lists kept beside `unit->quads`, so leaving a quad erases without a search (toggle2 `0x400`). Kept in the line | +1.0% wall, +0.0% instructions: `MovedUnit`'s time is three dependent cache misses (the unit's `quads`, the list's buffer, the quad), not the searches; H98 prefetches those instead |
| `0100-`, `0103-`, `0105-H101…` | H101: `CUnit::Update` on all threads in runs, then events, reload log and collision maps in order; busy builders and factories and units firing a synced-received air/water event are serial points (toggle2 `0x4000`). Kept in the line | +2.0% / +3.9%; refined +1.5% / +0.5%: a late frame has 752 busy builders among 10,496 units (nano turrets assisting factories), so the runs stay short |
| `0102-H102…` | H102: a push wakes any sleeping worker (toggle2 `0x8000`); worker 1 spins 1 ms (`0x10000`). Kept in the line | the wake -2.1% / -1.9% beside the first H101 (dozens of small sections a frame), +0.8% / -1.2% without it; the spin nothing |
| `0110-P7-v4.1…` | P7 v4.1 (`t2` `0x100000`): phase A in two stages, the tests in chunks on all threads, then each type's `UpdateUnit` over the flagged units only | no gain on the Haswell-128 build; `speed56` and later are built on it |
| `0113-`, `0114-`, `0115-P9…` | P9 (`t2` `0x400000`): the collision-map decision on all threads before the unit loop, exact by construction (inputs compared bitwise at the unit's turn, quad lists versioned) | +0.9% / -0.1%; most due units return at the first position comparison anyway, so the pre-check costs about what it saves |
| `0068-H90…` | H90: `MovedUnit` skips `GetQuads` while the unit stays within the distance at which none of its tests can flip (toggle `0x200000`) | +0.8%: with 128-elmo quads the nearest threshold is a few elmos away and aircraft move 5-15 a frame, so the full computation runs anyway, plus the safe-distance square roots |

H74 (0028-0031) stayed in the main line because later patches were built on
it; it is off unless bit `0x40` is set. Other experiments of the work that
were not engine patches: BOLT (needs a GNU ld link, which alone was ~4.6%
slower than gold; CRIU could not checkpoint the result) and x86-64-v3
(exact, slower) — both in the work log.

## tools/

- `luaprof-sampler/` (0046-0048): the Lua sampling profiler of the bench
  harness (go-file token `luaprof`), applies on top of 0031. Costs PGO quality
  in `lvm.cpp`, so profile with it, measure without it.
- `measure7-counters/` (0049-0051): measurement-only counters for the
  targeting scan and the aircraft loop's dependencies, cut against the
  revision-4 code (series 0013).
- `build-pgolto-g.sh`, `pgo-profile-speed22.tar.xz`: see above.
- `scripts/`: the measurement scripts of the work (paths are this host's):
  `fullrun.sh` (whole game with the thermal pause governor), `cool.sh`,
  `fans.sh`, `capall.sh`, `pkgcap.sh`, `rapl.sh` (cooling, frequency and
  power caps), `pgotrain.sh` (PGO training replays), `phases.py` (main-thread
  breakdown from folded stacks), `hotlines.py` (source lines of a function's
  samples), `memfields.py` (load-latency samples mapped to object fields),
  `luaprof.py`, `bolt.sh`, `ab.sh`, `memlines.py` (the main thread's unit-pool load latency by 64-byte line of the unit object), `lineprof.sh` (a plain-cycles trial and `perf annotate -l` of the hottest serial functions), `pgobatch.sh` (instrumented build, the training replays, the PGO+LTO build, gate, checkpoint, A/Bs), `memwatch.sh` (an engine's RSS every 2 s;
  past a limit, gdb stacks of every thread and smaps, then kill), `thpscan.py`
  (what collapsing every touched 2 MiB range would cost).
