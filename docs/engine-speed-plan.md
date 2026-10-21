# Engine speed work: where it stands and what to do next (2026-10-21)

The speed work ran from 2026-10-15 to 2026-10-21 against one target: the
verylarge1 replay (`6a37d06acbb455b1d19179d8ec965f10`, 90,900 frames, 16
players) re-simulated in under 10 minutes of governed active time, with the
capture byte-identical to stock (`a26e920d594a346884b93c3389053a1f`). The
day-by-day record is [worklog-engine-speed.md](worklog-engine-speed.md); every
change is a patch under
[patches/engine-2026.07.04/speed/](../patches/engine-2026.07.04/speed/README.md),
with its toggle, measurement and status in that README.

## Result

| build | what | verylarge1, governed whole game | md5 |
|---|---|---|---|
| stock 2026.07.04 | | 38m17s active | (differs only in the analysis sections) |
| `speed63` | 0014-0138, `t3=7f` | 10m37.4s | `a26e920d…` |
| **`speed65`** | **0014-0156, PGO retrained, `t3=ffffff`, widget 1.13.1** | **9m59.3s** | **`a26e920d…`** |
| `speed66` | + N3, H128, H129 (0157-0160) on `pgo65`'s profile, `t3=6ffffff` (N3 off) | 10m15.1s (stale profile, see Measurement) | `a26e920d…` |
| **`speed70`** | **`speed66`'s code, profile retrained on it, `t3=6ffffff` — the final setting** | **10m01.6s** | **`a26e920d…`** |

The goal was met by `speed65`, by 0.7 seconds. The final setting is
`speed70`: its whole game is level with `speed65`'s (+0.4%, inside the
±1-2% a whole game moves with the package temperature), and in the late
windows it is ahead by median in both (-0.5% at 63,780, -0.8% at 82,000;
instructions -1.3% and -2.6%) — H128 and H129 on a profile trained on their
own code. Its setting:

- engine: the published series, then every patch under `speed/` and
  `speed/rejected/` from 0014 to 0160 in number order, except the rejected
  0044-0045, 0052-0062 and 0068 (the speed README's "Applying" has the
  command; checked to reproduce `Recoil 779e4af` with no difference — the
  branch itself is local, the patch files are its record);
- toggle words `t=d4d87abf`, `t2=9bae383f`, `t3=6ffffff` (environment
  `BARREPLAY_TOGGLES`, `BARREPLAY_TOGGLES2`, `BARREPLAY_TOGGLES3`; H109 is read
  from the environment only, at engine start; N3's bit `0x1000000` off);
- `-worker-threads 7` (the main thread plus six workers, one per free logical
  CPU), the main thread pinned alone on its core;
- widget 1.13.1 (W8's damage columns; its re-sim captures are identical to
  1.13.0's);
- the PGO profile `speed/tools/pgo-profile-speed70.tar.xz` (trained on
  `779e4af` with the setting above by `speed/tools/scripts/pgotrain2.sh`),
  Haswell target (AVX2/BMI, no FMA, 128-bit vectors), LTO;
- built by `speed/tools/build-pgolto-g.sh` (`pgo/build.sh`'s recipe with `-g`
  kept and `PROFILE`/`EXTRA_CMAKE` hooks) with
  `EXTRA_CMAKE='-DSYNCCHECK=OFF -DMARCH_FLAG=haswell -DSSE_FLAGS="-mno-fma
  -mno-fma4 -ffp-contract=off -mprefer-vector-width=128"'`;
- measured by `speed/tools/scripts/fullrun.sh` (the thermal governor: pause at
  88 °C, resume at 55 °C; active time excludes the pauses, and the active
  stretches run at ~3.7 GHz). The pipelines that drove the builds
  (`pipe*.sh`) stayed in the session's work directory; the work log quotes
  what each did.

## What the last builds measured

Late-window trials (63,780 and 82,000 + 450 frames, CRIU checkpoints, main
thread pinned, medians or means of 3-4 rounds):

| build | items | 63,780 | 82,000 |
|---|---|---|---|
| `speed64` | P11 v2, H114-H122, P12 v2 (eleven) | -3.4% | -3.8% |
| `speed65` | H123-H127, P12 v3 (six) | -1.9% | -2.8% |
| `speed65` | W8 (widget + engine) | -0.6% | |
| `speed66` | H128 (`TraceRay` sphere test) | -0.8% | -1.0% |
| `speed66` | H129 (weapon-loop prefetches) | -0.5% | -0.8% |
| `speed66` | N3, bit on but not native (see below) | +0.9% | +1.0% |
| `speed70` vs `speed65` | the two binaries interleaved, medians | -0.5% | -0.8% |

Every item was gated byte-identical on the medium replay and the whole game;
P4/P10/P12 also have check modes that compare every pipelined decision with
the in-order one (0 mismatches in every check trial).

## Next steps

### 1. Make it usable: a published revision — done, revision 5

Published 2026-10-21 as `2026.7.4-barreplay.5`, for Linux and Windows
(docs/building-recoil.md, "Revision 5"). How the open questions were settled:

- **The series**: every patch from 0014, exactly as "Applying" applies them,
  then 0161; applied to the tag it reproduces the final branch with no
  difference.
- **The toggles**: compiled in as defaults (0161) — a host needs no
  configuration, and the environment still overrides each word, so a
  regression can still be bisected by switching bits off.
- **The target**: generic x86-64, as the stock release, on both platforms;
  the Haswell builds measured here gained ~1% and would crash on older CPUs.
  The profile was retrained for it.
- **The sync checker** stays compiled out (P1 needs it so): a re-sim on the
  published build reports no desyncs, whatever happens.

Measured on the published builds: the medium replay in 1m11s against
stock's 1m52s on Linux (78 s against 116 s of simulation for Windows under
Wine), and verylarge1's whole game in **9m56.0s**, identical — the
retrained profile more than made up for the generic target (`speed70` took
10m01.6s, `speed65` 9m59.3s). Hosts pick it up once its pin
(`patchedBuilds`, revision 5) is merged; FogOfWar.exe's Windows pin lives on
its own branch.

### 2. Make the gates catch more

- **The medium gate replay runs an older BAR build**, on which N2's handler
  hashes do not match (only `Explosion` goes native) and N3 cannot activate:
  the quick gate has never exercised N2 or N3. Add a short gate replay of
  verylarge1's own build (test-31620's `luarules/gadgets.lua`).
- Gate a sandboxed-BAR replay (2026.10.13 and later: proxy widget handler,
  inferred projectile ends) and a replay with heavy Lua tweakdefs.
- Run the check modes (`BARREPLAY_P4_CHECK`, `BARREPLAY_P12_CHECK`) over
  whole games, not only 450-frame trials.

### 3. Measurement

- Pick by **medians**: one restore that comes back before its memory is in
  huge pages runs ~17% slow and decided a three-round mean once (`speed64`),
  and turned `speed70`'s mean at 82,000 from -2% to +3.4%. With an even number
  of rounds average the two middle values: the pipelines' `sorted(v)[n//2]`
  took the upper one and read that same window as +0.4%.
- **Compare builds only on their own profiles.** `speed66` (H128 + H129 on
  `speed65`'s profile) ran its whole game 2.6% slower than `speed65`, because
  the functions those patches rewrote built without a profile; retrained
  (`speed70`) it was level. Trials inside one binary compare toggles, not
  builds.
- Whole games vary by ±1-2% with the package temperature; a sub-percent item
  is judged on the late windows, interleaved and pinned.
- The runners wait for DNS (`api.bar-rts.com`); a blip lost `speed64`'s game.

### 4. Remaining performance, ranked by expected gain per effort

Main thread of `speed65` at 63,780 (window only):

| block | main thread | notes |
|---|---|---|
| Lua callins (gadgets) | 18.2% | the game's own code; `luaV_execute` 3.6, `luaH_get` 2.9, `luaD_precall` 2.1 of own time |
| aircraft move loop (P1) | 9.5% | its in-order start chain is ~3% of main |
| `UpdateUnits` | 8.7% | own time 4.3% |
| script tick | 8.3% | P11's in-order pass, COB `Tick` 2.3% |
| `CUnit::SlowUpdate` | 6.0% | builders' repair search 1.6% (`GetUnitsExact`) |
| ground movement | 5.6% | |
| `CWeapon::Update` | 4.9% | H129 targets its misses |
| LOS update | 4.8% | H126 split the map work |

1. **Finish N3** (0157, built, off). On verylarge1's build `UnitCommand` has
   one handler behind BAR's wrapper (`206aa2111d832cd3`) but `UnitCreated` and
   `UnitDestroyed` have two each, most likely LuaRules' and LuaGaia's (the
   engine's base-content handler, not read). Next: make N2's log line name the
   Lua state, read the base-content handler, list only the hashes whose source
   was read, and find out why the bit costs ~1% while nothing is native (the
   registry lookup of N2's state on every callin is the first suspect; it can
   be cached per handle). Then `AllowCommand` (0.38% handler time) and
   `GameFrame` (0.15%). ~0.5-1% in all.
2. **Prefetch audit.** H129 found H75's raw-offset prefetches and the
   `sizeof(CUnit) - 1` ones aimed at the wrong cache lines after members were
   added. Rewrite every prefetch by member address and add `static_assert`s
   on the offsets that matter; then re-measure H66/H75/H98/H112/H115 together.
3. **P4's in-order commit** (2.7% of main own time, spinning on a search a
   worker holds): launch the slow-update slice's searches earlier, or have the
   main thread take the heaviest ones.
4. **The capture widget's projectile frame** (`GameFramePost`, 0.42%) in the
   engine, the way W6/W8 moved the sample and the damage drain. Its events stay
   in Lua: their arguments pass through BAR's widget handler, which can change
   between game builds.
5. **Builders' repair search** (1.6%): an exact index of damaged or
   unfinished allies per quad, kept in the quad lists' order, would let it skip
   `GetUnitsExact`; it must be maintained on every health change and move.
6. **P1's in-order start chain** (~3%): needs a proof that a run's checks
   cannot fail once the serial item before it is done.
7. **Lua interpreter** (~8.6% own time): only changes that keep every result
   and every table layout (iteration order is synced behaviour); threaded
   dispatch and inline gets are already in.
8. **A PGO retrain after every batch of code changes** (see Measurement): a
   profile trained on older code leaves the rewritten functions cold, which
   cost `speed66` 2.6%.

Ruled out along the way (details in the work log and `rejected/`): BOLT (PGO
already lays the code out), workers spinning between sections (H96: hotter,
slower), parallel aircraft updates beyond P1, approximate simulation of any kind (the demo carries every player's sync
checksum).

## Constraints that every next step keeps

- **Byte-identical output** to stock for the same widget: every change is
  either exact by construction (the same operations in the same order on the
  same values) or a scheduling change whose results cannot depend on the
  schedule, and each is gated.
- **Games' own Lua stays the game's**: tweakdefs, gadgets and widgets run as
  written. Native fast paths (N2/N3) replace only handler code whose bytecode
  hash matches source that was read, and fall back to Lua for anything else,
  including any mod's handler.
- **BAR's Lua sandbox keeps working**: the engine additions the capture
  widget uses (`Spring.GetUnitSampleDelta`, `DrainLoggedDamageColumns`, the
  event log) answer only a full-read (spectator) handle, so a playing client
  cannot see enemy state through them, and the widget feature-detects them.
