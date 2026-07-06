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
