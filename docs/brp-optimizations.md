# .brp size optimizations — what was considered, measured, and shipped

This documents the evaluation that took the `.brp` format from v2 to v3.
Five optimizations were proposed; each was prototyped in a measurement
harness (`experiments/brp-eval`) against a real capture and judged purely on
measured size. Two shipped (opt1 and opt4, together **-45 % file size**);
three were rejected with data.

**Reference capture** for every number below: a real 33-minute 8v8 game —
309.5 MB `.brsnap` (raw widget stream), 1 952 sampled frames at 1 Hz,
4 223 293 unit records, 48 823 events. As `.brp` v2: **14 638 146 bytes**.
As `.brp` v3: **8 069 696 bytes (55.1 %)**.

**Methodology.** The harness decoded the real capture and re-encoded its
frame sections under each candidate layout while holding everything else
fixed — same 64-sample chunks, same keyframe model, same per-chunk
gzip(DefaultCompression) — so the deltas are attributable to the layout
alone. Its baseline replica reproduced the shipping v2 sections
byte-for-byte, validating the harness itself. Correctness of the shipped
result was verified end-to-end: the v3 re-pack of the reference capture
decodes to a bit-identical FNV digest of all remaining fields, and the JS
decoder was cross-checked against the Go decoder on the full file (identical
checksums over 4.2 M records × 9 columns).

The key background fact all of this rests on: **65.7 % of all delta-frame
unit records were fully idle** in v2 — every column's delta against its
prediction was zero (stationary buildings, and movers at constant velocity
whose position the dead-reckoning predictor hits exactly). Per-column change
rates: x/z/dvx/dvz ≈ 27 %, y 28 %, dvy 23 %, hp 3.7 %, build 2.4 %,
maxHp 0.9 %, def/team 0.4 %.

---

## Optimization 1 — skip unchanged units ✅ shipped (v3)

**Idea.** v2 re-encoded every live unit in every frame, even when all of its
deltas were zero — an idle unit cost 11 zero bytes per frame (pre-gzip).
Instead, list only the units that changed.

**Design.** Delta frames carry a *changed list* (new units + units where any
column's actual value differs from its prediction) and an explicit *dead
list* — absence must mean "unchanged", not "gone". The decoder
re-materialises skipped units by advancing them with the same prediction the
encoder tested against (`x += dvx`, `z += dvz`, all else unchanged), so
skipping is lossless by construction.

**Measured:** 14.64 MB → 10.49 MB (**71.7 %**) on the v2 column set. The
harness also showed why the win isn't larger than it is: gzip was already
compressing the idle records' zero-runs extremely well (raw stream 52 MB →
19.6 MB, but gzipped only 13.6 MB → 9.5 MB). Skipping removes structurally
what gzip removed statistically — the remaining gain is real but bounded.

**Cost:** a per-frame dead-id list (~2 % of records die per frame) and a
slightly more complex decoder (linear merge of survivors + changed). The
frame-major decode loop shape is unchanged in both Go and JS.

## Optimization 2 — per-unit sparse time series ❌ rejected

**Idea.** Reorganize each chunk from frame-major to unit-major: per column ×
unit, a sparse list of `(frameDelta, valueDelta)` pairs holding only non-zero
deltas, with per-chunk unit directory + presence intervals replacing the
per-frame id lists. Same-unit values would sit adjacent, hopefully helping
compression.

**Measured:** 72.1 % of baseline — *worse than the much simpler opt1*
(71.7 %), despite a 10 % smaller raw (pre-gzip) stream. Adding a per-unit
column bitmask (so idle units cost 1 byte instead of 11 zero counters)
reached 71.1 % — still only ~0.6 pt beyond opt1. Emitting unit-major instead
of column-major was ~2.3 pt worse (same-column values across units compress
better than one unit's mixed columns — a finding that also guided v3: it
kept column-major emission).

**Why rejected:** after gzip, its directory/counter structure erased the raw
advantage; the payoff (~1 pt at best) did not justify rewriting all three
codec implementations into a fundamentally different shape (and losing the
simple frame-major streaming decode).

## Optimization 3 — polar velocity (speed + angle) ❌ rejected (near-miss)

**Idea.** Units mostly travel straight, so replace `(dvx, dvz)` with
`(speed, heading angle)`: a turning unit changes only the angle, an
accelerating unit only the speed. Implemented with integer quantization
(speed in whole elmos/interval, angle in 1/1024 or 1/256 of a turn),
wrap-aware angle deltas, a "stopped unit keeps its last angle" rule, and the
x/z predictor fed by the velocity *reconstructed* from (speed, angle).

**Measured:** alone, nearly worthless (96.3 % — idle records dominate and
polar doesn't touch them). Stacked on opt1: **69.7 %** at 1024 angle steps
vs opt1's 71.7 % — a genuine ~2 pt / ~290 KB add-on; 67.3 % at 256 steps.
The mechanism was *smaller delta magnitudes*, not fewer non-zero deltas: the
change rates barely moved (speed 24.4 %, angle 23.4 % vs dvx 26.6 %,
dvz 27.3 %) because 1 Hz pathfinding jitter wobbles heading and speed almost
as often as it wobbles the cartesian components. A 2nd-order angle predictor
(constant turn rate → zero) measured slightly *worse* — headings jitter
rather than sweep smooth arcs at this sample rate.

**Why rejected:** the ~2 pt gain costs trigonometry in the hot decode path of
all three implementations, and it changes fidelity: the stored interpolation
tangent becomes the reconstruction `(spd·cosθ, spd·sinθ)` — exact for only
89.3 % of records at 1024 steps (mean L1 error 0.125 elmo/interval, max 2),
degrading visibly at 256 steps (77.8 % exact, max error 9). Positions stay
exact (residuals absorb the error), but exact tangents were judged worth
more than 290 KB. Worth revisiting only if size becomes critical.

## Optimization 4 — drop the elevation columns (y, dvy) ✅ shipped (v3)

**Idea.** `y` (elevation) and `dvy` (vertical velocity) changed in ~28 % and
~23 % of unit records — a *walking ground unit's height tracks the terrain
under it*, so the columns are mostly terrain noise re-encoded every second —
yet nothing consumed them: the viewer renders the x/z plane only, and a
ground unit's elevation is implied by the map heightmap at (x, z).

**Measured:** on top of opt1, the X section collapsed from 2.94 MB to
0.45 MB (build + team economy are all that remain). opt1+4 = **8 069 731
bytes predicted, 8 069 696 shipped (55.1 %)**.

**Cost:** a fidelity decision, not a codec trick — decoded `Pos.Y`/`VelY`
are now 0. Air-unit altitude is the one real loss (terrain implies nothing
for them). The `.brsnap` source streams still carry elevation, so a future
format revision could reintroduce it (e.g. for flyers only) without
re-capturing.

## Optimization 5 — higher-precision velocity (dv ×10) ❌ rejected

**Idea.** ~27 % of moving-unit records need a ±1 elmo position correction.
Hypothesis: they exist because `dv` is rounded to whole elmos (a unit moving
80.7 elmos/interval drifts 0.3/interval against its integer prediction), so
storing dv in tenths should eliminate them.

**Design (full-strength).** dv stored in 1/scale elmos; the decoder tracks a
*fractional position accumulator* (`fx += dvx_fine`, prediction =
`round(fx/scale)`; corrections shift whole elmos and preserve the fractional
phase). Evaluated from the raw `.brsnap` (a v2 `.brp` had already rounded
the velocities away) at scales 2/4/10/100, plus a "5b" variant that also
stores keyframe positions at fine precision so the accumulator starts
phase-exact.

**Measured:** the correction rate did not move — 26.9 % at scale 1 vs 27.2 %
at ×10 and ×100, even with keyframe phase-lock — while the file grew +4.3 %
(×2), **+14.8 % (×10)**, +28.4 % (×100).

**Why it fails (the interesting part):** position corrections almost always
coincide with a *real velocity change* during the sample interval (27 %
x-corrections ≈ 28 % dv-changes — the same records). The stored dv is the
instantaneous velocity at the sample instant; when a unit accelerates or
turns mid-interval, no precision of that stale value predicts the next
sampled position. The pure rounding-noise corrections the idea targets are
only ~1.1 % of records (measured directly with a ±1-elmo tolerance probe)
at ~1 byte each, while every real dv delta's magnitude scales with the
precision multiplier. You'd spend ~1.2 MB to save ~45 KB.

---

## Keyframes-first layout (v4) — a streaming/UX restructure with a size bonus

After v3 shipped, the keyframes (~8 % of the file, one per minute of game)
moved out of the chunks into a single-gzip `K` section, downloaded FIRST by
the viewer and decoded progressively while it streams — the whole timeline
becomes scrubbable within seconds, before any chunk arrives, and chunks
became delta-only so no byte is ever fetched twice. Not a compression
optimization per se, but merging the near-duplicate adjacent keyframes into
one gzip stream measured **12 % smaller keyframes** (626,619 → 549,899 bytes
on the reference capture, ~77 KB off the file) because a shared compression
window sees the previous keyframe's near-identical columns. File total:
8,069,696 (v3) → **7,993,143 (v4)**.

## Where v3/v4 landed, and what's left

| | bytes | vs v2 |
| --- | --- | --- |
| v2 (baseline) | 14 638 146 | 100 % |
| v3 = opt1 + opt4 | 8 069 696 | 55.1 % |
| v4 = v3 + merged keyframes section | **7 993 143** | **54.6 %** |
| …with opt3 had it shipped | ~7.7 MB | ~53 % |

Remaining levers, all measured or bounded during this work, none currently
worth their cost:

- **opt3 polar dv**: ~290 KB, at the price of approximate tangents and trig
  in three decoders (above).
- **±1-elmo position dead-band**: ~100–150 KB, at the price of positions no
  longer being exact to the elmo (~1.1 % of records become skippable).
- **Keyframes** are now ~7 % of the file (0.55 MB after the v4 merge);
  halving chunk size doubles seek granularity but adds keyframes, and vice
  versa.
- **Entropy coding**: gzip is fixed by the serving model (browsers gunzip
  chunks natively via `DecompressionStream`); a stronger coder would break
  the zero-re-encoding chunk-serving contract.

The evaluation harness (`experiments/brp-eval`, with `RESULTS.md` for the raw
tables) targets the **v2** layout — it was the instrument for this decision,
kept for reference, and needs a pre-v3 checkout to rerun against a v2 file.
`experiments/brp-digest` computes the cross-version equivalence digest used
to validate the v3 migration and works on any current-version file.
