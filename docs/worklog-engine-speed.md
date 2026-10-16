# Work log: re-simulation speed (round 3)

Branch `speed-optimization` (Recoil side: branch `speed3` in
`~/dev/barreplay-engine-build/recoil`). Newest entries at the bottom; every
entry from 2026-10-15 09:26 on carries the time (UTC). Round 1/2 history:
`patches/engine-2026.07.04/RESULTS.md` and `experiments/LOG.md` — read the
measurement rules there (interleaved pairs, never a sub-10% wall delta from
single runs on one box).

Host for this round: i7-4980HQ (4 cores / 8 threads), 15 GB RAM, no GPU;
/tmp is a 7.6 GB tmpfs (builds, captures and checkpoints live under ~/dev).

## Benchmarks

| name | gameId | what | how |
|---|---|---|---|
| **verylarge1** | `6a37d06acbb455b1d19179d8ec965f10` | late game, ~10k units, 19.5 fps | CRIU checkpoint at frame **63780**, windows of 450 / 900 frames (`tools/bench-ckpt/bench-ckpt.sh`) |
| medium | `4936896a8b258d038cbd28f55eb15ed2` | 16p 13:25, ~280 fps — TOO SMALL to judge speed by (the user's call); still the byte-identity gate | full runs |
| isthmus | `6122896ac3328104d12093d975c61214` | 8v8 27:31, ~210 fps | full runs (held-out identity check) |

## Results summary

Speed is judged on **verylarge1** from now on; the medium/isthmus numbers
below predate the checkpoint harness. "Identical" = the .brp is byte-identical
to the stock/rev-2 capture.

| candidate | identical | medium (full / bench window) | verylarge1 | verdict |
|---|---|---|---|---|
| BAR widget suite left on (sandbox) | yes | ±0 | — | no cost; dropped |
| `-worker-threads 7` | yes | ±0 | — | dropped |
| H60 FindAnim + COB DIV shift, H61 COB threaded dispatch, H62 Lua threaded dispatch | yes | instr -1.1%, wall ±0 | wall +0.8%, instr -0.2% (noise) | no late-game value |
| PGO (on H60-H62) | yes (medium, isthmus) | wall -3.8% (3/3), instr -3.3%; isthmus -4% | wall -1.9% / -3.7% (two sessions), instr -1.7..-3.3% | small |
| H63 GenerateWeaponTargets: TestTarget after LOS/range | yes (medium) | — | 23.34 s -> 23.37 s, ±0 | no value; kept (exact, harmless) |
| H64 prefetch in GenerateWeaponTargets | — | — | 23.32 s -> 23.36 s, ±0 | reverted |
| THP `always` (host setting) | — | — | 20.9 s -> 26.9-31.1 s (much WORSE) | dropped |
| PGO retrained on verylarge1's late game (`pgolto2`) | yes (medium) | — | 20.91 s -> 20.88 s, ±0 vs first PGO+LTO | no extra gain |
| CPU pinning: one hyperthread per core / main thread alone on a core | — | — | -1.1% (2/3) / -0.7% (3/3) | host setting, small; noted only |
| **PGO + LTO** (on H60-H63) = **revision 3, published** | yes (medium, isthmus, verylarge1 full 90,900 frames) | full run 1m25s -> **1m16s (-11%)** | wall **-10.2%** (3/3), instr **-15.3%** | **keep** |

## Log

(Entries before 09:26 carry only the date; their commits landed at 07:16,
07:33, 08:07, 08:41, 08:52 and 09:08.)

- 2026-10-15: BAR decides which widgets load from the saved order list
  (`LuaUI/Config/BYAR.lua`, `barwidgets.lua` ~l.1362): a name with order <= 0
  never loads, sandbox or not. barreplay already seeds that file
  (`engine.EnableWidget`), with only its own widget, because it cannot name
  BAR's. The names ARE readable from the installed rapid package
  (`packages/<md5>.sdp` -> `pool/xx/yyy.gz`): 320 of test-31630's 326
  `luaui/widgets/*.lua` declare `name = "..."` in GetInfo (242 enabled).
- 2026-10-15: MEASURED, and dropped. The gate replay `4936896a…` on the
  patched build (rev 2), two interleaved pairs, BAR's suite disabled (the old
  default) vs enabled (what the sandbox now forces):
  sim 1m26s / 1m26s disabled, 1m24s / 1m27s enabled — no difference, and the
  captures are byte-identical. The patched engine already starves the draw
  side (0001 + throttle-draw), so the suite's per-frame callins are noise.
  Not worth harvesting widget names from the archive. Back to the engine.
- 2026-10-15: `perf_event_paranoid` was 4 (Ubuntu default), which blocks perf;
  set to 1 through a privileged container (sudo docker). RESTORE to 4 when done:
  `sudo docker run --rm --privileged <img> sh -c 'echo 4 > /proc/sys/kernel/perf_event_paranoid'`.
- 2026-10-15: fresh profile, medium mid-game, rev-2 build (`~/dev/perf3/profile.sh`,
  samples the engine by argv[0]; `--call-graph dwarf` works with the
  UNSTRIPPED binary). Threads: main 52%, workers 20/14/13% — still
  main-thread-bound. Main thread: SimFrame 95% of it; inside, COB VM ~24%
  (ExecuteLoop -> TickThread -> CCobThread::Tick 7% self of ALL samples), synced
  Lua callins ~22%, WaitForFinished on for_mt sections ~26% (TickAllAnims 4.4,
  QTPFS 3.9, GroundMove 2.2, ...). Annotating Tick: ~35% is per-opcode
  fetch/dispatch, and 12% sits on ONE `idiv` (the DIV opcode).
- Host: i7-4980HQ, 4 cores / 8 threads; the engine picks 4 threads (3 workers).
- 2026-10-15: `-worker-threads 7` (use the hyper-threads): 1m25s/1m26s vs
  1m26s/1m26s default — nothing. Dropped.
- 2026-10-15: main-thread shares by area (flat profile): synced Lua 21%
  (GC only 1.6%), COB + unit-script 20%, movement 10.6%, transforms 7%,
  LOS 4.2%, map height 3.9%, QTPFS 3.7%. Branch misses (main thread): the two
  interpreters lead (luaV_execute 6.5%, CCobThread::Tick 5.4%), then
  `CUnitScript::FindAnim` 3.3% — a linear find_if over a 3-field key.
- 2026-10-15: H60 (Recoil branch `speed3` in `~/dev/barreplay-engine-build/recoil`):
  - `FindAnim`: binary search while <anims> is known sorted (animsDirty
    false), else a scan with one branch per element; same element either way
    (the key is unique).
  - COB `DIV` by a power of two as a biased shift (exact truncation).
  - first A/B (medium, 2 pairs; builds ran alongside, so timing is rough):
    1m26s/1m25s vs 1m27s/1m26s, byte-identical.
- 2026-10-15: H61 COB THREADED DISPATCH: every top-level handler ends in its
  own fetch + `goto *table[(op>>12)-0x10000]` (COB_NEXT), the switch kept as
  the entry and fallback. GCC folded the copies back into one (3 indirect
  jumps) until `#pragma GCC optimize ("no-crossjumping", "no-gcse")` around
  Tick: now 67. Measuring (bench harness: instructions + SimFrame CPU + wall
  over frames 600-24000, 3 interleaved pairs).
- 2026-10-15: RESULT H60+H61 (medium, bench harness over frames 600-24000,
  3 interleaved pairs): main-thread instructions 265.96e9 -> 262.96e9
  (-1.1%), SimFrame wall 51.35 s -> 51.13 s (-0.4%, inside the box's ±3%).
  NOTE the bench harness `_exit(0)`s after its window, so a bench run's
  capture is TRUNCATED (md5 `834d4722…` for every build) — identity is checked
  on separate full runs (`~/dev/perf3/ab.sh`, BENCH=1 for timing only).
- 2026-10-15: H62 Lua VM threaded dispatch (`lvm.cpp`, same pattern: 38
  opcodes, per-handler fetch + hook check + `goto *disptab[op]`, the switch
  kept; 40 indirect jumps after the same pragma). Byte-identical (2 full
  runs), wall 1m25s/1m26s vs 1m24s/1m26s — no visible gain. Both interpreter
  results agree with the known caveat: Haswell's indirect predictor already
  learns a shared switch jump well. Kept for now (exact), will be re-judged
  inside the final stack.
- 2026-10-15: next: PGO (-fprofile-generate -> train on replays ->
  -fprofile-use -fprofile-partial-training), `~/dev/barreplay-engine-build/pgo.sh`.
  Same official image and flags otherwise; FP semantics unchanged (no FMA,
  -frounding-math), and the gate checks byte-identity regardless.
- 2026-10-15: PGO instrumented build done (`build-pgogen`, 1296 steps, ~50
  min at -j7). Training: medium gate replay (instrumented: sim 5m31s, 73 fps,
  ~4x slower than normal) + `c04fd06a…` (BAR test-31620, 5m54s). The engine's
  quitforce exit runs the gcov dump: 1073 .gcda files, 15 MB, in
  `~/dev/barreplay-engine-build/prof`. Building with -fprofile-use now.
- 2026-10-15: RESULT PGO (on top of H60-H62), medium:
  - full runs: byte-identical to the reference (md5 `0558d354…`), sim
    1m26s/1m25s -> 1m23s/1m22s;
  - bench harness, 3 interleaved pairs: SimFrame wall 50.29 s -> 48.38 s
    (-3.8%, PGO wins 3/3), main-thread instructions -3.3%.
  Medium was a TRAINING input; held-out check on isthmus (8v8, 27:31) running.
- 2026-10-15: held-out check of PGO on isthmus (8v8 27:31, not a training
  input): byte-identical to rev 2 (md5 `acba997c…`), sim 4m02s -> 3m52s (-4%).
- 2026-10-15: USER: medium is far too small (1m40s of sim, few units); the
  slow part of a re-sim is the late game of big ones (10k units, up to 20x
  slower per frame). Asked for a harness that re-sims to a late frame ONCE,
  snapshots the state, and restarts from it. Benchmark game: "verylarge1" =
  `6a37d06acbb455b1d19179d8ec965f10` from frame 63780, windows of 15 s or 30 s
  (450 / 900 frames).
- 2026-10-15: DECISION: CRIU (process checkpoint/restore), not the engine's
  savegame and not a VM. Savegame would have to round-trip BAR's whole gadget
  Lua state, and a loaded save cannot go on reading the demo's packet stream,
  so the window after it would not be the real game. A VM snapshot is exact
  but adds virtualization overhead to every timing. CRIU restores a NATIVE
  process with exact state (all threads, the demo server included). Its one
  limit — an image restores only into the binary that made it — is handled by
  dumping each build once: builds that pass the byte-identity gate reach the
  same state at the frame.
  Making CRIU work here: root through a privileged container entering pid 1's
  namespaces (`nsenter -t 1 -m -u -i -n -p`), `--manage-cgroups=ignore`, and
  the restore inside `systemd-run --scope` (otherwise the container's exit
  kills the restored tree).
- 2026-10-15: engine side, in the bench harness (NetCommands.cpp,
  BARREPLAY_PARK=<prefix>): at the window's first frame it points
  stdout/stderr at <prefix>.stdout (no pipe to the launcher left in the
  image), writes <prefix>.ready, and sleeps (clearing the watchdog) until
  <prefix>.go exists; the go file carries "<frames> <output>" because the
  environment is frozen into the image. Perf counters open after the wake
  (CRIU cannot carry perf fds). The bench line now also reports start= and
  units=.
- 2026-10-15: `tools/bench-ckpt/bench-ckpt.sh` (dump / trial / ab): dump runs
  barreplay to the frame, copies every regular file the engine has open
  (CRIU reopens them by path; each trial puts the copies back), then
  `criu dump`; trial restores and times the window. First dump of verylarge1
  at 63780 running.
- 2026-10-15: FIRST CHECKPOINT TRIAL WORKS: verylarge1 dumped at 63780
  (12m19s of re-sim at 89 fps to get there; image 5.7 GB). Restore + a
  450-frame window: units=9961, 23.1 s of SimFrame wall = 19.5 fps (medium
  runs at ~280), 78.9e9 main-thread instructions; the whole trial, restore
  included, took 33 s.
- 2026-10-15: (event-log branch) merged origin/main (#127, widget 1.11.2
  inferred ends) into it, opened and squash-merged PR #129 (`fbedbae`), tagged
  `patched-engine/2026.7.4-barreplay.2`.

### 2026-10-15 09:28 — checkpoint harness in use; builds under test

USER: timestamps with hour/minute, tables for results, keep optimizing.

`speed-optimization` was rebased onto `main` after #129 (only the log and
`tools/bench-ckpt` were on it). Builds checkpointed at verylarge1/63780:

| build | source | checkpoint |
|---|---|---|
| `spring-headless-base` | rev 2 (`72aeecb`) + the two park commits | done (5.7 GB) |
| `spring-headless-park` | `speed3`: H60-H62 + park | done (5.7 GB) |
| `spring-headless-pgopark` | `speed3` with -fprofile-use (profile from the medium + c04fd06a runs) | dumping |

`bench-ckpt.sh` gained `PERF="<perf record args>"`: a trial then also
profiles exactly its window (attaches to the restored pid before the go).

### 2026-10-15 09:55 — first verylarge1 results: the late game is somewhere else

verylarge1 from 63780, 450-frame windows, 3 rounds with the build order
rotated (raw: `~/dev/perf3/vl1-3way.txt`). Every trial starts at 9961 units.

| build | SimFrame wall, mean (3 runs) | vs base | main-thread instructions, mean | vs base |
|---|---|---|---|---|
| base (rev 2 + park) | 23.07 s (23.21 / 23.09 / 22.93) | — | 78.66e9 | — |
| speed3 (H60-H62) | 23.27 s (23.11 / 23.16 / 23.53) | +0.8% | 78.50e9 | -0.2% |
| speed3 + PGO | 22.64 s (22.54 / 22.75 / 22.62) | **-1.9%** | 76.03e9 | -3.3% |

At 19.5 fps the late game is ~14x slower per frame than medium's average,
and what helped there (the interpreters) is noise here. Run-to-run spread on
one checkpoint is ~1.5% of wall, ~1% of instructions. Next: profile this
window (bench-ckpt `PERF=`).

### 2026-10-15 10:12 — late-game profile (verylarge1, base build)

`PERF="-F 999 -e cycles"` over the 450-frame window. Threads: main 63.8%,
workers 12.3 / 11.8 / 11.8% — MORE main-bound than medium (52%). Main-thread
self time, as a share of the MAIN thread:

| function | share | note |
|---|---|---|
| luaH_get | 7.4% | BAR gadget table lookups |
| luaV_execute | 6.9% | |
| **CSyncChecker::Sync** | **4.7%** | one out-of-line call + XXH3 per synced write |
| GeneralMoveSystem::Update | 4.6% | |
| CLosHandler::Update lambda | 4.2% | |
| CGameHelper::GenerateWeaponTargets | 3.8% | |
| CUnit::UpdateWeapons | 3.7% | |
| CStrafeAirMoveType::Update + UpdateAirPhysics | 6.1% | aircraft |
| CGround::GetHeightReal + GetHeightAboveWater | 5.4% | |
| AMoveType::UpdateCollisionMap | 2.8% | |
| luaD_precall | 2.7% | |
| spring::VectorErase<CUnit*> | 1.0% | linear erase over a unit list |

DWARF call graphs (`--call-graph dwarf`) did not unwind on the CRIU-restored
process and `perf script` over the 800 MB debug info is too slow; working from
self time + source.

`CSyncChecker::Sync(const void*, unsigned)` is in SyncChecker.cpp, so every
synced primitive write is a call with a RUNTIME size into XXH3's length
dispatch, to hash 4 bytes. Inlining it with the size known computes the same
value; that is a header change that recompiles everything, i.e. the same cost
as LTO, which does it (and every other cross-file hot call) automatically. So
the next build is PGO + LTO (`pgo.sh ltouse`, -flto=4, no -g), building now.

### 2026-10-15 10:30 — what the late-game hot spots are made of

| hot spot | finding | action |
|---|---|---|
| `luaH_get` (7.4%) | annotated: ~50% of its samples on chain-walk loads (`cmpl $type,0x18(node)` after `mov 0x20(node)`), ~20% loading the key string's hash, the number path's `div` (hashmod) only ~3.5% | memory latency on BAR's tables; an exact fastmod would buy ~0.2% — not worth a patch |
| `spring::VectorErase<CUnit*>` (1.0%) | QuadField::MovedUnit swap-erases then re-inserts a moving unit in EVERY cell, even unchanged ones; the resulting order of units in a cell feeds unit queries (targeting) | cannot be shortcut without changing sim order — left alone |
| `CSyncChecker::Sync` (4.7%) | out-of-line call per synced write, runtime size into XXH3 | LTO (building) |

Plan: (1) PGO+LTO (building); (2) RE-TRAIN the PGO profile on verylarge1's
late game — the current profile is from medium + c04fd06a, small games that
never exercise mass air/targeting/LOS. The instrumented run must stop after a
late window, but the bench harness leaves by `_exit`, which skips gcov's
dump: add a weak `__gcov_dump()` call before it (a no-op in normal builds).

### 2026-10-15 10:45 — flame graphs; LTO link fix

USER: include flame graphs in the log now and then.

DWARF unwinding failed on the CRIU-restored engine, but Haswell's **LBR call
stacks** (`perf record --call-graph lbr`) need neither frame pointers nor
debug info and work there (~16 frames deep — enough to see who calls the hot
leaves). New subcommand: `bench-ckpt.sh flame <bin> <replay> <frame> <frames>
<out.svg>` (FlameGraph scripts in ~/dev/FlameGraph). Flame graphs go to
`docs/flamegraphs/`; the first clean one comes after the LTO build (a test
run made during the build already put weapon auto-targeting —
SlowUpdateWeapons → AutoTarget → GenerateWeaponTargets — and the LOS update
at the top).

PGO+LTO's first link failed: "undefined reference to mi_new /
SpringVersion::GetMajor" — the static libraries were archived by plain `ar`,
which writes no LTO symbol index. Reconfigured with gcc-ar-13 / gcc-ranlib-13
(only 31 steps: re-archive + link).

### 2026-10-15 11:00 — PGO + LTO: -10% on the late game

`spring-headless-pgolto` (speed3 + park, -O3 -flto=4 -fprofile-use, no -g;
101 MB unstripped). Medium full run: byte-identical (md5 `0558d354…`), sim
1m16s vs ~1m25s for the same source without them.

verylarge1 from 63780, 450 frames, 3 rounds, order rotated (raw:
`~/dev/perf3/vl1-lto.txt`):

| build | wall per round (ms) | mean | vs base | instructions, mean | vs base |
|---|---|---|---|---|---|
| base | 23310 / 23064 / 23117 | 23163 | — | 78.18e9 | — |
| PGO | 22276 / 22247 / 22377 | 22300 | -3.7% | 76.82e9 | -1.7% |
| **PGO + LTO** | 20933 / 20717 / 20759 | **20803** | **-10.2%** | **66.25e9** | **-15.3%** |

LTO is most of it: cross-file inlining — `CSyncChecker::Sync` (4.7% of the
main thread) is one obvious beneficiary.

Next: retrain PGO on verylarge1's LATE game. The bench harness now calls a
weak `__gcov_dump()` before `_exit`, so an instrumented run stops right after
a late window with its profile written: running to 63780+1800 now (~1 h at
~4x instrumented slowdown).

Lesson (now enforced by bench-ckpt `alone`): a trial during that training run
failed — the restored engine wants its UDP game-server port back ("Address
already in use") — and its file restore had copied the checkpoint's infolog
and widget stream over the training run's own (same game, same data dir).
Harmless for training (only the .gcda files matter), but no engine may run
beside a dump or a trial.

### 2026-10-15 10:50 — where the late-game main thread goes (by caller)

From an LBR sample of the verylarge1 window (recorded during a build, so
shares only), stacks summed by their two outermost frames:

| caller path | share of main-thread samples |
|---|---|
| CUnitHandler::SlowUpdateUnits -> CUnit::SlowUpdateWeapons (auto-targeting) | 11.1% |
| CUnitHandler::UpdateUnitWeapons -> CUnit::UpdateWeapons | 6.6% |
| CUnitScriptEngine::Tick -> ThreadPool::WaitForFinished (parallel anims) | 5.9% |
| UpdateUnitMoveTypes -> GeneralMoveSystem::Update (StrafeAir 3.2%) | 4.7% |
| CGame::SimFrame -> CLosHandler::Update (for_mt over ~7 LOS types; the main thread waits for the slowest) | 4.5% |
| luaD_precall -> luaB_pcall (gadgets) | 3.1% |
| CUnitHandler::Update -> CUnit::UpdateLosStatus | 2.8% |

**H63** (built as `spring-headless-h63`, speed3 + H63, no PGO; to be
A/B'd against `spring-headless-park` once the training run frees the host):
`CGameHelper::GenerateWeaponTargets` called the virtual, const
`weapon->TestTarget()` — a dozen reads of each candidate CUnit — BEFORE the
cheap LOS-state and 2D-range rejections that most of the thousands of
candidates in the scanned quads fail. Moved after them. Exact: every check is
a pure function of state the loop does not change before AllowWeaponTarget,
and TestTarget's own LOS test is a subset of the loop's; the same units pass
in the same order with the same priorities.

### 2026-10-15 11:50 — late-game PGO training wrote nothing; fixed

The verylarge1 training run (63780+1800 frames, 251 s of instrumented
SimFrame) completed but left every .gcda at its 10:42 timestamp: in the
instrumented binary `__gcov_dump` was a weak UNDEFINED symbol (`nm`: `w`) — a
linker does not pull an archive member in to satisfy a weak reference, so the
call resolved to null and was skipped. Fixed at link time only: the
instrumented build links with `-Wl,-u,__gcov_dump` (now `T __gcov_dump`), the
code keeps its weak reference (a no-op in normal builds). Rerunning the
training after the H63 checkpoint.

### 2026-10-15 12:15 — H63 measured: nothing

verylarge1 from 63780, 450 frames, 3 interleaved pairs (`bench-ckpt.sh ab`):

| pair | speed3 (`park`) wall ms | speed3 + H63 wall ms |
|---|---|---|
| 1 | 23587 | 23561 |
| 2 | 23206 | 23149 |
| 3 | 23217 | 23394 |
| mean | 23337 | 23368 (+0.1%) |

Byte-identical on medium (`0558d354…`). TestTarget was not the cost of
auto-targeting: the loop's time is walking thousands of candidate CUnits (a
cache miss each on `tempNum`/`losStatus`), which no reordering inside the loop
avoids. Late-game PGO training rerunning now (fixed gcov dump).

`bench-ckpt` `alone` fix: it matched its own caller's command line (a `strip`
of an engine binary in the same shell command); now anchored to processes
whose argv[0] is an engine binary.

### 2026-10-15 12:55 — late-game profile collected; H64 prefetch; rebuilding PGO+LTO

The rerun wrote its profile (gcda timestamps 12:50): instrumented
verylarge1 63780+1800 frames, 250.7 s of SimFrame. The profile dir now holds
medium + c04fd06a + verylarge1's whole game up to frame 65580 (counters
accumulate). PGO+LTO rebuilding from it (full recompile: every object's
profile changed).

**H64** (`spring-headless-h64`): the auto-targeting walk is a cache miss per
candidate unit, so `GenerateWeaponTargets` now prefetches the `tempNum` and
`losStatus[allyteam]` lines of the candidate 4 entries ahead
(`__builtin_prefetch`; changes no value). If it pays, the same applies to the
per-unit loops over the 10k active units (UpdateUnits, UpdateUnitWeapons,
LOS status). Checkpoint dumping alongside the build; trials once the host is
quiet.

### 2026-10-15 13:10 — H64 measured: nothing (reverted); the PGO rebuild had not rebuilt

| pair | H63 wall ms | H63 + H64 wall ms |
|---|---|---|
| 1 | 23281 | 23407 |
| 2 | 23474 | 23035 |
| 3 | 23194 | 23628 |
| mean | 23316 | 23357 |

Prefetching the candidates did nothing: either the out-of-order core
already overlaps those misses or the time is elsewhere in the loop. Reverted,
which also puts the source back exactly where the instrumented build was, so
the late-game profile matches every function.

The "PGO+LTO from the new profile" build finished in 10 minutes having
recompiled 3 files: the .gcda files are not ninja dependencies, so a changed
profile alone rebuilds nothing — and under LTO the profile is applied when
each object is compiled, so a relink does not pick it up either. `ninja -t
clean` and rebuilding (~1 h). Lesson for pgo.sh: a new profile needs a clean
build dir.

### 2026-10-15 13:15 — flame graph: verylarge1 late game, PGO+LTO build

![verylarge1 late game, PGO+LTO, main thread](flamegraphs/2026-10-15-verylarge1-pgolto.svg)

([open the SVG](flamegraphs/2026-10-15-verylarge1-pgolto.svg) for the
interactive version — hover and click to zoom.) Main thread of the
450-frame window from 63780 (9961 units), LBR call stacks (≤16 frames, so
deep stacks start part-way up). Recorded while a build was running, so its
own wall time (34 s) is not comparable; the shape is what matters.

| caller > callee | share of main-thread samples |
|---|---|
| CGame::SimFrame > CUnitHandler::Update | 12.4% |
| CUnitHandler::Update > CWeapon::SlowUpdate (auto-targeting) | 10.0% |
| CUnitHandler::Update > CStrafeAirMoveType::Update (aircraft) | 6.5% |
| CGame::SimFrame > ThreadPool::WaitForFinished | 5.2% |
| CUnitHandler::Update > CUnit::SlowUpdate | 4.5% |
| CGame::SimFrame > CLosHandler::Update | 4.4% |
| CUnitHandler::Update > **CBeamLaser::Update** | 4.3% |
| CUnitHandler::Update > WaitForFinished (UpdateWeaponVectors for_mt) | 3.3% |
| CGame::SimFrame > CCobThread::Tick | 3.3% |

| leaf (self) | share |
|---|---|
| CUnitHandler::Update (LTO inlined unit/weapon/move code into it) | 9.9% |
| luaV_execute / luaV_gettable / luaD_precall | 5.5 / 4.7 / 2.6% |
| CUnitScript::TickAllAnims | 3.8% |
| CGameHelper::GenerateWeaponTargets | 3.5% |
| CStrafeAirMoveType::UpdateAirPhysics / UpdateFlying | 2.8 / 1.9% |
| CWeapon::UpdateWeaponVectors | 2.7% |

New candidates from it: **CBeamLaser::Update (4.3%)** — beam weapons — and
the aircraft move type (6.5%).

### 2026-10-15 13:25 — next: huge pages

`CBeamLaser::Update` recomputes its weapon vectors on the main thread right
after `UpdateUnitWeapons` computed every unit's in parallel — but not
removable: an earlier weapon of the same unit can fire in between and its
script may `turn ... now` a piece, so the second computation can differ.

The late game is memory-latency-bound (luaH_get, the targeting walk), with a
~5 GB working set — TLB-miss territory. The host's THP mode is `madvise`
(`AnonHugePages: 0 kB`): nothing in the engine asks for huge pages (not
mimalloc's heap, not the big .bss StaticMemPools). Huge pages cannot change
a simulated value. Experiment planned: CRIU restores memory into fresh
anonymous mappings, so toggling `/sys/kernel/mm/transparent_hugepage/enabled`
between `always` and `madvise` across trials of ONE checkpoint measures the
potential without a new dump. If it pays, the engine can `madvise` its own
pools and set mimalloc's large-page option, which works under the `madvise`
default every host has.

### 2026-10-15 13:40 — huge pages: much worse

PGO+LTO checkpoint, THP mode toggled between trials (3 pairs):

| pair | THP madvise (default) wall ms | THP always wall ms |
|---|---|---|
| 1 | 21081 | 31149 |
| 2 | 20795 | 26903 |
| 3 | 20918 | 27852 |

`always` costs 30-50%: on this 15 GB host, mostly page cache, building huge
pages for the restored 5 GB means compaction stalls inside the window.
Dropped (and it would have been a per-host setting anyway). THP back to
`madvise`.

Next: the PGO+LTO build retrained on the late game (`spring-headless-pgolto2`,
clean build) — identity on medium, then its checkpoint.

### 2026-10-15 14:15 — late-game PGO profile: no extra gain; CPU pinning: ~1%

`spring-headless-pgolto2` = PGO+LTO from a CLEAN build with the profile now
also covering verylarge1 up to frame 65580. Byte-identical on medium
(`0558d354…`, sim 1m16s). Its checkpoint dump is a useful whole-run number:
reaching frame 63780 took **10m12s at 104 fps vs 12m00s at 89 fps** for the
base build (-15% over the first 35 minutes of a big game).

verylarge1 450 frames, `pgolto` (first profile) vs `pgolto2`, 3 pairs:
20579/21109/21028 (mean 20905) vs 20884/21050/20705 (mean 20880) — the same.
The small-game profile already put the code in the right shape.

CPU placement (`bench-ckpt` `CPUSET=` / `MAINCPU= OTHERCPUS=`, new options;
host: CPUs 0-3 one thread per core, 4-7 their siblings), `pgolto2`, 3 pairs:

| placement | mean wall ms | vs unpinned |
|---|---|---|
| unpinned (all 8) | 20771 / 20732 | — |
| all threads on 0-3 (no hyperthread siblings) | 20548 | -1.1% (2/3 wins) |
| main thread alone on 0, the rest on 1-3,5-7 | 20586 | -0.7% (3/3 wins) |

A worker spinning on the main thread's sibling costs little here. It is a
per-host setting anyway (bringest could set it) — recorded, not pursued.

**Where this leaves round 3:** PGO+LTO is the one large win (-10% on the late
game, -11% medium, -15% over a big game's first 35 min, byte-identical).
Everything targeted since — interpreter dispatch, targeting reorder,
prefetching, huge pages, retraining, pinning — measured at noise or worse.

### 2026-10-15 14:00 — preparing revision 3 (PGO + LTO); identity gate on verylarge1 running

The flat profile of `pgolto2` on verylarge1: main thread 63.9%, workers
~12% each; `CSyncChecker::Sync` fell from 4.7% to **0.84%** of the main
thread (LTO inlined most calls); the top is now `CUnitHandler::Update` with
the unit code LTO folded into it (12.8%), `luaV_gettable` 5.0%,
`TickAllAnims` 4.4%, `luaV_execute` 3.9%, the LOS update 3.4%,
`GenerateWeaponTargets` 3.3%. A thin spread again.

PGO+LTO is the gain worth shipping, so it gets a stronger identity gate than
medium: full re-sims of verylarge1 (~10k units, the whole late game) on the
base build and on `pgolto2`, .brp md5 compared. Running.

Revision 3 of `patches/engine-2026.07.04/` (prepared, NOT pinned until that
gate passes):

| patch | content |
|---|---|
| 0005-bench-harness-park-and-gcov-dump | PARK point + go file + weak `__gcov_dump` before `_exit` (one patch from three commits) |
| 0006-findanim-and-cob-div-shift | H60 |
| 0007-cob-threaded-dispatch | H61 |
| 0008-lua-threaded-dispatch | H62 |
| 0009-weapon-targets-testtarget-last | H63 |
| `pgo/profile.tar.xz` | the training profile (16 MB of .gcda, 1.1 MB xz; deterministic tar) |
| `pgo/build.sh` | the PGO+LTO build (and the instrumented `gen` build) in the official image |

H60-H63 measured at noise on the late game but are kept: they are exact,
and the profile was trained on that source (dropping them would orphan
those functions' profile). `git am` of the series onto a clean 2026.07.04
checkout reproduces the trained/built tree exactly (0 diff lines in `rts/`).

`SeriesDigest` now also hashes every file under `pgo/` (sorted), so a new
profile or new flags is a new revision like a changed patch; revisions 1 and 2
(no pgo/) keep their digests. Test: `TestSeriesDigestTracksThePGODir`.

### 2026-10-15 14:20 — revision 3 builds from the series

`pgo/build.sh` built `spring-headless` from a fresh clone of the series
(`2026.07.04-22-gc9fac20`, 101.9 MB unstripped) in ~15 min. Two fixes on
the way, both now in the script and its header:

| problem | fix |
|---|---|
| "Failed to fetch git-describe" | the source must be a real clone with the tag — a git WORKTREE's `.git` points outside the mounted tree |
| root-owned leftovers of a failed build blocked `rm` | the container cleans `/build/out` itself (also guarantees the clean build a new profile needs) and `chown`s the output and profile back to the caller |

The verylarge1 full-run identity gate is still running (base build at frame
68400 after 22 min; slowed by the build).

### 2026-10-15 15:05 — gate passed on the whole big game; revision 3 published

verylarge1 re-simulated end to end (90,900 frames) on the base build and on
`pgolto2`:

| build | sim | fps | .brp md5 |
|---|---|---|---|
| base (rev 2 + park) | 37m54s | 40 | `a26e920d594a346884b93c3389053a1f` |
| PGO + LTO (`pgolto2`) | 27m12s | 56 | `a26e920d594a346884b93c3389053a1f` |

**Byte-identical over the whole game.** The wall times are NOT a fair
comparison: the revision-3 builds ran during part of the base run. A clean
rerun of base is queued for the headline number.

Pinned and published:

| item | value |
|---|---|
| series digest (revision 3) | `8b5780d6c6eddca16aebc59143854857f7ea133f34a9ce1c932089914f332ea4` |
| build | `pgo/build.sh` from a fresh clone of the series (`2026.07.04-22-gc9fac20`) |
| publish-engine gate (medium, stock vs stripped rev 3) | identical (capture sha256 `1facff5b…`) |
| published | `engines/2026.07.04/spring-headless-patched-2026.7.4-barreplay.3.gz`, 36 MB (13 MB gz) |
| sha256 (pinned in `patchedBuilds`, rev 1 and 2 superseded) | `2ea1aecf0528606631625c636fe3eb31905cab145371800ca1a42d8cdb4e9d74` — the public download hashes to it |

Docs: `docs/building-recoil.md` ("PGO + LTO"), RESULTS.md (round-3 pointer),
CLAUDE.md ("Benchmarking the late game"). Hosts pick it up once this branch is
merged (the pin is what they trust); after the merge:
`git tag -a patched-engine/2026.7.4-barreplay.3 … origin/main`.

### 2026-10-15 15:45 — the whole big game, measured cleanly: -12.4%

verylarge1, all 90,900 frames, each run alone on the host:

| build | sim | fps | .brp md5 |
|---|---|---|---|
| base (rev 2 + park), clean rerun | 31m03s | 49 | `a26e920d594a346884b93c3389053a1f` |
| PGO + LTO (`pgolto2`, = revision 3's code) | 27m12s | 56 | `a26e920d594a346884b93c3389053a1f` |
| | **-12.4%** | | identical |

(The earlier 37m54s base run had builds beside it; this replaces it.)

### 2026-10-16 01:02 — where the main thread's time goes (verylarge1 late window)

USER: report the main thread as % of ONE core (rows sum to 100%), workers
separately; only the late window matters, and only the main thread needs
optimizing. Published build (`pgolto2`), frames 63780+450, 9961 units.

**Threads** (task-clock sampling, 999 Hz):

| thread | CPU over the window | % of one core |
|---|---|---|
| main | 21.2 s (SimFrame thread-CPU 21,217 ms of 21,219 ms wall) | **~100%** — never sleeps |
| worker 1 / 2 / 3 | 4.4 / 4.2 / 4.2 s | ~20% each |

Workers run only the parallel sections (TickAllAnims, UpdateWeaponVectors,
LOS, projectile/weapon for_mt chunks, QTPFS node layers). The main thread
is CPU-bound; it does its share of each parallel section itself
(`WaitForFinished` self time 0.3%), so it is not waiting idle.

**Main thread, % of one core** (LBR call stacks, cycles at 1999 Hz; each
stack goes to the first phase found in it — 0.3% could not be placed;
script: phases.py, kept with the perf data):

| phase | % of core | of which Lua |
|---|---|---|
| **units** (`CUnitHandler::Update`) | **62.5%** | 6.9% |
| ├ LTO-inlined unit/weapon code (no debug info to split) | 12.5% | |
| ├ aircraft: `CStrafeAirMoveType::Update` | 11.4% | 0.9% |
| ├ weapon auto-targeting: `CWeapon::SlowUpdate` | 9.3% | 2.8% |
| ├ ground movement: `GroundMoveSystem::Update` | 5.3% | |
| ├ weapon vectors (parallel section) | 4.6% | |
| ├ `CUnit::SlowUpdate` | 4.3% | 0.6% |
| ├ `CBeamLaser::Update` | 3.6% | 1.1% |
| ├ `CWeapon::Update` | 2.4% | |
| ├ `CQuadField::MovedUnit` | 2.1% | |
| └ factories, builders, physics, LOS status, hover air, ... | 7.0% | |
| BAR gadget callins outside units (GameFrame etc.) | 11.7% | 11.7% |
| projectiles + collisions | 5.6% | 1.3% |
| unit-script anims (parallel section) | 5.4% | |
| LOS update (parallel section) | 4.2% | |
| COB scripts | 3.5% | |
| Lua GC | 2.1% | 2.1% |
| map damage, pathfinding, features, draw, net, other | 5.0% | |
| **total** | **100%** | **~22%** |

Serial work is ~85% of the main thread (parallel sections ~14%). Caveat:
LBR keeps the 16 innermost frames, so a gadget callin made from deep in a
unit update can land under "outside units" when its stack was cut.

## Round 4 (branch `speed-optimization-2`)

Everything below is measured on the verylarge1 late window only (frames
63780+450) and reported as the MAIN thread's time, % of one core, rows
summing to 100% — the main thread is the whole bottleneck (see 01:02).

### 2026-10-16 01:35 — plan, and two measurement tools under way

| step | what | status |
|---|---|---|
| 1 | revision 3 rebuilt WITH debug info (`-g`: GCC emits the same code), own checkpoint — splits the 12.5% LTO-merged `CUnitHandler::Update` blob and gives per-line annotation | building (`~/dev/perf3/build-pgolto-g.sh`) |
| 2 | aircraft movement (11.4%): exact-result speedups | profiled, waiting on step 1's lines |
| 3 | weapon auto-targeting (9.3%) | queued |
| 4 | BAR's Lua (~22%) by gadget: a sampling profiler in the bench harness | written (Recoil branch `luaprof`); build queued after step 1 |

Aircraft's 11.4%, from the 01:02 stacks:

| part of `CStrafeAirMoveType::Update` | % of core |
|---|---|
| `UpdateFlying` → `UpdateAirPhysics` | 4.7% |
| `Update` itself (inlined helpers) | 2.3% |
| `UpdateFlying` itself | 1.5% |
| `GetControlSurfaceAngles` | 1.1% |
| crash deaths → `ForcedKillUnit` → Lua `UnitDestroyed` | 0.9% |
| other (`UpdateAirPhysics` direct, `Move`, heading, sync checks) | 0.9% |
| **total** | **11.4%** |

THE LUA PROFILER (measurement builds only, never published): every
`luaV_execute` records which `lua_State` the thread is running (a
thread-local set/restored by an RAII guard, so exceptions unwind it); a
`CLOCK_THREAD_CPUTIME_ID` timer sends the main thread SIGPROF every 1 ms of
ITS CPU time, and the handler walks that state's CallInfo array — reading
only, no allocation, no Lua API — interning each frame (Lua: source file +
line defined; C: function pointer, symbolized later against `nm`). Samples
outside Lua are counted too, so the gadget table is a share of the same one
core. `bench-ckpt.sh trial` with `LUAPROF=1` asks for it (third token of
the go file); the folded stacks land in `<ckpt>/result.luaprof`.

### 2026-10-16 02:30 — the 12.5% blob is four loops waiting on memory; H65, H66

Debug-info build (`spring-headless-pgolto2g`, own checkpoint): same layout
as revision 3 (every function at the same address and size; constants moved
by the debug info, so not bit-identical) and the same table within 0.3 points
per row (21.06 s window). The 12.5% LTO folded into `CUnitHandler::Update`,
by the call it inlined, as % of the main core:

| loop over all ~10k units | % of core | where it stalls |
|---|---|---|
| `UpdateUnits` (`CUnit::Update`, `UpdateCollisionMap`) | 3.3% | first read of each unit (`frameNum + owner->id`) |
| `UpdateUnitMoveTypes` (general move types) | 3.1% | unit → `moveType` → vtable, before the virtual `Update()` |
| `UpdateUnitWeapons` (the serial `UpdateWeapons` loop) | 2.9% | weapon-use flags, then each weapon's vtable |
| `UpdateUnitLosStates` | 2.5% | `losStatus[at]`, first read of each unit |
| `SlowUpdateUnits`, `QueueDeleteUnits` | 0.6% | |
| **total** | **12.5%** | |

Annotated, the hot instructions are the ones right after a pointer load
(`mov 0x4f8(%rbp),%rdi; mov (%rdi),%rax` = 9.6% of the blob, `mov
0xc0(%rax)` 9.1%, `call *0x40(%rax)` 9.0%): cache misses on scattered unit
objects, not computation.

Candidates (Recoil branch `speed4` = revision 3 + these; building):

| id | change | why it is exact |
|---|---|---|
| H65 | Lua callin timers (`Lua::Callins::*`, 4 clock reads + 2 profile-map updates per callin, ~1.0% of the core, half in `AllowWeaponTarget`) run only while the profiler is on (`/debug`, barreplay `-profile`) | timings are never sim input |
| H66 | software prefetch 8 units ahead (and the move type / first weapon 4 ahead) in those four loops | a prefetch changes no value and no order; the general-move-system loop first collects its units in the view's own order (a read-only pass) |

Lua profiler build done; its checkpoint is being dumped.

### 2026-10-16 03:05 — the Lua profile: our own widget is the biggest Lua cost

Lua sampler build (`spring-headless-luaprof` = revision 3 + the sampler; its
window ran 20.75 s, so the sampler costs nothing visible). 21,203 samples of
main-thread CPU, 3,690 of them inside a Lua VM = **17.4% of the main core**
(perf's ~22% also counts callin entry/exit and GC, which run outside the VM).
Each sample goes to the innermost gadget/widget FILE on its Lua stack (handler
plumbing skipped); `~/dev/perf3/luaprof.py` makes the table.

| owner | % of main core | where |
|---|---|---|
| **LuaUI (widgets)** | **7.5%** | |
| ├ `snapshot_widget.lua` — barreplay's OWN re-sim widget | **4.55%** | `sample()` 2.16% (the 1 Hz unit read), `projectileFrame` 1.31% (polls `reloadFrame` of every ready launcher slot, every frame), `UnitDestroyed` 0.39% |
| ├ BAR `widget_profiling.lua` (wraps every widget callin) | 1.41% | `GetLuaMemUsage` 0.48% |
| ├ BAR `barwidgets.lua` (handler dispatch) | 0.75% | |
| └ BAR widgets (ecostats, notifications, nametags, ...) | ~0.8% | |
| **LuaRules (gadgets)** | **9.8%** | |
| ├ `gadgets.lua` (handler dispatch) | 2.92% | |
| ├ `unit_shield_behaviour` | 1.06% | `GetUnitsInSphere` |
| ├ `unit_aa_targeting_priority` (its `AllowWeaponTarget`) | 0.60% | `GetUnitDefID` 0.30% |
| ├ `unit_builder_priority` | 0.55% | |
| ├ `api_teamstats`, `unit_crashing_aircraft`, `api_unit_attributes` | 1.05% | |
| └ ~60 other gadgets | ~3.6% | each < 0.3% |
| other | 0.1% | |
| **total in Lua** | **17.4%** | |

WHY BAR's widget profiler runs at all: the Widget Selector always loads and
its load column defaults ON (`filters.profiler = data.profiler ~= false` for
a config that never saved it), which subscribes to `widget_profiling.lua` —
a timer and a `GetLuaMemUsage` call around every callin of every widget.

**W1** (barreplay, no engine change): the widget config barreplay seeds for
every re-sim (`engine.widgetConfigLua`) now carries
`data = { ["Widget Selector"] = { profiler = false } }`. Unsynced, so the
capture cannot change. Being measured: fresh checkpoints of revision 3
(`pgolto2w`) and of `speed4` (H65+H66), both with the new config.

### 2026-10-16 03:20 — W1 -2.4%, H65+H66 another -5.3%: -7.6% together

Fresh checkpoints at 63780 for revision 3 under the new widget config
(`pgolto2w`, same binary as `pgolto2`) and for `speed4` (revision 3 + H65 +
H66, new config). 450-frame window, 4 rounds, order rotated, main thread
pinned alone on core 3 (`MAINCPU=3 OTHERCPUS=0,1,2,4,5,6`; 7 is 3's
hyperthread). Raw: `~/dev/perf3/vl1-w1-h65h66.txt`.

| build | wall per round (ms) | mean | vs revision 3 | instructions, mean |
|---|---|---|---|---|
| revision 3 | 20732 / 20702 / 20584 / 20662 | 20670 | — | 66.73e9 |
| + W1 (selector profiler off) | 20162 / 20222 / 20221 / 20097 | 20176 | **-2.4%** | 65.03e9 |
| + W1 + H65 + H66 (`speed4`) | 19057 / 18956 / 19052 / 19325 | 19098 | **-7.6%** (-5.3% on W1) | 64.76e9 |

No overlap between the groups. `speed4` runs ~the same instructions as W1
and 5% fewer cycles: the prefetches hiding memory stalls, as intended. (H65
and H66 are not yet measured apart.)

Gate (medium, full run, new config): `speed4` and revision 3 both
`0558d3540c8e3f97d669505d1382ec20` = the reference. verylarge1 full run on
`speed4` running.

### 2026-10-16 03:45 — `speed4` identical on verylarge1's whole game; H67, H68 built

| check | result |
|---|---|
| verylarge1, all 90,900 frames, `speed4` + W1 | `a26e920d594a346884b93c3389053a1f` = stock / revision 3 (its 33m21s is NOT a timing: a build shared the CPU) |

Next build `speed5` = `speed4` + two more prefetches, aimed at the hottest
lines of the debug-info profile (global, main thread):

| id | stall it targets | % of core | change |
|---|---|---|---|
| H67 | terrain height reads (`InterpolateCornerHeight`, Ground.cpp:51: the height-map load), from unit physics 0.83%, aircraft flight control 1.35%, weapon vectors 0.5% | 3.1% | `CGround::PrefetchHeightReal(x, z)` for the unit 4 ahead in the `UpdateUnits` and general-move-type loops |
| H68 | `CStrafeAirMoveType::Update` reading `cmdQue.front()` (StrafeAirMoveType.cpp:470) | 0.75% | prefetch the command AI 4 ahead and its queue front 2 ahead in the general-move-type loop |

### 2026-10-16 04:35 — H67+H68: nothing; 7 ThreadPool threads: -6.0%

| comparison (4 rounds each, order rotated) | A mean | B mean | delta |
|---|---|---|---|
| `speed4` vs `speed5` (+H67 height-map prefetch, +H68 command-queue prefetch), pinned | 19076 ms | 19024 ms | -0.3%, noise: **dropped** |
| `speed4` default threads vs `-worker-threads 7`, unpinned | 19165 ms | 18015 ms | **-6.0%** (every round: 18157 / 17985 / 17900 / 18019 vs 19079 / 19105 / 19347 / 19128) |

`WorkerThreadCount` counts the MAIN thread too ("Number of workers
(including the main thread!)"); auto (-1) gives main + 3 here (4 cores), 7
gives main + 6 workers on the hyperthreads. It was measured as nothing on
medium in round 3's first hours, because a mid-size game has little parallel
work; this late window spends 15.6% of the main thread inside parallel
sections (anims 6.0, weapon vectors 5.0, LOS 4.6), and the main thread runs
its own share of each, which drops from 1/4 to 1/7. Scheduling only; medium
full run with 7: `0558d354…` = the reference. verylarge1 whole game with 7
running. (`bench-ckpt.sh dump` gained BARREPLAY_ARGS for such variants.)

Main thread of `speed4` (default threads), % of one core, for the record:

| phase | % of core | of which Lua |
|---|---|---|
| units | 61.5% | 5.4% |
| ├ aircraft (`CStrafeAirMoveType::Update`) | 12.1% | 0.8% |
| ├ weapon auto-targeting (`CWeapon::SlowUpdate`) | 9.4% | 1.9% |
| ├ ground movement | 5.8% | |
| ├ LTO-inlined unit loops (was 12.5%) | 5.7% | |
| ├ weapon vectors (parallel) | 5.0% | |
| ├ `CUnit::SlowUpdate` | 4.7% | 0.4% |
| ├ beam lasers | 3.9% | 1.1% |
| └ other unit work (weapon update, `CUnit::Update`, quad field, LOS checks, factories, builders, hover air) | 14.9% | 1.0% |
| BAR gadget callins outside units | 11.4% | 11.4% |
| projectiles + collisions | 6.0% | 1.4% |
| unit-script anims (parallel) | 6.0% | |
| LOS update (parallel) | 4.6% | |
| COB scripts | 4.0% | |
| Lua GC | 1.5% | 1.5% |
| map damage, pathfinding, features, draw, net, other | 5.0% | |
| **total** | **100%** | **~21%** |

### 2026-10-16 05:30 — GOAL: verylarge1 whole game in 10 minutes (was 5); where that time must come from

USER set the goal: the whole of verylarge1 re-simulated in 10 minutes,
byte-identical (first 5, then 10). Revision 3 takes 27m12s.

Whole game, `speed4` + W1 + `-worker-threads 7`: **sim 24m08s**, md5
`a26e920d…` (identical). -11% on revision 3. Time per game phase (from the
infolog's wall clock at each frame marker):

| game time | wall | frames/s | share |
|---|---|---|---|
| 0-10 min | 28 s | 650 | 1.9% |
| 10-20 min | 105 s | 170 | 7.3% |
| 20-30 min | 192 s | 94 | 13.4% |
| 30-51 min | 1111 s | 27-48 | **77.4%** |

So 10 minutes needs the late game ~2.5x faster per frame. What the main
thread's cycles are, over the 450-frame window (`bench-ckpt.sh` new
`PERFSTAT=` option, perf stat per thread):

| counter (main thread) | cycles | share |
|---|---|---|
| all | 72.8e9 | 100% |
| stalled with a memory load pending (`cycle_activity.stalls_ldm_pending`) | 40.0e9 | **55%** |
| stalled on loads missing L2 (`stalls_l2_pending`) | 38.1e9 | **52%** |
| data-load page walks (`dtlb_load_misses.walk_duration`) | 10.0e9 | **14%** |
| store / instruction page walks | 0.75e9 | 1% |
| IPC | 0.87 | |

More than half the late game is waiting for memory, a seventh is TLB
misses. That is the lever big enough for 2.5x: memory layout, not
instruction count. First test: transparent huge pages on a FRESH run (round
3's THP test restored a 5.7 GB checkpoint into huge pages, so the kernel's
page collapsing ran inside the window; not a fair test).

Approximate simulation is ruled out by measurement: the demo holds every
player's sync checksum every 60 frames (~1500 per player here), over every
synced write — an approximation changing any simulated value fails within 2
game-seconds; one that never fails is an exact optimization.
