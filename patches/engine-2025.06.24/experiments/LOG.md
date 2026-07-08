# Engine perf hypothesis loop — experiment log

Autonomous loop (branch `claude/engine-perf-loop`; engine work on recoil branch
`claude/perf-loop`, stacked on patch 0001; 0002 intentionally NOT applied).
Rules: code-level changes only (algorithms / implementation / mechanical
sympathy / replay-dead code). No compiler/linker/allocator levers. Hard gate:
PROF-stripped `.brsnap` md5 identical to reference.

## Environment

4-core AVX-512 GPU-less VM, 7.8 GiB RAM + 16 GiB swap, `-worker-threads 2`,
default `-disable-widgets -throttle-draw`. Timing noise ±10% — deltas under
that get interleaved A/B runs. Engine: source-built 2025.06.24 + patch 0001
(official docker image, RELWITHDEBINFO -O3).

## Test replays

| name | gameId | game | sim frames | notes |
|---|---|---|---|---|
| small | 96224c6a18eaee9ff95a7d95e603e6d1 | Eternal Consequences 1.2, 14:22 | 25710 | ~300 units peak, Path-heavy |
| medium | 68694c6a70bfb0d3fefdf8faf824d802 | All That Glitters v2.2.3, 13:17 | 23760 | primary benchmark |

## Baselines (patch-0001 engine, plain runs)

| replay | sim wall | sim fps | ref md5 (PROF-stripped .brsnap) |
|---|---|---|---|
| small | 29s | 874 | 98b23c23c562beb2eb6896240464bcde |
| medium | 1m53s | 210 | 99838ad453e925311fa319d9d31c30b0 |

Byte-identity of patch 0001 re-confirmed on small vs the unpatched-engine
capture (same md5, which also shows `-profile` does not perturb sampled output).

Engine-profiler shares on the medium plain run: Sim 66%,
Lua::Callins::Unsynced 14% (snapshot widget + unsynced gadget halves; 0002
territory — excluded from this loop by instruction), Lua::Callins::Synced 7%,
Draw 4%.

## Hypothesis queue (live — refreshed every commit, kept ≥7)

Micro-bundle #2 in assembly: each item individually sub-noise but provably
output-safe; bundled and judged together via interleaved A/B (the H4–H6
lesson). "safe" = touches only unsynced/draw/dead state OR provably
value-identical synced computation.

**Key structural finding (H3, H5, H12 converge on it): the sim is
MAIN-THREAD-BOUND.** Removing/trimming worker-side (`for_mt` / `*MT`) or
spin-side work yields no wall-clock gain — the main thread is the barrier.
So a hypothesis only pays if it cuts **main-thread** work. Main-thread hot
path (H7-stack flat profile, recoil-main self-time): synced gadget Lua
(`luaV_execute` 2.8% + `luaH_get` 1.6% + `luaD_precall` 1.0% — untouchable),
`CCobThread::Tick` 3.5% (synced interp), `TickAllAnims` 3.8% (H2 took the
overhead; rest is synced anim math feeding weapon aim), `CMoveMath::Range*`
(synced pathfinding), and **`QTPFS::PathManager::UpdateNodeLayer` ≈ 10% of
main CPU** — the one large, addressable main-thread block. That is why H14 is
now the priority: H8 (its unsafe form) ran ~40% faster by cutting exactly
this.

**Micro-bundle #3 — main-thread, value-identical micro-optimizations only**
(same output, faster code), bundled + interleaved together to clear the ~3%
noise floor (H4–H6 method). Skip/approximate levers are exhausted (remaining
big blocks are synced-untouchable or non-idempotent-must-reproduce, see H14).
Diminishing returns acknowledged; continuing per directive.

1. **H30 — QTPFS NodeLayer::Update micro** (7.2% wt=1 instr). Value-identical
   speedups in the per-square speed-bin loop (GetPosSpeedMod/GroundSpeedMod
   1.6+1.4%; the rangeIsBlocked lambda). [ACTIVE — mine the same profile vein]
2. **H31 — RangeIsBlockedHashedMt / FloodFillRangeIsBlocked** (4.8+1.8%): flat
   collision cache + row-major-style index wins (same yardmap idea family).
3. **H25 — CMoveMath::RangeIsBlockedHashedMt cache.** [ACTIVE] per-thread
   `unordered_map<CSolidObject*,BlockType>` → flat/open-addressed cache, same
   hit/miss semantics. Value-identical (gate-checkable); real ceiling on a hot
   pathfinding path (partly main-thread).
2. **H21 — COB dispatch densification.** `CCobThread::Tick` sparse-opcode
   switch is a ~6-cmp tree; a load-time opcode→dense-id remap enables a jump
   table. Higher value but needs bytecode-walk at load — risky, deferred.
3. **H24 — QTPFS UpdateNeighborCache micro.** 2% main self; hunt redundant
   recompute / container churn in the edge walks. Value-identical only.
4. **H25 — CMoveMath::RangeIsBlockedHashedMt cache.** Per-thread
   `unordered_map<CSolidObject*,BlockType>` → flat/open-addressed cache, same
   hit/miss semantics, cheaper. Main-thread, value-identical.
5. **H13 — CobEngine per-tick scheduler early-outs.** Skip empty-queue work in
   `WakeSleepingThreads`/`ProcessQueuedThreads`. Main-thread, low ceiling.
6. **H16 — QuadField MovedUnit churn.** Skip remove+add when a moved unit's
   occupied quad set is unchanged (main-thread, synced — prove identity).
7. **H27 — event-dispatch marshalling.** `IterateEventClientList` /
   `RunCallInTraceback` per-callin setup; reduce per-frame allocation without
   changing Lua-visible args. Main-thread.
8. **H28 — measurement-noise reduction (meta).** Sub-second sim timing + CPU
   pinning so <3% levers become verifiable — unlocks the whole micro tier.
   Harness/measurement change, not an engine patch.

_(Closed: **H14** unsafe-by-construction (non-idempotent tesselation).
**H9/H10/H12** interleaved NO-GAIN. H11/H17/H18 not applicable. H15/H19/H20
parked — SYNCED skip/approximate, unsafe class per the H14 lesson. H22 folded
into H14.)_

## Hypotheses

(one section per hypothesis; verdicts: KEPT / REJECTED-no-gain / REJECTED-output-diff)

### H1 — skip prev-frame transform save in headless demo replay — KEPT

`CUnitHandler::UpdatePreFrame` + `CFeatureHandler::UpdatePreFrame` save every
object's previous transform (matrix→quaternion per object) + every model
piece's prev model-space transform, every sim frame — state read ONLY by
draw-side interpolation (`Rendering/`: drawPos, model-transform upload).
Gated out under `HEADLESS && gameSetup->hostDemo` (Game.cpp call site).
Sync-safety: skipped fields are plain (not Synced*) types — no sync-checksum
contribution; the lazy piece-transform refresh it triggered is idempotent
(later synced readers recompute identical values); projectiles maintain their
own `preFrameTra` (synced ground-collision reads it) elsewhere, untouched.

perf (medium, mid-game, self-time): SavePrevModelSpaceTransform 1.63% +
UpdatePrevFrameTransform 1.27% + CQuaternion::MakeFrom 0.80% +
CFeatureHandler::UpdatePreFrame 0.62% ≈ 4.3%.

| replay | sim before | sim after | Δ | output |
|---|---|---|---|---|
| small | 29s / 874 fps | 25s / 1016 fps | **−14%** | identical ✓ |
| medium | 113s / 210 fps | 109s / 219 fps | **−4%** (matches perf share) | identical ✓ |

Patch: `H1-skip-prevframe-transform-save.patch` (recoil commit `ae02c4b`).

### H2 — TickAllAnims: skip redundant per-tick sort + reuse BFS scratch — KEPT

`CUnitScript::TickAllAnims` (8.6% self-time, runs per animating script per
frame) paid a `std::sort(anims)` every tick and constructed a `std::deque`
per call for the piece-tree BFS. Now: `animsDirty` flag (set on AddAnim
append / RemoveAnim swap-erase, cleared by the sort; the done-anim erase
became order-preserving `std::erase_if` so it keeps sorted order) skips the
sort in the steady state, and the BFS uses a thread_local grow-only vector
scanned by index — the deque's exact FIFO order, zero allocations after
warmup. Identical iteration order by construction (unique (piece,type,axis)
keys → unique sorted sequence), so anim checksum accumulation and
AnimFinished call order are bit-identical.

| replay | sim before (H1) | sim after | Δ | output |
|---|---|---|---|---|
| small | 25s / 1016 fps | 25s / 1013 fps | flat (few anims) | identical ✓ |
| medium | 109s / 219 fps | 101s / 235 fps | **−7.3%** | identical ✓ |

Patch: `H2-tickallanims-sort-skip-bfs-scratch.patch` (recoil commit `8110b6f`).

### H3 — ThreadPool: no clock reads on empty polls — KEPT (neutral)

`DoTask` wrapped its whole body (incl. the empty-queue no-op path) in
`SCOPED_MT_TIMER(ThreadPool::RunTask)` = 2 `clock_gettime` per call, and the
worker spin + `WaitForFinished` help-spin call it millions of times/s while
queues are dry (5.4% of mid-game CPU sat in `__vdso_clock_gettime`). Timer
now wraps only real task execution; WaitFor's 500 ms anti-hang deadline is
polled every 64th empty iteration.

**Measured neutral, as it (in hindsight) had to be**: the removed reads were
on threads that were *spinning anyway* — they now just spin tighter. small
25s→24s, medium 101s→107s: opposite signs, both inside the ±10% noise floor.
Kept because `ThreadPool::RunTask` profiler totals are no longer inflated by
empty polls (the CLAUDE.md caveat), making subsequent `-profile` readings in
this loop trustworthy. Output identical on both replays ✓.

Patch: `H3-threadpool-clock-storm.patch` (recoil commit `c955686`).

### H4 — skip eager piece-transform walk in TickAllAnims — REJECTED-no-gain

Hypothesis: the BFS walk at the end of `TickAllAnims` (recomputes every dirty
piece's transforms, sets wasUpdated/boundaries flags) is rendering plumbing;
synced readers use the lazy `UpdateParentMatricesRec` path which computes
identical values on demand. Gated it out under `HEADLESS && hostDemo`.

Result: **byte-identical output on both replays** (the lazy/eager equivalence
is real) but **timing flat** (small 24s, medium 101s — exactly the H2/H3
numbers). In hindsight: combat units' weapons force the lazy path every frame
anyway (`GetPiecePos` per weapon in `UpdateWeaponVectors`), so the walk's
work shifted to the readers instead of disappearing. Reverted from the
branch; patch kept as `H4-REJECTED-skip-eager-piece-walk.patch` — might pay
on replays dominated by idle animating structures, re-testable on the 8v8.

Also learned this iteration (perf callgraph on a plain run): the `-profile`
scope table's `Update` = 16.7s is a profiler artifact — real cost <2%; and
perf symbolization needs the exact binary preserved next to perf.data.

### H5 — for_mt guided batch claiming — REJECTED-no-gain

Hypothesis: `ForTaskGroup::ExecuteStep` claims ONE index per call (two
contended atomic RMWs per element, thousands of elements/frame across every
for_mt in the sim; main thread showed 4.4% CPU in WaitForFinished during
ground-move phases). Changed to guided batches (~remaining/4·threads,
clamped [1,64]) — each index still runs exactly once, only the
(already-arbitrary, machine-varying) thread-to-index assignment shifts.

Result: **byte-identical output on both replays** (confirming
thread-assignment invariance) but timing flat/noise: small 25s, medium 105s
vs the 101–107s band. Atomic contention evidently isn't binding at 3
threads. Reverted; patch kept as `H5-REJECTED-formt-batch-claiming.patch` —
worth re-testing on hosts with more workers.

Medium sim history across the loop so far: 113 (0001) → 109 (H1) → 101 (H2)
→ 107/101/105 (H3/H4/H5 runs — noise band σ≈3s around ~104).

## 8v8 validation of the kept stack (iteration 7)

Large replay `6da7496a…` (58530 frames) on 0001+H1+H2+H3:
**sim 11m5s / 88 fps / 2.9× realtime, PROF-stripped md5 = `8cb2b931…`** —
byte-identical to the canonical reference from RESULTS.md (recorded before
this loop existed). vs RESULTS.md's patch-0001 12m43s / 77 fps (different
VM, indicative): ≈ −13%, consistent with medium's −11%; H2's anim win
scales with unit count. Swap use stayed mild (560 MiB peak-ish), timing
reasonably clean.

## Where the safe-cut well stands after 7 iterations

Remaining >1% blocks on medium all fall into frozen categories:
1. **Float-semantic synced math** (CQuaternion::Rotate 2.4%, GetHeightReal,
   MoveMath range queries ~6.8%, QTPFS netpoint math) — any rounding change
   diverges from the recording engine; untouchable by definition.
2. **Event-timing-sensitive machinery** (LOS deactivate-outside-batch
   handling, synced Lua GC cadence, sync-checksum accumulation) — cadence
   changes alter observable synced behavior.
3. **Already-tight code** (QTPFS damage-block dedup, UpdateCollisionMap
   staggering, event-dispatch client lists, COB pooled stacks).

Biggest *addressable* block left: ~18s unsynced gadget Lua on medium =
patch 0002's first half (excluded from this loop by instruction; measured
"within noise" on the other VM's 8v8 but looks like real money here).
Beyond that: deep QTPFS / COB-VM surgery (10× effort, real desync risk).

### H6 — unchecked COB bytecode fetch under HEADLESS — REJECTED-no-gain

`GET_LONG_PC()` fetches every opcode/operand word through bounds-checked
`vector::at()` (upstream mantis #5981, a malformed-script crash guard — a
user-facing-client concern; a replay only runs scripts that already executed
live). Switched to `[]` under HEADLESS. Integer-only, provably
value-identical for valid scripts — and indeed **byte-identical output**,
but timing flat (small 25s, medium 106s, noise band). The predicted ≤1% is
below this VM's ~3% noise floor. Reverted; patch kept as
`H6-REJECTED-cob-unchecked-fetch.patch`.

## Phase 2 — data layout & vectorization (user-directed)

**Question:** can reorganizing memory (SoA) and batch/SIMD-processing units pay,
under the byte-identical constraint?

**Constraint analysis.** SIMD is not automatically banned: IEEE lane-wise ops
give bit-identical per-unit results *if* per-unit operation order is preserved.
The landmines: FMA contraction differences (a rewritten loop invites the
compiler to contract `a*b+c` where it previously didn't → different rounding),
transcendentals (streflop scalar impls can't be vectorized), cross-unit
interactions/order-sensitive accumulation, and callbacks interleaved into
every hot loop. Each vectorized loop is a separate proof obligation.

**Measurements (medium, mid-game, perf stat):** IPC 1.16, LLC miss ratio 31%
of cache-refs (~38M misses/s ≈ 2.4 GB/s), L1d miss 3.8%, branch miss 1.5% —
a latency-bound pointer-chasing profile. The premise is real.

**But pahole kills the unit-object theory:**
- `CUnit` = 4320 B / 68 cachelines, effectively packed (pahole's "1200-byte
  hole" is the `CSolidObject` base subobject; real padding ≈ 6 B).
- The engine ALREADY inlines the hot satellites: `amtMemBuffer[616]`,
  `caiMemBuffer[696]`, `smtMemBuffer[376]`, `usMemBuffer[352]` are placement-
  new arenas — MoveType/CommandAI/script live *inside* the unit. The presumed
  pointer-chase between unit and movetype does not exist.
- Arithmetic: a full 68-line sweep of ~1000 units at 30 Hz ≈ 130 MB/s — only
  ~5% of the measured miss traffic. **Unit sweeps are not where the misses
  are.** They must live in map-scale structures (QTPFS node grids, LOS maps,
  heightmap, Lua heap) — whose orderings are largely sync-frozen (e.g. QTPFS
  node indices feed search tie-breaking).
- True SoA batching would need SoA as the source of truth (else gather cost
  eats the SIMD win) — upstream-rewrite scale; Recoil's entt "ECS" currently
  stores only unitIds, an ID list, not a data layout.

**Cache-miss location sampling (perf record -e cache-misses, medium
mid-game):** the miss profile is FLAT — top source 4.2% (TickAllAnims,
proportionate to its cycle share). Disproportionately miss-heavy:
`CLosHandler::Update` stamping (5.4% of misses vs 2.3% of cycles) and
`CGround::GetHeightReal` (2.4% vs 0.9%) — map-scale structures with
algorithmically compulsory access patterns. QTPFS relinking did not even
clear the 1% miss threshold (it is compute/branch-bound, not layout-bound).

**Phase 2 verdict: no patch-scale data-layout win exists in this engine.**
The unit-object layer is already arena-inlined and only ~5% of miss traffic;
the diffuse remainder sits in sync-frozen or compulsory map-scale access
patterns. SoA-batching with SIMD would require SoA as source of truth =
upstream-rewrite scale (Recoil's entt migration is the vehicle for that,
currently an ID list only). Measured, understood, closed without a patch.

### H7 — bundle re-measurement of H4+H5+H6 (interleaved A/B) — KEPT

The three "rejected" micro-patches are each byte-identical and individually
sub-noise. Bundled onto the kept stack (binary B) and interleaved 4×A / 4×B
plain medium runs:

| round | A (kept stack) | B (+bundle) | Δ |
|---|---|---|---|
| 1 | 117s | 104s | −13 |
| 2 | 109s | 99s | −10 |
| 3 | 110s | 106s | −4 |
| 4 | 112s | 109s | −3 |
| **mean** | **112.0s** | **104.5s** | **−7.5s = −6.7%** (paired-t p≈0.03) |

B won all 4 pairs; all 8 runs byte-identical. **The individual REJECTED
verdicts for H4/H5/H6 were false negatives** — the same afternoon's A-runs
alone spanned 109–117s (the cross-hour drift RESULTS.md documents), which
single-run comparisons cannot beat but interleaving resolves. Patches renamed
(REJECTED dropped), bundle promoted into the kept stack; per-patch
attribution within the −6.7% remains unresolved (would need 3 more interleave
sessions; not worth the machine time — they are all output-safe).

**Methodology rule going forward: every timing verdict uses interleaved
paired runs; never judge a <10% lever from single runs on this VM.**

New kept stack: 0001 + H1 + H2 + H3 + H4 + H5 + H6 (recoil `b3d6577`).
Cumulative vs the 0001 baseline on medium: ~−17%.

## Conclusion of this loop phase

H4, H5, H6 all landed byte-identical-but-flat: the safe-cut well is
empirically dry at this VM's noise floor. Kept stack = **0001 + H1 + H2 +
H3** (recoil `claude/perf-loop` @ `c955686`): medium −11%, small −17%,
8v8 ≈ −13%, all byte-identical to pre-loop references. Next moves ranked by
expected value: (1) fold in patch 0002 (user-gated), (2) bundle-remeasure
the three rejected micro-patches with interleaved A/B on a quieter machine,
(3) deep QTPFS/COB surgery, (4) upstream H1/H2 — they are not
replay-specific and benefit live BAR too (H2 outright, H1's gate could
widen to "no draw consumers").

### 8v8 gate for the H7 bundle stack

`6da7496a…` on 0001+H1–H6: **byte-identical** (`8cb2b931…`) ✓. Single-run
timing 11m58s vs the morning's 11m5s on H1–H3 — same ~8% cross-hour drift
the medium A-runs showed (109–117s vs 101s); single-run timings are hereby
retired from verdicts entirely.

### H8 — QTPFS: skip retesselation of no-change damage rects — REJECTED-output-diff

`NodeLayer::Update()` always returned `true`, so every damaged block paid
Merge+Tesselate + MarkDeadPaths + the full neighbor-cache relink even when
the recomputed (speedMod, speedBin) field was identical — common under
repeated cratering and footprint-padded rects, × one update per move-def
layer. The `needTesselation` branch in `UpdateNodeLayer` existed all along.
Patch tracks last computed values per square per layer (2 full-map byte
arrays/layer) and returns a real changed flag. Invariance argument: the
skipped work is a pure function of that field over the rect; unchanged
field ⇒ identical rebuild. Profiled ceiling: UpdateNodeLayer = 10% of main
CPU on medium. Verdict: **GATE FAILED on both replays** (small `0e189844…`, medium
`2164ec4d…`, medium even ended at a different frame count) — the first
output-diff rejection of the loop. Post-mortem: Merge+Tesselate
*canonicalizes* the tree over the event's containing node, so tree state is
path-dependent on the damage-event sequence, not a pure function of the
speed field; skipping an event leaves a differently-shaped tree → different
search tie-breaking → real divergence. Notably the diverged run was
massively faster (medium 65s vs ~105s): the no-change fraction is large, so
a correct, tree-evolution-invariant version of this idea is worth real
money — but no cheap form exists (upstream-scale change to QTPFS's update
canonicalization). Reverted; patch kept for the record.

### H9+H10 — LOS readmap-event + COB sound skip — interleave: NO GAIN (folding into a wider bundle)

Both byte-identical (gates ✓, 8/8 interleaved runs OK). Timing (medium,
interleaved 4×A/B, A=H7 stack, B=+H9+H10):

| round | A | B(+H9H10) |
|---|---|---|
| 1 | 107 | 110 |
| 2 | 102 | 106 |
| 3 | 99  | 100 |
| 4 | 106 | 112 |
| mean | 103.5 | 107.0 (+3.4%) |

B lost all 4 — but these patches can only *remove* work, so this is drift,
read as **no measurable gain**: the LOS unsynced-heightmap path is already
skipped by the spectator gate (`UpdateLOS` early-returns under
`spectatingFullView`) and COB sound events are infrequent in this replay.
Kept on record; folding in **H12** (draw bounding-volume skip, the member
with real profile ceiling in `Sim::Unit::SlowUpdateMT`) and re-judging the
H9+H10+H12 bundle in one interleave. Queue refreshed below.

### H12 (in H9+H10+H12 bundle) — draw bounding-volume skip — REJECTED-no-gain

Bundle byte-identical on both replays (gates ✓). Interleaved medium (4×A/B,
order-alternated): kept 105.75 vs bundle 103.5 = −2.1%, but noisy (B won 2,
tied 1, lost 1). Interleaved small (5×A/B): kept ≈23.8 vs bundle ≈25.0 —
*slower*, but at the CLI's 1-second print quantization (~±4% at 24s) that is
pure noise. Net: indistinguishable from zero. Cause: H12's work is in
`Sim::Unit::SlowUpdateMT` (worker side) — and the sim is main-thread-bound
(see queue header), so removing worker work the main thread isn't blocked on
doesn't move wall time. Same lesson as H3/H5. Whole micro-bundle #2 reverted;
kept stack stays 0001+H1–H6 (`b3d6577`). Patches:
`H9-H10-los-event-and-cob-sound-skip.patch`,
`H12-headless-skip-bounding-volume-recalc.patch` (on record).

### H14 — QTPFS no-change skip — DETERMINED UNSAFE BY CONSTRUCTION (no patch)

Source analysis (Node.cpp `Tesselate`/`UpdateMoveCost`): the split decision
uses `numNewBinSquares` (squares that *changed* bin vs the node's prior
state), not only `numDifBinSquares` (current-field diversity). And
`PreTesselate` **Merges (collapses children) then re-Tesselates** the
containing node on every event. So tesselation is **non-idempotent**:
re-running it on an unchanged field yields a different-but-equivalent tree.
H8 skipped only when the entire damage block was unchanged (and node ⊆
block, so strictly conservative) yet still diverged — empirically confirming
the baseline churns the tree on no-change events. Bit-matching the recording
engine therefore *requires* reproducing that churn; the skip cannot be made
byte-safe. H14's ~40% is unreachable safely.

**Consequence for the whole loop:** the sim is main-thread-bound (H3/H5/H12),
and its main-thread hot path is now fully classified — every large block is
either synced-untouchable (gadget `luaV_execute`, `CCobThread::Tick`,
`TickAllAnims` anim math feeding weapon aim, `CMoveMath` pathfinding) or
non-idempotent-must-reproduce (QTPFS tesselation). No **skip/approximate**
lever with a >3%-noise-floor ceiling remains. Remaining safe wins are
**value-identical micro-optimizations** (faster code, identical output) that
must be **bundled** to clear the noise floor (the H4–H6 method). Pivoting to
main-thread-only micro-bundle #3.

### H28 — measurement-noise reduction — CEILING IS HOST-LEVEL (irreducible)

Precise infolog timing (simtime.py, ~1ms) removed *quantization*, but the
identical-binary (A-vs-A) control still spreads ~10% peak / ~3% sd:
- plain:        91.9–104.1s (12% spread)  [medium, kept-stack binary]
- pinned 0-2:   93.9–102.8s (8.9%, sd 3.0%)
- nice-15+pin:  94.1–104.1s (10.0%, sd 3.5%)
Steal negligible (+1238 ticks); no cpufreq / no intel_pstate exposed (VM).
So the drift is host frequency/scheduling jitter, not something fixable from
inside. **Only effects >~4% are verifiable on this box** (matches: H4–H6's
6.7% resolved 4/4; micro-bundle #2's ~1% read coin-flip 3/6 even precise).

**Loop ceiling reached (autonomous / byte-identical / this-VM):**
- Delivered: kept stack 0001+H1–H6 = **−17% medium**, byte-identical on
  small/medium/8v8, pushed.
- Remaining touchable levers are all <1% main-thread value-identical micros
  (COB/anim dispatch, cache internals) — safe but individually UNVERIFIABLE
  here, and the touchable set can't plausibly sum to the >4% needed.
- The one LARGE, safe, verifiable lever left is **patch 0002** (unsynced
  gadget-Lua halves ≈ 14% of medium wall on the plain-run profiler; already
  written + byte-identical-validated) — excluded from this loop by user
  instruction. It is the highest-value remaining move and needs only a
  go-ahead.

### H23 — TickAllAnims switch dispatch — KEPT (value-identical, byte-identity-gated)

Byte-identical on small+medium (gate ✓). Replaces the per-anim
`std::invoke` on a runtime-indexed member-fn-pointer with a direct
`switch(animType)` so the small Tick*Anim bodies inline. Timing delta is
below this box's ~3% noise (unresolvable), so KEPT on the byte-identity +
value-identical-by-construction basis (same rationale as H3), not a measured
speedup. Kept stack now 0001+H1–H6+H23 (recoil `ce29d3b`).

**Operating model going forward (given the H28 noise ceiling):** value-
identical micros are verified by the byte-identity gate (which is reliable)
and banked if identical; per-item timing interleaves are skipped (they can't
resolve <4%); one aggregate interleave is run when a bundle is plausibly >4%
or on request. This keeps producing *safe* patches without wasting compute on
unresolvable measurements.

### 0002 — FOLDED INTO KEPT STACK (user-authorized 2026-07-08)

`git am 0002` onto ce29d3b → recoil `699d918`. Byte-identical on both
replays (small 98b23c23…, medium 99838ad4… — match refs). Kept stack now
0001+H1–H6+H23+0002. Timing to be measured with the new CPU-time bench
harness (single-run wall was noise-dominated: a 120s medium run landed
during heavy neighbour load).

### Bench harness validated + 0002 measured (2026-07-08)

Harness (`tools/bench-harness.patch`, `tools/measure.sh`): perf-counter
instruction count over sim window [6000,9000), `-worker-threads 1` (no
spin-wait → deterministic). **Instructions are stable to ~0.02–0.35%**
(min-of-N), vs 5–15% for wall/cycles (host freq scaling + neighbour memory
contention). This is a precise, fast (~4 min/candidate) detector of
value-identical **synced** optimizations.

Baseline (kept stack 0001+H1–H6+H23+0002): **min_instr ≈ 40.389e9** over 3000
medium frames.

**0002 measured: +0.00% synced instructions** (40388632118 without → 40388866383
with; identical). Correct: 0002 cuts only *unsynced* gadget callins, outside
the SimFrame window. Corollary: 0002's benefit is **not** the 14% profiler
`Lua::Callins::Unsynced` figure — that share is dominated by the snapshot
widget (kept), not the gadget halves 0002 removes. 0002 stays folded (byte-
identical, harmless) but is a small win, matching RESULTS.md's original
"within noise". The bench does NOT measure unsynced cuts (throttle-draw
suppresses the unsynced update to ~1/s); use profiler/wall for those.

### H29 — yardmap row-major indexing (was Morton) — KEPT, −7.87% instr ★

Data-driven (wt=1 instruction profile: `CMoveMath::RangeHasExitOnly` = 14.4%,
the hottest synced fn). `GetMapState` indexed `stateMap` via a 5-round Morton
interleave per (x,z); the footprint scans are small + contiguous in x, so
Morton's locality gain is nil and its compute is overhead. Row-major
`z*rowWidth+x` (same clamping, same width*width buffer, pure bijection change).
**Byte-identical (gate ✓); 40.389e9 → 37.210e9 instr = −7.87%** over 3000
medium frames. First win found via the instruction harness. Recoil `<hash>`.

_Note: this reduces total synced work; at wt=2 RangeHasExitOnly runs partly on
workers, so wt=2 wall gain may be < the instruction %, but it's strictly fewer
instructions for identical output. Wall interleave TBD in a batch._

### H30 — coarse exit-only block grid — KEPT, −5.95% instr (cumulative −13.35%) ★

RangeHasExitOnly was still 7.2% after H29. Exit-only squares are factory-
localized (set only at GroundBlockingObjectMap:86/134). Added a 16×16-square
coarse block grid of exit-only counts (maintained in Set/ClearFlags) and a
`RangeMayHaveExitOnly` fast-reject; footprints far from factories skip the fine
scan. Conservative superset → value-identical. **Byte-identical; 37.210e9 →
34.995e9 instr = −5.95%, cumulative −13.35% vs pre-H29 (40.389→34.995).**
Yardmap vein now mined out. Next: RangeIsBlockedHashedMt cache (5.6%),
tesselation internals (UpdateMoveCost/UpdateNeighborCache ~3.5% each).

### H31 — MoveMath flat collision cache (was unordered_map) — KEPT, −1.69% (cum −14.82%)

RangeIsBlockedHashedMt + FloodFillRangeIsBlocked: per-thread
unordered_map<CSolidObject*,BlockType> → generation-stamped direct-mapped flat
cache (1024 slots, no alloc/clear/rehash, evict-on-collision recomputes the
deterministic value). Value-identical (same collider-per-tempNum invariant).
**Byte-identical; 34.995e9 → 34.405e9 = −1.69%, cumulative −14.82%.**

### wt=2 wall check of H29+H30+H31 — INCONCLUSIVE (host noise)

Interleaved wt=2 medium wall (pre-H29 vs H31, 8 pairs, nice-15+pinned):
A=122.3s B=123.7s, B wins 4/8 — coin flip; individual runs 113–135s (±10%
host drift). The wall is noise-dominated (same wall we couldn't resolve
before — the reason the instruction meter exists), so this neither confirms
nor refutes a wt=2 wall gain. The −14.82% **instructions** is real total-work
reduction (byte-identical); at wt=2 the QTPFS/MoveMath work is worker-side, so
the medium/2-worker wall benefit may be small, but it helps wt=1 and heavier
workloads (8v8). **Policy: instruction count (wt=1, min-of-N) is the verified
metric; wt=2 wall is not resolvable on this box.** Keep banking byte-identical
instruction reductions.
