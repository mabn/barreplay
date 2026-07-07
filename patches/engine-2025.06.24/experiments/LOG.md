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
