# Engine speed patches — measured results

Goal: make the headless re-sim significantly faster (target ≥50%) with
**byte-identical output** (`.brsnap` minus the wall-clock `BRSNAP PROF*` lines).

Patches apply onto the `2025.06.24` tag of
`github.com/beyond-all-reason/RecoilEngine` (`git am patches/engine-2025.06.24/*.patch`),
built with the official pinned docker image + release flags
(see `docs/building-recoil.md`).

Benchmark: replay `6da7496aca487581a12b7a6d5bd99bc0` — 8v8, Supreme Isthmus v2.1,
32:31 game time, 58,530 sim frames. 4-core (AVX-512) GPU-less VM, default
`barreplay` flags (`-disable-widgets -throttle-draw`, 1 Hz sampling).
"sim" excludes engine load. Reference: capture from the unpatched build;
`grep -v "^BRSNAP PROF"` both streams and compare md5.

| build | sim wall | sim fps | vs baseline | output |
|---|---|---|---|---|
| unpatched 2025.06.24 (baseline) | 17m09s | 57 | — | ref `8cb2b931…` |
| + 0001 unpaced demo playback | 12m43s | 77 | **−26% wall / +35% fps** | identical |

## 0001-demo-unpaced-playback.patch

`CGameServer::Update()`: when a demo is being read and a local client is
attached, advance `modGameTime` to `demoReader->GetModGameTime() + 2s` each
server tick (~5 ms) instead of pacing it by `internalSpeed`. `LagProtection()`
steers `internalSpeed` toward a fixed client-CPU target (60% at
`SpeedControl=1`, 75% at `=2`), so by design the sim idled ~10-25% of wall and
— worse — whenever the packet queue ran dry the client main loop spun full
`UpdateUnsynced`+`Draw` passes (108 s of `Draw` on the benchmark, hundreds of
draws/s late game despite `MinDrawFPS=1`). The engine's existing
`GAME_SPEED`-frames-behind gate provides flow control (the release window only
opens while the local client is <30 frames behind the release point), so the
queue stays bounded at ~90 frames. Release *pacing* only — packet contents are
untouched, so the sim input stream is bit-for-bit the demo's.

After the patch: `Draw` 108 s → 2.6 s, heartbeat `draws=` 1-2 per 10 game-sec
(was hundreds/s), sim 93% of wall — the run is CPU-bound on `Sim` proper.

Removes the need for the `SpeedControl=2` injection (`-throttle-draw`'s other
half, `MinDrawFPS`/`MinSimDrawBalance`, stays useful for the load phase).

## Iteration 2 findings (no engine patch)

**Fine-grained profile** (`-profile` run of the 8v8 on the 0001 build; scopes
nest and ThreadPool rows are inflated by profiling itself — see CLAUDE.md):
`Sim::Unit::MoveType` 123 s (15%), `Sim::Script`/`CUnitScriptEngine::Tick`
~105 s (13%), `Sim::Unit::UpdatePreFrame` 89 s (11%), `Sim::Unit::Update` 66 s,
`SlowUpdate` 59 s, `Weapon`+`UpdateWeaponVectors` 79 s, `Sim::Path*` 71 s,
`Sim::Los` 40 s, `Lua::Callins::Synced` 65 s, `Lua::Callins::Unsynced` 38 s.
All the big rows are the deterministic sim itself — no single dominant
removable scope, which points at whole-program levers (PGO/LTO) plus the
worker-thread count.

**Worker threads**: `ThreadPool::AddTask/WaitFor` volume suggested
oversubscription on 4 cores. Small-replay sweep (sim wall): auto(-1) 41 s,
wt=0 39 s, **wt=2 36 s**, wt=3 39 s. Policy going forward (user decision):
**all benchmark sims run with `-worker-threads 2`**; no further tuning of this
axis. Scheduling-only, cannot affect determinism.
