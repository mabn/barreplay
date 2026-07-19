# Idle-aircraft optimization (this branch; ON HOLD pending a rendering decision)

This branch carries the **idle-aircraft packing optimization**: a lossy,
deterministic `snapshot.Writer` transform (`snapshot/airidle.go`,
`NewAirIdleWriter`) wired into `cmd/pack` (default-on `-air-idle`, plus
`-air-idle-radius` / `-air-idle-secs`). It is implemented, tested, and
verified on real captures — but parked here because the final **rendering
mode** question is still open (see "The open decision" below). The base
branch (`claude/aircraft-idle-frame-optimization-o81zcl`, PR #30) contains
only the command-recording work this depends on.

## Why

Aircraft dominate `.brp` size: an idle BAR fighter never stops moving — it
circles its destination forever, defeating the delta codec's
constant-velocity prediction every sample. Measured on a real fighter-heavy
8v8 (game `eb165c6a…`, 49 min, 13.8k Nighthawks + 3.6k Highwinds): **77% of
all frame bytes are two fighter defs**. On the bigger `54ba536a…` (70 min,
37k Highwinds), five fighter defs are 81%.

## What the transform does

An aircraft that is demonstrably going nowhere is rewritten to sit parked at
the **centroid of its orbit** with zero velocity. The unmodified `.brp` codec
then predicts it perfectly and it costs **zero delta bytes** — the same
mechanism that makes ghosts free. Every other record passes through
untouched; the `.brp` format is not involved at all.

"Demonstrably going nowhere" = ALL of, for `-air-idle-secs` (default 6)
consecutive samples:

1. **Contained**: within `-air-idle-radius` (default 700 elmos) of the
   running streak centroid (anchoring at the centroid ≈ the orbit CENTER
   means an orbit of radius r needs Radius ≈ r, not 2r).
2. **No health loss** (lost hp = in a fight).
3. **No blocking command** (protocol-3 captures): a live buildee or any
   working command (attack, build, reclaim/repair/resurrect/capture,
   transport, unknown ids) blocks; move/patrol/fight block **unless the
   position target is within the radius** ("idle" means circling NEAR THE
   DESTINATION — a plane ordered somewhere far unfreezes on the very sample
   the order appears, before it starts moving); guard blocks unless the
   guarded unit is nearby.
4. **Not taking off**: a per-sample true displacement far above the unit's
   recent EMA (a landed plane spooling up) unfreezes immediately.
5. **Stationary or circling**: near-zero average movement (landed/hovering)
   OR ≥ 90° of accumulated heading rotation over the streak. A plane
   cruising in a straight line turns ~0° and can never freeze mid-flight
   (the streak centroid chases a cruiser, so containment alone is not
   enough — found the hard way).

### Continuity guarantee (the hard-won part)

The emitted path **never teleports**:

- While the transform is *faithful* (last emitted position == last true
  position) records pass through untouched — normal flight is never
  speed-capped, and the capture's OWN discontinuities (enemy-ghost re-spots)
  replay exactly as recorded.
- Any divergence the transform itself creates — gliding onto the anchor at
  freeze, back to the true path at unfreeze — moves at most **2× the unit's
  def speed per sample** (`Radius/2` fallback), so it always outruns the
  real plane and the catch-up gap only shrinks. Emitted velocity equals the
  glide displacement, so the viewer's Hermite interpolation stays smooth and
  a constant-velocity glide self-predicts (transitions cost ~nothing).
- Verified with `experiments/air-idle-continuity` on a real capture: **zero
  discontinuities introduced** — every transformed step above the glide cap
  coincides (same unit+frame) with a raw-data jump. Position error while
  frozen is bounded by ~Radius (fidelity-diffed: max deviation 701 elmos,
  no non-positional field ever altered).

## Measured results (all on real captures)

| capture | faithful | optimized | notes |
|---|---|---|---|
| `50715c6a…` 31-min combat-heavy game (protocol 3) | 2.26 MB | **2.23 MB** | 34% of aircraft records rewritten |
| `eb165c6a…` 49-min fighter-heavy 8v8 (protocol 2) | 16.56 MB | **10.24 MB (−38%)** | 65% of aircraft records rewritten |

Tuning history (why the defaults are what they are):

- **Radius 700**: sweep on `eb165c6a…` — 300→15.95 MB, 500→15.26, 600→12.48,
  **700→10.15**, 1000→9.38: the knee sits at the real fighter orbit size.
- **IdleSecs 6** (was 3): with glides, combat churn (freeze/glide/unfreeze
  cycles) made short streaks net-NEGATIVE on the combat-heavy game
  (2.34 MB vs 2.26 faithful); 6 s measured best on both games.
- The estimated widget-side variant (freezing in `replay_uploader.lua`
  before encoding, same rules) would shrink the raw `.brepstream` 68.1 →
  ~39 MB (−42%), no format change — see `experiments/brep-freeze-est`.
  Decision deferred: capture-time freezing is IRREVERSIBLE (the stream is
  the only record; pack-time keeps `-air-idle=false` as a faithful option).

## The open decision: park vs coarse orbit

Feedback from watching a real optimized replay: a genuinely idle fighter
(unit 938 in `50715c6a…` circled a ±500-elmo oval for 4+ minutes) renders as
a **parked dot** for that whole time, which reads as "the replay is broken"
even though it is the intended trade. Options:

1. **Park** (current implementation): maximum savings, idle fighters sit at
   their orbit center.
2. **Coarse orbit** (matches the original "reduce frame frequency" idea):
   while idle, emit the true position every Nth sample with velocity set to
   the CHORD toward the *next* coarse sample. The decoder's prediction walks
   the plane smoothly along the chord, so the viewer shows a slow continuous
   orbit — no parking, no wake-up glides, still no teleports. Intermediate
   samples remain exactly predicted (zero bytes); each chord endpoint costs
   a few bytes of rounding delta ≈ ~1 byte/sample per idle plane at N=8.
   Estimated ~11–11.5 MB for the 8v8 (vs 10.24 parked / 16.56 faithful).
   Needs a small N-frame lookahead buffer in the transform (fine in pack's
   offline pipeline; frame/event interleaving is not load-bearing — pack
   writes all frames, then all events).
3. Both, behind `-air-idle-mode park|coarse`.

Leaning: coarse as the default (parking was flagged twice), park as the
max-compression option.

## What's in this branch (on top of the commands-only base)

- `snapshot/airidle.go` — the transform (`NewAirIdleWriter`, options,
  gates, glide machinery). `Stats()` reports aircraft/rewritten records.
- `cmd/pack/main.go` — `-air-idle`, `-air-idle-radius`, `-air-idle-secs`
  flags; writer chain `air-idle → command filter → .brp writer` (the
  transform runs first so idleness detection sees full command data
  regardless of `-commands`); per-file "% rewritten" report.
- `snapshot/commands_test.go` — `TestAirIdleWriter` (freeze/damage/buildee/
  raw-jump/continuity), `TestAirIdleWriterGlideOut`,
  `TestAirIdleWriterTakeoff` (reconstructs unit 938's real departure, with
  and without the recorded order), `TestAirIdleWriterFarOrderBlocksFreezing`.
- `experiments/air-idle-continuity` — proves zero introduced
  discontinuities against a raw capture.
- `experiments/trace-unit` — per-sample raw-vs-transformed trace of one
  unit (the tool that found both real-capture bugs).
- `experiments/brp-track` — per-sample track decoded from a packed `.brp`.
- `experiments/brep-freeze-est` — models widget-side freezing's effect on
  raw `.brepstream` size.

## Next steps when resuming

1. Decide park vs coarse (or both + default).
2. If coarse: add the N-frame lookahead + chord-velocity emission to
   `airIdleWriter`; re-run the continuity checker and both real-capture
   size measurements; sweep N ∈ {8, 15, 30}.
3. Re-evaluate `-air-idle-secs` under the chosen mode (churn economics
   change).
4. Revisit widget-side freezing for `.brepstream` upload size (−42%) once
   the rendering mode is settled — the same gates port to Lua, but
   capture-time loss is permanent, so it should reuse the exact rules that
   prove out here.
