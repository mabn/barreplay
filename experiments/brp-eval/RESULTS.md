# .brp frame-section layout experiments — size evaluation

Question: the current F/X delta frames store every column for **every unit in
every sampled frame**, even when all of a unit's deltas are zero. Would (1)
skipping unchanged units, and/or (2) reorganizing a chunk as per-unit,
per-column sparse time series shrink the file meaningfully?

## Method

`experiments/brp-eval` (throwaway harness, not a shipping codec) decodes a real
capture and re-encodes its F+X sections under each layout, keeping everything
else identical so the comparison is pure layout: same 64-sample chunks, same
keyframe encoding (K streams are byte-identical across variants), same x/z
velocity prediction, same resource encoding, same per-chunk
gzip(DefaultCompression). The baseline replica reproduces the input file's F
and X sections **byte-for-byte**, which validates the harness.

Input: real 8v8 capture, 309.5 MB `.brsnap` → 14,638,146-byte `.brp`
(1952 frames, 4.19 M unit records, 48,823 events; F = 10.32 MB, X = 4.05 MB,
meta+events = 0.26 MB).

Variants:

- **opt1 — skip idle units.** Frame-major like today, but a delta frame lists
  only units with ≥1 non-zero column delta, plus an explicit dead-id list
  (absence must mean "unchanged", not "gone"). A skipped unit implicitly
  advances by its velocity prediction.
- **opt2 — unit sparse series.** Per chunk: a unit directory (ids + presence
  intervals, which also encode deaths), then per column × unit a sparse list of
  `(frameIdxDelta, valueDelta)` pairs holding only non-zero deltas. Emitted
  column-major (all units' x series adjacent).
- **opt2u** — opt2 emitted unit-major (one unit's 11 columns adjacent) — a
  gzip-locality probe.
- **opt1+2** — opt2 plus a per-unit column bitmask so a fully idle unit costs
  1 byte/chunk instead of 11 zero counts.
- **opt3 — polar velocity.** The dvx/dvz columns are replaced by
  (speed, angle): speed = round(hypot(dvx,dvz)) in whole elmos per sample
  interval (same radial precision as today), angle quantized to N steps per
  full turn (integer, no floats), delta-coded with shortest-path wrap-around;
  a stopped unit keeps its previous angle so stopping costs one speed delta,
  not an angle jump. The x/z position predictor becomes the velocity
  *reconstructed* from (speed, angle), so polar quantization error leaks into
  the x/z residual columns — positions stay exact, but the stored
  interpolation tangent is now approximate. Tested at 1024 and 256 angle
  steps, alone and combined with opt1, plus a 2nd-order angle predictor
  (predict angle += previous angle delta, so a constant-rate turn encodes as
  zero).

## Change statistics (why there's room)

Of 4.16 M delta-frame unit records, **65.7% are fully idle** (all 11 columns
zero-delta vs prediction). Per-column change rates: x/z/dv\* /y ≈ 23–28%,
hp 3.7%, build 2.4%, maxHp 0.9%, def/team ≈ 0.4% (new units only). So the
baseline stores ~46 M varints of which ~85% are single `0x00` bytes — highly
gzip-compressible, which is exactly why the wins below are smaller than the
raw numbers suggest.

Polar change rates (opt3, vs the cartesian columns they replace — records
with a previous sample, 4.14 M):

| column | nonzero rate |
|---|---|
| dvx (current) | 26.6% |
| dvz (current) | 27.3% |
| speed | 24.4% |
| angle (1024 steps) | 23.4% |
| angle (2nd-order predictor) | 25.8% |
| x residual w/ polar predictor | 27.3% (was 27.2%) |
| z residual w/ polar predictor | 27.7% (was 27.9%) |

So the "straight lines → one polar coordinate stays constant" hypothesis
holds only weakly: pathfinding jitter wobbles both heading and speed, and the
nonzero *rate* barely drops (2×~27% → 24.4%+23.4%). What polar does win is
*magnitude* — angle deltas of a wiggling heading are a few steps where
cartesian dv deltas are a few elmos in two columns — which shows up after
gzip, not in the counts.

Tangent fidelity (the viewer interpolates with dv, which is now reconstructed
from speed+angle; positions remain exact because the x/z residuals absorb the
reconstruction error):

| angle steps | mean L1 error (elmo/interval) | max | exact |
|---|---|---|---|
| 1024 | 0.125 | 2 | 89.3% |
| 256 | 0.580 | 9 | 77.8% |

## Results

| variant | F+X gzipped | file total | vs baseline | D streams gz (K excluded) | D raw (pre-gzip) |
|---|---|---|---|---|---|
| baseline (current v2) | 14,377,554 | 14,638,146 | 100.0% | 13,616,742 (100%) | 52,209,842 (100%) |
| opt1 skip idle units | 10,232,608 | 10,493,200 | **71.7%** | 9,471,796 (69.6%) | 19,561,345 (37.5%) |
| opt2 unit sparse series | 10,295,350 | 10,555,942 | 72.1% | 9,534,538 (70.0%) | 17,550,394 (33.6%) |
| opt2u (unit-major order) | 10,551,750 | 10,812,342 | 73.9% | 9,790,938 (71.9%) | same as opt2 |
| opt1+2 sparse + bitmask | 10,146,911 | 10,407,503 | **71.1%** | 9,386,099 (68.9%) | 17,099,075 (32.8%) |
| opt3 polar dv, 1024 steps | 13,833,445 | 14,094,037 | 96.3% | 13,072,633 (96.0%) | 51,970,194 (99.5%) |
| opt3 polar dv, 256 steps | 13,371,647 | 13,632,239 | 93.1% | 12,610,835 (92.6%) | 51,509,492 (98.7%) |
| opt1+3 skip idle + polar, 1024 | 9,940,208 | 10,200,800 | **69.7%** | 9,179,396 (67.4%) | 19,322,767 (37.0%) |
| opt1+3 skip idle + polar, 256 | 9,589,965 | 9,850,557 | **67.3%** | 8,829,153 (64.8%) | 18,891,809 (36.2%) |
| opt1+3 + 2nd-order angle, 1024 | 9,967,655 | 10,228,247 | 69.9% | 9,206,843 (67.6%) | 19,339,566 (37.0%) |

(the "vs baseline" column here is file total; the harness also prints F+X-only
ratios, which differ by ~0.5 pt since meta+events are constant.)

("file total" = M + E + headers unchanged + re-encoded F + X. Keyframe gzip
streams are identical in all variants: 760,812 bytes total.)

## Findings

1. **The gain is real but capped at ~29%**: 14.64 MB → 10.4–10.5 MB on this
   capture. Every variant lands within ~1.5% of every other, because gzip was
   already absorbing most of the zero-run redundancy: raw layout sizes differ
   3× (52 MB → 17 MB) but gzipped only 1.45×. The dictionary-coder was doing
   ~2/3 of opt1/opt2's job for free.
2. **opt1 alone captures essentially the whole win** (71.7% vs 71.1% for the
   most elaborate variant) and is by far the smallest change: same frame-major
   decoder shape, one extra dead-id list, and the JS decoder change is
   localized. opt2's structural elegance (no per-frame id lists, per-column
   sparsity) buys only ~0.6 pt more after gzip.
3. **opt2 is NOT better than opt1 after compression** despite being 10% smaller
   raw. Its per-unit directory + per-column counters add structure that gzips
   worse than opt1's uniform id+delta rows. The user's hypothesis that
   same-unit adjacency helps compression is true pre-gzip but the entropy coder
   levels it.
4. **Column-major beats unit-major** for the sparse layout (opt2 vs opt2u:
   ~2.3 pt) — same-column values across units are more self-similar than one
   unit's mixed columns. If any sparse layout is pursued, keep column-major.
5. Keyframes are untouched by all of this (0.76 MB total here) and grow in
   relative weight as the delta side shrinks; deeper cuts would need keyframe
   work or a chunk-size change, which trades against seek granularity.
6. **opt3 alone is nearly worthless (-3.7%)** — on the baseline layout the
   dominant cost is the 65.7% of records that are all-zero in every column,
   and polar doesn't touch those. **Combined with opt1 it's a real add-on:
   opt1+3 lands at 69.7% (1024 angle steps) vs opt1's 71.7%** — polar buys an
   extra ~2 pt (~290 KB) once the idle records are already gone. Dropping to
   256 angle steps buys ~2.4 pt more (67.3%) but visibly degrades the stored
   tangent (mean error 0.58 elmo/interval, max 9, only 77.8% exact) — the
   viewer's interpolation curves get slightly wrong end-slopes. 1024 steps is
   the fidelity-safe choice (max 2 elmo/interval error on tangents only;
   positions are exact in every variant).
7. The polar win comes from smaller delta *magnitudes*, not fewer nonzero
   deltas: nonzero rates barely move (see stats above) because pathfinding
   jitter wobbles heading and speed almost as often as it wobbles dvx/dvz.
   The 2nd-order angle predictor (constant turn rate → zero) is a wash —
   slightly worse than first-order, because real headings jitter rather than
   sweep smooth arcs at 1 Hz sampling.

## Recommendation

Implement **opt1** (skip idle units + dead-id list) — it's the bulk of the
win (-28%) at the lowest complexity: the frame decode loop stays frame-major
in both Go and JS, and the keyframe/skim/chunk-serving model is untouched.
**opt3 at 1024 angle steps is a defensible add-on** (-30.3% total) if the
extra ~290 KB matters: it's still a frame-major column swap (dvx/dvz →
speed/angle, integer math only), but it costs trig in the hot decode path of
all three codec implementations and turns the stored tangent from exact to
±2 elmo/interval. Skip opt2 (decoder rewrite for ~1 pt) and skip the
2nd-order angle predictor (no gain). Absolute stakes on this capture:
14.64 MB → 10.49 MB (opt1) → 10.20 MB (opt1+3); the format is already 22×
smaller than the source `.brsnap`.

Reproduce: `go run ./experiments/brp-eval <capture.brp>`.

## opt4 + opt5 (dv precision) — second round

Going-forward layout per project decision: **opt1 (skip idle units) + opt4
(drop the y/dvy columns; X keeps build + team resources)**. Measured against
the original file:

| variant | F | X | file total | vs original |
|---|---|---|---|---|
| opt1+4 | 7,344,889 | 464,250 | **8,069,731** | **55.1%** |

(opt4 collapses X from 2.94 MB under opt1 to 0.45 MB — most of X was y/dvy.)

**opt5 — dv at 1/scale elmo precision with a fractional position
accumulator** (decoder tracks position in fine units, advances by fine dv,
predicts round(fx/scale); corrections stay whole elmos and preserve the
fractional phase). Requires the raw `.brsnap` (float velocities); the harness
validates the brsnap-derived frames match the `.brp` exactly. Also tested
**5b**: keyframe x/z additionally stored at fine precision (from the true
float positions) so the accumulator starts phase-exact.

| variant | file total | vs opt1+4 | x-res nonzero | dv-delta nonzero |
|---|---|---|---|---|
| opt1+4 (dv ×1) | 8,069,731 | 100.0% | 26.9% | 27.0% |
| dv ×2 | 8,401,651 | 104.3% | 27.2% | 27.9% |
| dv ×4 | 8,762,149 | 108.9% | 27.2% | 28.5% |
| dv ×10 | 9,227,005 | 114.8% | 27.2% | 28.5% |
| dv ×100 | 10,289,853 | 128.4% | 27.2% | 28.5% |
| 5b: dv+keyframe pos ×10 | 9,274,370 | 115.4% | 27.2% | — |
| 5b: dv+keyframe pos ×100 | 10,380,943 | 129.6% | 27.2% | — |

**Verdict: rejected.** Finer dv does not reduce position corrections at all —
not even at ×100 with exact keyframe phase — because the corrections are not
caused by dv rounding. The dominant cause: a correction almost always
coincides with a *real velocity change* during the sample interval (x-res
27% ≈ ddv 28%) — the stored dv is the instantaneous velocity at the sample
instant, so when the unit accelerates/turns mid-interval no dv precision can
predict the sampled position. The pure rounding-noise corrections opt5 was
aimed at are only ~1.1% of records (the earlier ±1-tolerance probe) at ~1
byte each. Meanwhile the cost side is real: every dv delta magnitude scales
with the precision (mean |ddv| ×10 at scale 10) and keyframe dv absolutes
grow too — +14.8% file at ×10, +28.4% at ×100.

Inspection helpers:

- `-brsnap <path>` feeds the original raw capture (float velocities/positions)
  and runs the opt5 dv-precision sweep against the .brp given as the main arg.
- `-unit <id>` dumps one unit's every sampled frame — game time, frame,
  position/velocity/polar state, then the exact deltas the cartesian codec
  stores vs what the polar codec would store, each with its pre-gzip byte
  cost and an `opt1:SKIP` marker when all 11 deltas are zero. `—` means
  "nothing changed vs prediction": 11 zero bytes today, 0 bytes under opt1.
- `-find-constant` ranks units by how many delta frames are "moving yet
  all-zero" (dv ≠ 0 but every column delta 0) — the constant-velocity case
  the position predictor is built around — to find good dump subjects.
