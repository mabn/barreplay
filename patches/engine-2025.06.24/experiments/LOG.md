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
