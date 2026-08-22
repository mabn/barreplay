# Engine perf hypothesis loop, round 2 — engine 2026.07.04

BAR moved to engine **2026.07.04** (games since ~2026.07 run it), so the whole
round-1 result set — `patches/engine-2025.06.24/` — describes a build nothing
plays on any more. This round re-runs it from scratch against the new engine:
every hypothesis re-tested, every kept patch re-ported and re-verified, and the
references regenerated on the CURRENT barreplay wire format.

Rules unchanged from round 1: code-level engine changes only (no compiler /
linker / allocator levers), and the hard gate is **byte-identical output** —
this round gates on the **`.brp` md5** directly (round 1 gated the PROF-stripped
`.brsnap`; the .brp is a deterministic function of it and is what actually
ships, so it is the truer statement of the contract).

## Environment

Same 4-core AVX-512 GPU-less VM, 7.8 GiB RAM + 16 GiB swap. Engine source at
`/home/mabn/dev/recoil` branch `claude/perf-loop-2026.07.04` (tag 2026.07.04,
official pinned docker image — note the image DIGEST changed with the tag, see
`build-img.txt`), work dir `/home/mabn/dev/perf2`.

Submodule set grew since 2025.06.24: `fmt`, `mimalloc`, `nowide`, `streflop`,
`sse2neon` and `tools/unitsync/python` are now required to configure (round 1's
recipe list is no longer sufficient — CMake fails with "does not contain a
CMakeLists.txt file"). `rts/lib/gflags` also moved (v2.2.0 → v2.3.0).

## Test replays (all engine 2026.07.04, all game `test-31030-23a0c35`)

Picked to mirror round 1's shapes, and deliberately on ONE game version so a
single archive covers all three.

| name | gameId | game | duration | notes |
|---|---|---|---|---|
| small | d53f896a4c7276e66540d53d13f3a31e | Gasbag Grabens 1.1.1, duel | 15:31 / 28050 f | quick gate |
| medium | 4936896a8b258d038cbd28f55eb15ed2 | All That Glitters v2.2.3, 16p | 13:25 / 24150 f | primary benchmark |
| large | d03a896a204dd8f8a4b4c488cfaec73e | All That Glitters v2.2.3, 16p | 30:41 | scale validation |

Medium is deliberately the same map and nearly the same length as round 1's
medium (All That Glitters v2.2.3, 13:17), and it re-sims at nearly the same
rate on the stock engine (202 fps vs round 1's 210), so round-1 numbers are
roughly comparable.

## References (release binary 2026.07.04, current barreplay)

| replay | .brp md5 | stock timing |
|---|---|---|
| small | 07e418a24eb2604de0139494e7ff8b52 | load 15s + sim 59s (27900 f, 469 fps) |
| medium | ee38376aacbfbb076bac40737ca509ca | load 12s + sim 1m59s (24150 f, 202 fps) |

Stock medium profiler shares: Sim 42%, Lua::Callins::Unsynced 12%, Draw 8%,
Lua::Callins::Synced 6% — Sim is under half the wall, i.e. the round-1 finding
that the lag-protection governor idles the sim still holds on this engine, and
patch 0001 should still be the single biggest lever.

## Upstream drift (what round 1 found that 2026.07.04 already has)

Diffing the round-1 patch targets across the two tags, before testing anything:

- **H29 (yardmap row-major, round 1's biggest instruction win at −7.9%) is
  UPSTREAM.** `YardmapStatusEffectsMap` no longer Morton-interleaves: it is now
  8×8 cache-line tiles, row-major within the tile — the same insight, done
  better. Round 2 must NOT re-apply H29; it must confirm the tiling is there
  and re-baseline.
- **H32's target is gone**: the single-threaded `RangeIsBlocked*St` variants
  were deleted upstream; everything routes through the Mt path now (which is
  exactly why H32 measured no gain in round 1).
- **H31 still applies**: `RangeIsBlockedHashedMt` still uses a per-thread
  `spring::unordered_map<CSolidObject*, BlockType>`.
- **H30 still applies**: `RangeHasExitOnly` is still an unconditional footprint
  scan with no coarse reject.
- Everything else the round-1 patches touch is lightly changed or untouched;
  all 19 patch files still apply to the new tag (13 clean, 6 via 3-way), which
  is the starting point rather than the conclusion — each still has to be
  re-gated and re-measured, since "applies" says nothing about "still helps".

## Plan

1. Build unpatched 2026.07.04 from source; gate small+medium against the
   release-binary references (validates the source build, as round 1 did).
2. Land the bench harness; establish the instruction baseline.
3. Re-test each round-1 hypothesis in order, each gated + measured on the new
   engine, dropping the ones upstream absorbed.
4. Fresh profile of the new engine, then new hypotheses.

---

# Round 2 results

## Foundation

**Source build == release binary.** Unpatched 2026.07.04 built in the pinned
image gates IDENTICAL against the release-binary references on small AND
medium. (Two false alarms on the way, both worth recording:)

1. `-engine` pointed at a loose binary outside `<data>/engine/<ver>/` — the
   engine looks for `base/springcontent.sdz` NEXT TO ITS OWN BINARY, so the run
   died with "failed to open archive 'Spring content v1'" and wrote an empty
   capture that the gate faithfully reported as a DIFF. The harness now swaps
   the binary INSIDE the engine dir, which is what round 1 did.
2. A real determinism bug in barreplay, fixed on the branch: `parseStartscript`
   collected the roster by ranging a Go MAP, so player order was per-process
   random and the meta record differed between two runs of ONE binary while
   every frame/event/comm section matched byte for byte. The .brp writer's
   "same capture -> byte-identical file" guarantee is the whole verification
   method here, so this had to be fixed before anything could be measured.

**Measurement.** Instruction meter re-validated: spread 0.12–0.61% over
min-of-3 (round 1 saw 0.02–0.35%), so the same rule holds — instructions decide,
wall only above ~4%. `kernel.perf_event_paranoid` must be <= 1 or
`perf_event_open` silently returns 0 counters (it defaults to 3 after a reboot;
the harness reads instructions=0 and the min-of-N divides by zero).

Baseline: **56.606e9 instructions** over medium frames [6000,9000) at wt=1,
sim 2m1s / 200 fps, load 12s.

## Per-hypothesis results (each gated byte-identical on medium)

| # | verdict | instructions | note |
|---|---|---|---|
| 0001 unpaced playback | **KEPT** | n/a (pacing) | **wall 200 -> 235 fps (-15%)**; Sim share 42% -> 63%, Draw 8% -> 3% |
| 0002 unsynced cuts | KEPT (flat) | +0.37% | as round 1: the Unsynced scope barely moves (22330 -> 22227 ms) because it is the SNAPSHOT WIDGET, not the gadget halves |
| H1 prev-frame transform | **KEPT** | **-3.68%** | round 1 measured -4% wall on medium; holds |
| H2 anim sort/BFS scratch | KEPT | -0.67% | much smaller than round 1's -7.3% |
| H3 threadpool clock storm | KEPT | flat (cycles -2.2%) | re-authored; worker-side, invisible to a wt=1 meter by construction |
| H4 eager piece walk | KEPT | -0.04% | flat, as round 1 |
| H5 for_mt batch claiming | KEPT | -0.37% | |
| H6 COB unchecked fetch | KEPT | +0.08% | flat, as round 1 |
| H23 anim switch dispatch | KEPT | -0.08% | re-authored; value-identical by construction |
| H31 flat collision cache | **KEPT** | **-1.08%** | round 1: -1.69% |
| H30 coarse exit-only grid | **KEPT** | **-16.3%** ★ | round 1: -5.95%. Re-authored onto the tiled yardmap — and it is now by far the biggest single win |
| H21 COB jump table | **KEPT** | **-0.76%** | round 1: -0.46% |
| H45 QTPFS relink grid | KEPT | -0.34% | re-authored; round 1: -0.13% |
| H49 skip .smt tiles | **KEPT** | n/a (load) | **load 12s -> 9s (-25%)** |
| H29 yardmap row-major | **DROPPED** | — | upstream: 2026.07.04 tiles the map 8x8 per cache line |

Four of the fifteen needed re-authoring rather than re-applying (H3, H23, H30,
H45); H30 needed a genuine rewrite because round 1 had built it on H29.

## Where round 2 stands

Cumulative on medium, all byte-identical: **56.606e9 -> 44.428e9 instructions
= -21.5%**, wall **200 -> 239 fps (sim 2m1s -> 1m41s, -16%)**, load **12s -> 9s**.

The shape of the win moved: round 1's biggest instruction lever (H29) is
upstream, and the yardmap fast-reject that was worth -6% there is worth -16%
here — the same hypothesis, a different engine, a different answer. That is the
argument for re-running the whole set rather than porting the kept stack.

## Fresh profile of the ported stack (2026-08-22)

`perf record` needs the **software `cpu-clock` event** on this VM: hardware
`cycles` COUNTS fine (that is what the instruction meter uses) but SAMPLES
almost nothing, and `perf annotate` segfaults on the 800 MB debug binary, so
this round works from flat self-time only. Call graphs are useless too (release
build, no frame pointers).

Thread shares over a mid-game window: `recoil-main` 24.1%, workers 9.1/6.1/4.8,
idle 53.8% — i.e. the main thread is pinned at ~100% of one core and the sim is
still **main-thread-bound**, exactly as round 1 found. Only main-thread work
counts.

Main-thread self-time (normalised to the main thread):

| block | share | note |
|---|---|---|
| `CCobThread::Tick` | 10.6% | the COB VM. H21 already jump-tabled its dispatch; what is left is the handlers |
| Lua interpreter (all `lua*` symbols) | 12.8% | synced gadget Lua — round 1 closed this as value-bearing |
| anim / piece transforms (`TickAllAnims`, `CQuaternion::*`, `ComposeTransform`, `SetDirty`) | ~8.5% | mostly sync-locked FP |
| `CSyncChecker::Sync` | 2.6% | pure observation |
| LOS (`CLosHandler::Update` lambda + `InLos`) | 2.8% | |
| QTPFS (`IncrementalUpdate`, `UpdateNeighborCache`) | 2.5% | |
| `CMoveMath::RangeIsBlockedHashedMt` | 1.2% | post-H31 |
| `CQuadField::GetUnitsExact` | 1.0% | |

Everything below that is a long flat tail — the same shape round 1 ended at.

**Do not trust the engine's own profiler for this.** It reports
`Lua::Callins::Unsynced` at 19–20% of wall, and that number survives turning the
widget's sampling off entirely (`-every 100000`: 20669 ms, versus 22227 ms with
sampling at 1 Hz) while perf puts the whole Lua interpreter at 12.8% of the main
thread. The scope is measuring something other than wall time spent in unsynced
Lua; perf and the wall clock agree with each other and are what this round uses.

## H52 — the capture widget's own cost (barreplay side, not the engine)

Single runs said turning sampling off took medium's sim from 1m41s to 1m34s —
7% — and a three-way bisect (drop the per-unit `string.format`; drop the
`table.concat`+`write`+`flush`; drop only the per-sample `out:flush()`) put
essentially all of it on the FLUSH, each variant landing at 1m34–1m35s.

**All of that was noise, and interleaving says so.** Round 1's rule — never
judge a sub-10% wall delta from single runs on this box — applies to barreplay's
own code exactly as it does to the engine's:

| A/B (4 interleaved pairs, medium) | A | B | verdict |
|---|---|---|---|
| flush kept vs flush removed | 96.2s | 96.2s | **+0.00%, B wins 2/4 — nothing** |
| sampling at 1 Hz vs sampling off | 100.2s | 97.2s | **-2.99%, B wins 4/4** |

So the widget's ENTIRE cost is ~3% of sim wall, not 7%, and the flush is no part
of it. The bisect had been reading the same ±5% run-to-run drift four times and
calling it a discovery.

What that leaves: a 3% ceiling for the whole capture path, of which any
realistic optimization could take maybe half — and the only ways to take it
(fewer formatted fields, a delta text format, the binary .brepstream encoder)
change what the widget writes, which is exactly what must not change. One free
piece landed anyway: `string.format`/`table.concat` were `_ENV` lookups inside
the per-unit loop and are now locals, byte-identical by construction.

**Closed at 3%.** The engine is where the remaining time is.

## Queue (>=7)

1. **H53 — COB VM fetch**: cache `cobFile->code.data()` in a local for the
   dispatch loop; `GET_LONG_PC` currently walks `this -> cobFile -> code` per
   opcode AND per operand word. Value-identical. `CCobThread::Tick` is 10.6% of
   the main thread, the largest single block left.
2. **H54 — `CLosHandler::Update` lambda (1.75%) + `InLos` (1.04%)**: look for
   work that is dead when every ally is fully visible (a re-sim spectates).
3. **H55 — `CQuadField::GetUnitsExact` (1.0%)**: query-shape / container churn.
4. **H56 — QTPFS `IncrementalUpdate` (1.7%) + `UpdateNeighborCache` (0.79%)**:
   the vein H45 opened; look for more per-event O(area) bookkeeping.
5. **H57 — anim/piece transform cluster (~8.5%)**: `LocalModelPiece::SetDirty`
   (0.79%) propagates through the piece tree; check for redundant propagation.
   The FP math around it is sync-locked, the bookkeeping is not.
6. **H58 — `CUnit::Update`/`UpdatePhysicalState` (1.7% together)**.
7. **H59 — `CGroundMoveType::UpdatePreCollisions` (0.67%)**.
8. **H56b — `CSyncChecker::Sync` (2.6%)**: NOT TAKEN, and worth recording why.
   The checksum is a pure observer (nothing synced reads it — `GetChecksum` is
   only consumed by the net response and, under `TRACE_SYNC`, by logging), so
   skipping it is output-safe by construction. But in demo playback the local
   server compares our per-frame checksum against the RECORDED players' — that
   is the mechanism behind the desync warnings `engine.SummarizeInfolog` counts,
   and it is the only automatic detector of a re-sim that silently diverged.
   Trading it for 2.6% is a bad deal for a pipeline that publishes captures
   nobody re-verifies.

## H53 — hoist the COB code pointer out of the fetch — REJECTED-no-gain

`GET_LONG_PC()` walks `this -> cobFile -> code` for every opcode and operand
word, and `CCobThread::Tick` is the biggest single main-thread block, so caching
the array's data pointer per call looked like free money. Byte-identical, and
**+0.002% instructions** — GCC was already hoisting it (the vector is provably
loop-invariant there). Reverted rather than kept: it removes no work, so it
would be source noise in the series. Recorded so nobody tries it again.

## Where round 2 ends

The wt=1 profile (which is what the instruction meter sees, so it is the guide
for further instruction cuts) after the full stack:

| block | share of main thread |
|---|---|
| `CCobThread::Tick` | 8.6% |
| anim / piece transforms (`TickAllAnims`, `CQuaternion::*`, `Transform::operator*`, `ComposeTransform`, `SetDirty`, `TickSpinAnim`) | ~15% |
| Lua interpreter | ~7.6% |
| QTPFS (`IncrementalUpdate` + `UpdateNeighborCache`) | 4.7% |
| `CLosHandler::Update` lambda + `InLos` | 3.8% |
| MoveMath (`RangeIsBlockedHashedMt`, `RangeHasExitOnly`, `FloodFill`, `GetPosSpeedMod`) | 5.0% |
| `LocalModel::UpdateBoundingVolume` | 1.3% |

This is the same wall round 1 reached, and the same classification applies: the
COB VM and the Lua interpreter are executing BAR's own scripts (value-bearing),
the transform/quaternion math is sync-locked FP, and the LOS and
bounding-volume work is `for_mt` — worker-side in production, so it inflates
this wt=1 view and is not what the main thread waits on. What was left loose in
the index/cache vein has been taken (H30, H31, H45).

Two structural questions were asked and answered rather than assumed:

- **Is time going somewhere other than the simulation?** No. The bench harness
  was extended to report the wall between sim frames as well as inside them:
  over a whole medium run at wt=1, 85.5s of 89.3s is inside `SimFrame` —
  **4.3% outside**. (A first, sloppier comparison — the CLI's "sim" phase
  against summed SimFrame CPU — suggested 25%, but the CLI's clock starts at the
  widget's first heartbeat, which is during loading, and ends after teardown.)
- **Is the capture itself expensive?** No: 3%, and not where it looked (H52).

Remaining candidates are the queue above, all ~1-3% and each needing the
instruction meter to see at all.
