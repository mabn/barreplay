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

## Change statistics (why there's room)

Of 4.16 M delta-frame unit records, **65.7% are fully idle** (all 11 columns
zero-delta vs prediction). Per-column change rates: x/z/dv\* /y ≈ 23–28%,
hp 3.7%, build 2.4%, maxHp 0.9%, def/team ≈ 0.4% (new units only). So the
baseline stores ~46 M varints of which ~85% are single `0x00` bytes — highly
gzip-compressible, which is exactly why the wins below are smaller than the
raw numbers suggest.

## Results

| variant | F+X gzipped | file total | vs baseline | D streams gz (K excluded) | D raw (pre-gzip) |
|---|---|---|---|---|---|
| baseline (current v2) | 14,377,554 | 14,638,146 | 100.0% | 13,616,742 (100%) | 52,209,842 (100%) |
| opt1 skip idle units | 10,232,608 | 10,493,200 | **71.7%** | 9,471,796 (69.6%) | 19,561,345 (37.5%) |
| opt2 unit sparse series | 10,295,350 | 10,555,942 | 72.1% | 9,534,538 (70.0%) | 17,550,394 (33.6%) |
| opt2u (unit-major order) | 10,551,750 | 10,812,342 | 73.9% | 9,790,938 (71.9%) | same as opt2 |
| opt1+2 sparse + bitmask | 10,146,911 | 10,407,503 | **71.1%** | 9,386,099 (68.9%) | 17,099,075 (32.8%) |

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

## Recommendation

If ~1.4× (‑29%) matters, implement **opt1** (skip idle units + dead-id list):
it delivers within 0.6 pt of the best combined variant at a fraction of the
complexity — the frame decode loop stays frame-major in both Go and JS, and
the keyframe/skim/chunk-serving model is untouched. opt2 is not worth its
decoder rewrite (three implementations must change in lockstep) for ~0.9 pt
over opt1. Note the absolute stakes: ~4.2 MB on a 33-min 8v8; the format is
already 22× smaller than the source `.brsnap`.

Reproduce: `go run ./experiments/brp-eval <capture.brp>`.
