# Speed work on top of the published series (2026-10-16/17)

The Recoil engine branches of the verylarge1 speed work
([docs/worklog-engine-speed.md](../../../docs/worklog-engine-speed.md)), as
patch files. None of them is listed in `../series`, so they are not part of
any published revision. `SeriesDigest` hashes only the files listed there
plus `../pgo/`, so adding them changes no pinned digest. Making them a
revision means listing them in `series`, which needs a new digest pinned,
a gate and a publish.

Numbering: the 4-digit prefixes continue the series (`../0001`-`0013`), so
every patch number under `engine-2026.07.04/` is unique: 0014-0043 here,
0044-0045 and 0052-0055 in `rejected/`, 0046-0051 in `tools/`. Change
identifiers continue the work log's H-series (H1-H73), with H74-H83 for the
ones below.
P1 (with its versions v2-v7), P2, N1 and the widget-side W1-W7 are families
of their own.

## Applying

From a clean checkout of the `2026.07.04` tag:

```sh
P=patches/engine-2026.07.04
git am $(grep -v '^#' $P/series | sed "s|^|$P/|")   # the published series, 0001-0013
git am $P/speed/00*.patch                          # 0014-0043, in order
```

That reproduces the work tree's branch `speed24h` exactly (checked: no
difference in `git diff`). It is `speed24`, the branch the measured builds
came from, with only identifiers in comments renamed. Build with
`-DSYNCCHECK=OFF`. Patches 0014-0017 make that configuration compile, and
the sync checker hashes every synced write: 7.9% of the late game, read only
by multiplayer desync detection. `tools/build-pgolto-g.sh` is the PGO+LTO
build used throughout (with `-g`, plus `EXTRA_CMAKE`, `LDEXTRA` and `PROFILE`
hooks). `tools/pgo-profile-speed22.tar.xz` is a PGO profile trained on this
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
| `0x80` | P1 v6 | 0034-0035 | landed aircraft and aircraft taking off in parallel | -0.8% (noise level) | on |
| `0x100` | H75 | 0036 | serial weapon loop prefetches every weapon 4 units ahead, and their targets 2 ahead | -0.5% (noise level) | on |
| `0x200` | H76 | 0037 | the unit loops' `for_mt_chunk` hand out chunks of at most 32 (the main thread waited for the slowest worker's quarter) | **-2.2%** | on |
| `0x400` | H77 | 0038 | `GenerateWeaponTargets` prefetches the candidate 6 ahead (three lines) | **-1.2%** | on |
| `0x800` | H78 | 0040 | `MovedUnit` copies the quad list instead of taking the pooled buffer (a malloc + free per move) | not measured alone | on |
| `0x1000` | H79 | 0041 | `GetQuads` finds each row's run of quads by its two ends | **-1.7%** | on |
| `0x2000` | P1 v7 | 0042 | an item passes the in-order start on before waiting for its targets | **-1.5%** | on |
| `0x4000` | H80 | 0043 | `FindAnim` searches on one packed 64-bit key | -0.4% (noise level) | on |

Not toggled (always on in these builds):

| patches | what |
|---|---|
| 0014-0017 | `SYNCCHECK=OFF` compiles: `float3::bitExactEquals`, includes, the in-synced counter kept, the sync-history dump only with the checker |
| 0021 (H72) | the per-anim checksum in `TickAllAnims` only with `SYNCCHECK` (it fed nothing else) |
| 0032 | W6: `Spring.GetUnitSampleDelta`, the capture widget's bulk sample loop in the engine (with widget W7, -7.2% of the late window, governed whole game 16m39s -> 15m25s active) |
| 0033 | clamp unsynced height-map update rectangles to the map (a symptom of the next one) |
| 0039 | **upstream bug fix**: `CRectangleOverlapHandler::StageSplitTooLarge` wrote through a reference into a vector across `push_back` (use-after-free, heap corruption; seen as an RmlUi crash at frame 78 of verylarge1 in some builds) |

## rejected/

| patch | what | measured |
|---|---|---|
| `0044-H64…` | prefetch `tempNum`/`losStatus` of the candidate 4 ahead in `GenerateWeaponTargets` (2026-10-15) | 23.32 -> 23.36 s, nothing; reverted. H77 (0038) later measured -1.2% with `aimPos` too, 6 ahead |
| `0045-H67…` | H67: prefetch height-map cells under upcoming units; H68: prefetch aircraft command-queue fronts | 19076 -> 19024 ms, -0.3%, noise (2026-10-16 04:35); dropped |
| `0052-`, `0053-H81…` | H81: skip recomputing weapon vectors whose inputs (piece transforms by a per-model change counter, the unit's script, position and direction vectors bit for bit, a height-map write counter) did not change since the last computation; in the beam laser, the weapon-vectors pass and `CWeapon::SlowUpdate` (toggle `0x8000`, on top of 0043) | on: -1.0%, mixed pairs; but the bookkeeping, always on, made the build +1.5% slower with the toggle off (speed24 vs speed26, both `t=7fbf`): a wash, dropped |
| `0054-H82…` | H82: `GenerateWeaponTargets` prefetches through the next quads (Quad 3 ahead, list header 2 ahead, pointer array 1 ahead, first 6 candidates) (toggle `0x10000`, on top of 0053) | -0.5%, noise level; dropped |
| `0055-H83…` | H83: layout only — `CSolidObject`'s direction vectors and mid/aim positions next to `physicalState`/`allyteam`, `CUnit`'s state flags (`activated`, `isDead`, `onTempHoldFire`, `deathScriptFinished`, `beingBuilt`, `stunned`, `forceUseWeapons`/`allowUseWeapons`) next to `moveType`/`script`, from the latency profile's hottest unit cache lines (on top of 0043) | +1.1% wall, +0.9% cycles, mixed pairs (2026-10-17 23:45); dropped |

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
  `luaprof.py`, `bolt.sh`, `ab.sh`, `memwatch.sh` (an engine's RSS every 2 s;
  past a limit, gdb stacks of every thread and smaps, then kill), `thpscan.py`
  (what collapsing every touched 2 MiB range would cost).
