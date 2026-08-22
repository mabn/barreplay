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
