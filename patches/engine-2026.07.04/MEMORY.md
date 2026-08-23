# Engine memory patches (engine 2026.07.04) — measured results

Sister document to `RESULTS.md`, which is about **speed**. This one is about
**footprint**: a headless BAR re-simulation on the 7.9 GB VM peaked at 6.2–6.8 GB
resident, and ~11% of the ingest daemon's jobs (20 of 175 in the queue when this
was written) died with `errorKind: "oom"` — including a 4v4 and a 3v3 that never
reached the first sim frame, and an 8v8 that was stopped at **95.6% of the demo**
after nine minutes of engine time. The same gate applies as to the speed work:
the produced `.brp` md5 must equal the reference from the **release** binary.

## Result

Peak RSS of the engine process (`VmHWM`, sampled 4×/s), engine 2026.07.04 with
the 15-patch speed stack, on the 4-core 7.9 GB VM:

| replay | before | after | Δ | gate |
|---|---|---|---|---|
| medium (16p, 13:25) | 5396 MiB | **3852 MiB** | **−1544 MiB (−29%)** | identical |
| isthmus (8v8, 27:31) | 5832 MiB | **4392 MiB** | **−1440 MiB (−25%)** | identical |

Sim wall time is unchanged (medium 1m42s → 1m37s, isthmus 5m32s → 5m29s — both
inside this box's ±10% drift).

Two changes get that, and neither is in the simulation:

| # | change | where | saving |
|---|---|---|---|
| 1 | `StaticMemPool::clear()` zeroes only the pages handed out | `0003-static-mempool-lazy-zeroing.patch` | **~1160 MiB** |
| 2 | `TextureMemPoolSize = 0` | barreplay's `engine.WriteEngineConfig` | **~380 MiB** |

## 1. The static pools: 1.05 GiB of zeroes, before main

`rts/System/MemPoolTypes.h`'s `StaticMemPool` is a flat array of N fixed-size
pages, and its constructor calls `clear()`, which `memset`s **the whole array**.
Every instantiation is a namespace-scope global, so this runs before `main` and
writes over `.bss` the loader had already zeroed. `nm -S` on the binary:

```
weaponMemPool    0x2f5d0018 = 757.6 MiB   (MAX_UNITS 32000 × 32 weapons × 776 B)
projMemPool      0x08d9a020 = 141.4 MiB
unitMemPool      0x08973820 = 137.5 MiB
featureMemPool   0x02d2a840 =  45.2 MiB
                            = 1081.7 MiB
```

`WeaponMemPool.h` even says so in a comment — "NOTE: ~742MB, way too big for
32-bit builds" — but on 64-bit it is not a reservation, it is a write. Measured
on a live 8v8 re-sim: the `.bss` mapping is 1124 MB and **1095–1123 MB of it is
resident**, from the first instant of the process to the last, whatever the size
of the game. The **official release binary has the identical `.bss`**
(`memsz 0x464a95a8 − filesz 0x110120`, same four symbols), so this is upstream
Recoil and every BAR client pays it, not just headless re-simulation.

The pool's invariant is that an unallocated page reads as zero. `allocMem` walks
the pages in order and `freeMem` zeroes each page it takes back, so everything
past `used_page_count` is already zero and only the used prefix can be dirty.
Zeroing that prefix instead keeps the invariant exactly — at construction it is
empty, so the pools now cost what their live objects cost. Same addresses, same
layout, same everything the sim can observe; the only difference is which pages
the kernel has committed. Sampled mid-game on the SAME replay, before and after:
the `.bss` mapping goes from **1094 MB resident to 35 MB**.

## 2. The bitmap arena: 512 MB, whether or not a texture is decoded

`TextureMemPoolSize` (default 512) is a single flat arena that `CBitmap`
allocates out of, and `TexMemPool::Resize` fills it with zeroes on startup — so
it too is resident in full from the beginning. Setting it to **0** selects the
engine's other implementation, `TexNoMemPool`, which `malloc`s each bitmap and
frees it again; a headless run then holds the few bitmaps alive at once instead
of the high-water mark rounded up to half a gigabyte. It is a config setting, so
this needs no engine change at all — barreplay writes it into
`_barreplay_springsettings.cfg` alongside the draw-throttle overrides. Measured
saving 381 MiB, and the no-pool path is also the more robust one: the arena
answers an allocation it cannot fit with `nullptr`.

## The shape of the problem: it is load, not growth

The peak is reached before the simulation has done anything. On the isthmus 8v8
(fixed engine, sampled 4×/s): **3894 MiB by t=12s, when loading ends**, against a
4392 MiB peak — 27 minutes of 8v8 simulation adds ~500 MiB. That is why the queue
shows 3v3 and 4v4 games dying at frame 0 alongside the 8v8s, and why a fixed
saving is worth more here than anything proportional to the size of the game.

## What is left

Peak is still 4.4 GB on an 8v8, and the same 4×/s sampling puts almost all of it
in the load phase. Ranked by what the curve says, against the isthmus load
timeline in `infolog.txt`:

**1. The draw-side texture atlases, ~700 MiB, best lead.** `Creating Projectile
Textures` runs from t=2.93s to t=4.47s of load and the process gains ~695 MiB
across it; a mapping trace shows one allocation growing 384 → 408 → 439 MiB
inside that window. `CProjectileDrawer::Init` builds two `CTextureAtlas`es out of
BAR's whole FX texture set, and `CTextureAtlas` keeps a CPU copy of every source
bitmap (`memTextures`) *plus* the assembled `atlasPages`. Headless it does all of
that and then logs `Could not finalize groundFX texture atlas` — the work is
thrown away. H49 (skip the `.smt` tile decode headless) is the precedent for
cutting it.

**2. Definitions + models, ~1.3 GiB, needs finer sampling to split.** The second
from t=2 to t=3 alone gains 1377 MiB and covers `Loading GameData Definitions`
through `Loading Map Tiles` — unit/weapon/feature defs, radar icons, `Creating
Unit Textures`, `Loading Models`. Some of that is sim-bearing (the defs) and some
is not (the textures). A 50 Hz RSS sample against the same log lines would split
it; 4 Hz cannot.

**3. QTPFS, 379 MB**, which it reports itself (`[QTPFS] mem-footprint: 379MB`,
43 node layers on this map). Real pathfinding state, so this is a data-structure
question, not dead weight.

**4. The map's unsynced duplicates, ~122 MB.** `CReadMap` allocates
`faceNormalsUnsynced` (56.6 MB on a 1536² map), `centerNormalsUnsynced` (28.3),
`VisVertexNormals` (28.3) and `cornerHeightMapUnsynced` (9.4) beside their synced
originals. Tempting, but `GameHelper.cpp` reads the unsynced side, so this is not
the pure draw-side cut it looks like.

**5. mimalloc knobs, unmeasured.** The engine statically links mimalloc and sets
no options, so `MIMALLOC_PURGE_DELAY=0` / `MIMALLOC_PURGE_DECOMMITS=1` /
`MIMALLOC_ARENA_EAGER_COMMIT=0` are available for the cost of an environment
variable. Its arenas are five 1 GiB mappings holding 2.7 GB resident mid-game;
how much of that is free-but-unreturned is not known.

## How these were measured

`scratchpad/rsswatch.py`-style sampling of `/proc/<pid>/VmHWM` 4×/s while
`perf2/gate.sh` runs, which also does the byte-identity check. Two notes that
cost time:

- **The engine renames its main thread**, so `pgrep -x spring-headless` finds it
  for the first second of load and never again — which reads as a 689 MiB peak on
  a run that really peaked at 5396. Find it by `/proc/<pid>/exe` instead.
- `gate.sh` installs the binary under test as `<engine dir>/spring-headless`,
  i.e. over the stock one. Put `perf2/spring-headless.release` back afterwards.
