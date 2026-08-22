# Engine speed patches (engine 2026.07.04) — measured results

Goal: make the headless re-sim significantly faster while the produced **`.brp`
is byte-identical** to the one the stock engine produces.

Patches apply onto the `2026.07.04` tag of
`github.com/beyond-all-reason/RecoilEngine` (`git am patches/engine-2026.07.04/*.patch`
then the `experiments/` series), built with the official pinned docker image +
release flags (see `docs/building-recoil.md`; note the image DIGEST is
per-tag — read it from the tag's own `docker-build-v2/images_versions.sh`, and
the submodule set is larger than 2025.06.24's).

Benchmark: `4936896a8b258d038cbd28f55eb15ed2` — 16 players, All That Glitters
v2.2.3, 13:25, 24150 sim frames, on a 4-core GPU-less VM with barreplay's
default flags. "sim" excludes engine load. The gate is the `.brp` md5 against a
capture from the **release** binary.

| build | sim wall | sim fps | load | synced instructions | output |
|---|---|---|---|---|---|
| stock 2026.07.04 (release == source build) | 2m01s | 200 | 12s | 56.606e9 | ref `48a14ea2…` |
| + full patch stack | **1m41s** | **239** | **9s** | **44.428e9** | identical |
| | **−16%** | **+19%** | **−25%** | **−21.5%** | |

Across all three replays, every one byte-identical to its release-binary
reference — and the win GROWS with the size of the game, which is the case that
matters, since a 30-minute 16-player game is what actually costs an hour of
somebody's machine:

| replay | stock sim | patched sim | fps | Δ |
|---|---|---|---|---|
| small (duel, 15:31) | 1m03s | 55s | 444 → 508 | +14% |
| medium (16p, 13:25) | 2m01s | 1m41s | 200 → 239 | +19% |
| **large (16p, 30:46)** | **7m33s** | **5m12s / 5m27s** | **122 → 177 / 169** | **+39–45%** |

(The large replay was measured twice on the final stack; both runs gate
identical and the spread is this box's usual ±10% wall drift. Anything under
~10% is not resolvable here without interleaved pairs — see `experiments/LOG.md`
— which is why the per-patch verdicts use the instruction meter and only these
whole-stack numbers are quoted from wall.)

Load time is −25% on top of that (12s → 9-10s), which a short replay feels more
than a long one.

**The published series is verified to be what was measured**: applying these 15
patches with `git am` to a clean `2026.07.04` checkout reproduces, byte for
byte, the `rts/` tree of the build that produced every number above.

## The stack, in apply order

| patch | what it does | measured here |
|---|---|---|
| `0001-demo-unpaced-playback` | stop pacing demo packet release by the client-CPU governor | **wall −15%** (Sim 42% → 63% of wall, Draw 8% → 3%) |
| `0002-headless-replay-unsynced-cuts` | no unsynced gadget event client, expire unsynced projectiles | flat |
| `experiments/H1` | skip prev-frame transform save (draw interpolation state) | **instr −3.7%** |
| `experiments/H2` | skip redundant per-tick anim sort, reuse BFS scratch | −0.7% |
| `experiments/H3` | no clock reads on empty thread-pool polls | flat (cycles −2.2%) |
| `experiments/H4` | skip eager piece-transform walk | flat |
| `experiments/H5` | guided batch claiming in `for_mt` | −0.4% |
| `experiments/H6` | unchecked COB bytecode fetch under HEADLESS | flat |
| `experiments/H23` | switch dispatch in `TickAllAnims` | flat |
| `experiments/H31` | flat generation-stamped collision cache | **−1.1%** |
| `experiments/H30` | coarse exit-only block grid | **−16.3%** ★ |
| `experiments/H21` | COB jump-table opcode dispatch | **−0.8%** |
| `experiments/H45` | QTPFS relink grid: no per-event nullptr re-init | −0.3% |
| `experiments/H49` | skip `.smt` tile decode under HEADLESS | **load −25%** |

`experiments/tools/bench-harness.patch` is measurement scaffolding, not a
speedup: it is inert unless `BARREPLAY_BENCH_START/N` are set.

## What changed versus the 2025.06.24 round

The full history is `experiments/LOG.md`. Two results are worth stating here:

- **H29 (yardmap row-major indexing) is gone — upstream absorbed it.**
  2026.07.04 replaces the Morton interleave with 8×8 cache-line tiles. It was
  round 1's single biggest instruction win (−7.9%) and is now nothing.
- **H30 grew from −6% to −16.3%** and is the biggest lever of this round. Same
  hypothesis, re-authored for the tiled layout, four times the payoff.

Re-running the hypothesis set against the new engine was therefore not
bookkeeping: porting round 1's kept stack unexamined would have carried a dead
patch and undervalued the live one.
