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
| **PGO + LTO** (on H60-H62) | yes (medium) | full run 1m25s -> **1m16s (-11%)** | wall **-10.2%** (3/3), instr **-15.3%** | **keep** |

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
