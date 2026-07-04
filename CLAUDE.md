# CLAUDE.md

Guidance for working in this repo. Keep it current when commands or architecture change.

## What this project is

`barreplay` downloads a Beyond All Reason (BAR) replay, **re-simulates it headlessly**
in the Recoil (Spring) engine, and records periodic **snapshots** of game state (unit
positions, types, teams, health, lifecycle events) to disk. A `.sdfz` replay stores
only the deterministic input stream — not positions — so the only way to recover
positions is to replay it in the engine and sample state from a read-only Lua widget.

## Build / test / common commands

```sh
go build ./cmd/barreplay        # build the capture CLI -> ./barreplay
go build ./cmd/barreplay-viz    # build the visualization server -> ./barreplay-viz
go test ./...                   # all unit tests (no engine required)
go vet ./... && gofmt -l .      # lint; gofmt -l prints nothing when clean
go run ./cmd/barreplay -no-run <link|gameId|file.sdfz>   # download+parse only, no engine
go run ./cmd/barreplay-viz -snapshots ./snapshots        # serve the viewer at 127.0.0.1:8080
```

Tests are hermetic: `barapi` uses a mock HTTP server, `demofile` tests against the
real fixture `internal/demofile/testdata/sample_header.sdfz`, and `snapshot`/`capture`
are pure. None of them launch the engine.

## Architecture (where things live)

```
cmd/barreplay/main.go     CLI: link/gameId/.sdfz -> full pipeline
cmd/barreplay-viz/main.go CLI: serve the browser playback UI over a snapshots dir
internal/barapi/          resolve gameId via api.bar-rts.com; download .sdfz from OVH
internal/demofile/        gunzip + parse packed header + TDF startscript
internal/engine/          locate spring-headless/pr-downloader, provision, launch, stream stdout
internal/capture/         parse the widget's BRSNAP stdout protocol -> snapshot records
internal/viz/             load .jsonl/.brsnap -> compact wire JSON; serve embedded HTML/JS viewer
snapshot/                 PUBLIC data model + pluggable Writer (owns on-disk format; v1 JSONL)
assets/lua/snapshot_widget.lua   embedded, read-only sampler (go:embed)
```

Key design rule: **the on-disk format lives only in `snapshot/`** behind the `Writer`
interface. To change it (e.g. a binary/columnar format) implement `snapshot.Writer`;
nothing in `capture`/`engine` changes. `capture.Consume(r, baseMeta, w)` is the seam
between the engine's text output and the writer.

### Data flow

`barapi.Resolve/Download` → `demofile.Parse` (versions/map/gameId) →
`engine.Locate` → `engine.EnsureContent` (pr-downloader) → `engine.WriteWidget`
(substitutes the output-file path) → `engine.EnableWidget` (seed widget config) →
`engine.BuildStartscript` → `engine.Run` (widget writes `<out>/<gameId>.brsnap`
directly) → `capture.Consume` reads that file → `snapshot.NewJSONLWriter`.

Note the widget writes its BRSNAP stream to its **own file** (path substituted from
`Config.SnapshotStreamPath`), not to stdout: the tool drains the engine's stdout (watching
only for the widget's first `[barreplay]` line, which marks the load/sim boundary) and
parses the file after the engine exits. `-progress` still works off `infolog.txt` (the
widget's heartbeat lines keep `[f=]` markers flowing there).

### Widget wire protocol (BRSNAP)

The Lua widget writes tagged lines to its output file; `internal/capture` parses that
file after the run. Evolve the widget and `capture` together.

**Why a file, not `Spring.Echo`:** the engine flushes its log on every Echo *and* caps
each Echo at a few hundred units (a real replay hit 617), so streaming snapshots through
stdout was slow and silently truncated. `System` exposes `io` to widgets (BAR's own
`savetable.lua` uses `io.open`), so the widget opens the substituted `__OUTPUT_PATH__`
and writes each whole sampled frame (`F` line + all `U` lines) with one `out:write`,
flushing every sample and closing in `GameOver`/`Shutdown`. No size cap, one write per
frame. Only the small `[barreplay]` heartbeat lines still go through `Spring.Echo` (for
`infolog.txt` / `-progress`). `capture` still cross-checks each frame's `U` count against
the `F` line's declared `<count>` and warns on a mismatch.

**Path sandbox (non-obvious):** Spring's `LuaIO::fopen` runs `IsSafePath`, which rejects
**absolute paths** and any `..`, so the widget can only write a *relative* path resolved
against the engine's working directory. `engine.Run` sets `cmd.Dir` to the write-dir and
passes the widget a relative `barreplay/<gameId>.brsnap` (`Config.SnapshotStreamPath`);
the tool reads it from `<data>/barreplay/<gameId>.brsnap` after the run and moves it to
`<out>/<gameId>.brsnap`. An absolute path makes `io.open` return nil → no file at all.

```
BRSNAP D <defID> <name>                        unit-def id -> internal name (preamble)
BRSNAP T <teamID> <allyTeam> <side>            team info (preamble)
BRSNAP READY                                   end of preamble
BRSNAP F <frame> <timeSec> <count>             start of a periodic snapshot
BRSNAP U <id> <def> <team> <x> <y> <z> <hp> <maxHp>   one unit (follows an F line)
BRSNAP EV <frame> <kind> <id> <def> <team>     unit lifecycle event
BRSNAP PROF <totalMs> <name>                   engine time-profiler record (once, at game over)
BRSNAP PROFD <frame> <units> <totalMs> <name>  per-heartbeat profiler sample (-profile only)
```

The widget never touches synced state (only `Get*` reads, unsynced console commands, its
own output file, and unsynced widget-handler calls) so it cannot desync the replay. `__SAMPLE_EVERY__` is substituted at write time (`-every`, default 30 = 1 Hz).
It also echoes plain `[barreplay] ...` heartbeat lines (on load + every 300 frames ≈ 10s of
game time) for infolog visibility; when the heartbeat frame was also sampled it appends
`sample_time=<n>us` (the per-sample processing cost, timed via `Spring.GetTimer`/`DiffTimers`;
falls back to `<n>ms` via `os.clock` if the hi-res timer is absent). `capture` ignores any line without the `BRSNAP` tag. The
widget forces max playback speed via `setminspeed`/`setmaxspeed` in `Initialize` (re-asserted
each heartbeat) — without a loaded widget the replay runs realtime.

### Making BAR actually load the widget (non-obvious)

Dropping a widget into `<data>/LuaUI/Widgets/` with `enabled = true` is **not** enough. BAR's
widget handler (`luaui/barwidgets.lua`) auto-runs a *new user* widget only when
`self.allowUserWidgets and not allowuserwidgets` — but a **replay forces `allowuserwidgets = true`**,
so that clause is false and the widget is scanned yet left disabled. A user widget runs only if
its name is already in the saved order list `<data>/LuaUI/Config/<gameShortName>.lua` (BAR is
`BYAR`). So `engine.EnableWidget` (`internal/engine/widgetconfig.go`) seeds a minimal config
`return { order = { ["BAR Replay Snapshotter"] = 1 }, ... }`, backing up and restoring the user's
real config around the run (with self-heal if a prior run was interrupted). The widget name in
the seeded config must exactly match `GetInfo().name` in the Lua asset (a test guards this).

A **gadget** would be worse here: `luarules/gadgets.lua` only scans the write-dir when
`Spring.IsDevLuaEnabled()` (else `VFS.ZIP_ONLY`, game-archive only), so a dropped-in gadget
won't load without an extra dev flag. Widgets are the right injection point.

## Visualization tool (`cmd/barreplay-viz` + `internal/viz`)

A **separate, read-only** tool that serves a browser playback of a finished capture; it
never touches the engine. `barreplay-viz -snapshots <dir> [-addr host:port]` scans the
dir for `.jsonl`/`.brsnap` files and serves the viewer.

- **`internal/viz/loader.go`** decodes a file into an in-memory `Replay` (Meta + Frames +
  Events). `.jsonl` goes through `snapshot.NewReader`; `.brsnap` (the raw widget stream)
  is re-parsed through `internal/capture` via an in-memory `snapshot.Writer` (`memWriter`)
  — so the viz tool reuses the exact same parser as the capture pipeline. A `.brsnap` has
  no versions/map in it (only the `D`/`T` preamble), so only the gameId (from the filename)
  is seeded there.
- **`internal/viz/wire.go`** converts a `Replay` into the browser payload. Frames pack their
  units into a **flat `[]int32` of stride 7** (`[id, def, team, x, z, hp, maxHp]`, positions/
  health rounded to ints, height `y` dropped) instead of an array of objects: a real replay
  is ~600 units/frame over thousands of frames, so this cuts the JSON an order of magnitude.
  `unitStride` (Go) must stay in lockstep with `STRIDE` (JS in `web/app.js`). It also computes
  the world-space `bounds` (for viewport fit) and a team roster (Meta.Teams plus any team id
  seen only in frames/events, so nothing renders colourless).
- **`internal/viz/server.go`** embeds `web/{index.html,app.js,style.css}` via `go:embed` and
  exposes `/api/replays` (the file list) and `/api/replay?file=<basename>` (one capture's wire
  payload). The `file` param is confined to the snapshots dir (basename only — rejects any path
  separator / traversal). Assets are served `no-store` so a changed UI never serves stale.
- **`internal/viz/web/`** is plain HTML/Canvas/vanilla-JS — **no framework, no build step**
  (the prompt allowed Vite but it's unnecessary for a single embedded page). `app.js` reads the
  flat unit arrays by index (no per-unit objects), batches dots by team colour, and does
  timeline scrub / play / zoom / pan / hover-tooltip. Colours are assigned per ally-team (a base
  hue per ally, lightness varied per team within it).

Guarding the tool: `internal/viz/viz_test.go` round-trips a synthetic `.jsonl` and `.brsnap`
through `Load`, checks the flat-array packing + bounds in `toWire`, and checks the dir listing.
No engine or browser needed.

## Running a real capture (needs the engine + content)

`barreplay -data <BARdata> -out ./snaps <replay-link>` will, in order: download the
`.sdfz`, parse it, ensure engine+game+map are present, inject the widget, and run
`spring-headless`. For that to work the host needs:

- `spring-headless` **matching the replay's engine version exactly** (sync-version must
  match or the re-sim desyncs). Point `-engine` at it or place it under
  `<BARdata>/engine/<version>/`.
- The game archive and map (auto-fetched by `pr-downloader` when a copy is found and
  `-no-provision` is not set; override identifiers with `-game`/`-map`).

### Provisioning the engine + content manually (validated recipe)

The Recoil engine is on GitHub Releases (`beyond-all-reason/RecoilEngine`). The
`recoil_<ver>_amd64-linux.7z` asset (~31 MB) bundles `spring`, `spring-headless`,
`spring-dedicated`, and `pr-downloader`. Extract it into a data dir (`7z x`); use that
dir as both the engine location and `--write-dir`.

`pr-downloader` defaults to `springrts.com`, which has **no BAR content**. The tool
therefore sets two env vars automatically in `engine.prdEnv` (each overridable — a
pre-set value in the environment wins):

- `PRD_RAPID_REPO_MASTER=https://repos.beyondallreason.dev/repos.gz` — **games/mods**
  (rapid). Also settable via `-rapid-repo`.
- `PRD_HTTP_SEARCH_URL=https://files-cdn.beyondallreason.dev/find` — **maps** (BAR maps
  are not in rapid; they resolve through this springfiles-compatible search endpoint).
- `PRD_RAPID_USE_STREAMER=false` — download rapid pool files individually over HTTP
  instead of via the streamer. The streamer is faster but **flaky on WSL / behind
  proxies**: it stalls mid-pool and leaves a `packages/<md5>.sdp.incomplete` (which the
  engine ignores, so the game archive is reported "not found" even though pr-downloader
  exits 0). Defaulted off for reliability; set `PRD_RAPID_USE_STREAMER=true` to opt back in.

`pr-downloader` re-queries (and can re-download) content on every call even when it is
already installed, so `EnsureContent` first checks the filesystem and skips the download
when the content is already there: a rapid game is a finalized `packages/<md5>.sdp` (the
md5 comes from the same versions.gz line as the tag; a `.sdp.incomplete` does not count),
and a map is an archive in `maps/` named after the normalized springname (lowercase,
spaces→`_`, e.g. `Hooked 1.1.1` → `hooked_1.1.1.sd7`, matched case-insensitively). This is
self-correcting — delete the content and it re-downloads. `-force-provision`
(`Config.ForceProvision`) forces the download; `-game`/`-map` overrides always run.

Provisioning is best-effort — a download failure is a warning, not a hard abort
(idempotent; skips content already installed). Behind a proxy you may still need
`PRD_SSL_CERT_FILE=<ca>` in the environment (the tool passes it through); the streamer
is already disabled by default (see above). The equivalent manual recipe:

```sh
# from inside the extracted engine/data dir:
PRD_RAPID_REPO_MASTER=https://repos.beyondallreason.dev/repos.gz \
PRD_RAPID_USE_STREAMER=false \
PRD_SSL_CERT_FILE=/path/to/ca-bundle.crt \   # only if the system trust store lacks the proxy CA
./pr-downloader --filesystem-writepath . --download-game "byar:git:<commit-sha>"
./pr-downloader --filesystem-writepath . --download-map "Isidis crack 1.1"
```

A replay pins **one exact game build**, so the moving `byar:test` tag is wrong: it
resolves to the latest test build, not the one the demo needs, and the engine then
aborts with `content_error: Dependent archive "…" not found`. The demo's `gameVersion`
is the build's *springname* (e.g. `Beyond All Reason test-30541-1efcf40`) but carries
only the **short** sha, and pr-downloader won't resolve a game by springname — you must
hand it the full `byar:git:<full-sha>` rapid tag.

`engine.resolveRapidGameTag` (`internal/engine/rapid.go`) does this automatically: it
reads the gzipped rapid index (`https://repos.beyondallreason.dev/byar/versions.gz`,
lines are `tag,md5,depends,springname`), matches the demo's springname exactly, and
downloads the resulting tag. The index is cached at **`<data>/cache/versions.gz`**: a
cache hit skips the download; a miss (new build not in the cached copy) triggers exactly
one refresh that atomically replaces the cache. It is best-effort — if the lookup fails
it falls back to passing the springname as-is; `-game <tag>` is the manual override. The
versions URL is derived from `-rapid-repo` (`…/repos.gz` → `…/byar/versions.gz`).

The wrapper startscript `barreplay` writes forces max speed:
`[game]{ demofile=<abs path>; } [modoptions]{ MinSpeed=9999; MaxSpeed=9999; }`.

## GPU / headless caveat (important)

This Recoil build's `spring-headless` still initializes a **null GL context (version
0.0)** and builds a unit-icon **render-to-texture atlas** at load (`CIconHandler` /
`CTextureRenderAtlas`). On a **GPU-less** machine that render never completes
(`atlasRendered=0` loops forever), so the game never reaches "playing" and LuaUI
widgets — including the snapshotter — never load. Symptoms in `infolog.txt`: stuck at
`[f=-000001]`, endless `CreateAtlasTexture ... IconsAtlas_0` lines, no `BRSNAP` output.
The demo does re-simulate up to that point (you'll see players connect, initial spawns,
and demo chat replay), so this is purely a rendering-init wall, not a logic problem.

Run on a host with **working GL** (a real GPU, or a full software-GL setup). Notes for
a GPU-less runner:

- The graphical `spring` binary can use software GL via **Xvfb + Mesa llvmpipe**
  (`LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe xvfb-run -a ./spring …`) — it needs
  `libsdl2-2.0-0` and `libopenal1` installed (not bundled) and is memory-heavy under
  software rendering.
- `spring-headless` under Xvfb does **not** help: it ignores the X display and keeps
  its null GL context.

## Profiling a run (where does the time go?)

The replay wall time has two parts, and the CLI splits them in its completion summary
(`engine total X = load Y + sim Z (N frames, fps, speed-up)`): **load** (engine boot, VFS
archive scan, map load, icon atlas — everything until the widget initializes, detected by
watching the engine's stdout for the first `[barreplay]` line while draining it) and
**sim** (frame processing). Load is a fixed cost; sim scales with game length and unit count.

For *what inside the sim* is expensive, the widget dumps the engine's **internal time
profiler** (the `/debug` overlay data) via `Spring.GetProfilerRecordNames()` /
`Spring.GetProfilerTimeRecord(name)`:

- every heartbeat: a `[barreplay] prof Sim=…ms Lua=…ms …` line (top 5, infolog only) —
  shows whether per-frame cost drifts as unit count grows;
- at game over: `BRSNAP PROF <totalMs> <name>` lines (top 40) written into the stream
  file, which `capture` collects into `capture.Stats.Profile` and the CLI prints as a
  sorted table with % of wall time.

**`-profile` (fine-grained mode, non-obvious):** by default the table only shows a few
coarse rows because `CTimeProfiler::AddTime` **drops all non-"special" timers while the
profiler is disabled** — only `SCOPED_SPECIAL_TIMER`s (`Sim`, `Draw`, `Lua::Callins::*`,
GC) always record. The detailed scopes (`Sim::Unit::{MoveType,SlowUpdate,Update,Weapon}`,
`Sim::Los`, `Sim::Path`, `Sim::Projectiles::*`, `Sim::Script`, …) exist but stay at 0.
`-profile` substitutes `__PROFILE__` so the widget runs `Spring.SendCommands("debug 1 0")`
in `Initialize`: arg 1 (`drawDebug`) enables profiler collection, arg 2 (`draw4Real=0`)
keeps the ProfileDrawer overlay off (nothing to draw headless). In this mode the widget
also writes `BRSNAP PROFD <frame> <units> <totalMs> <name>` samples (top 15 scopes) each
heartbeat, and the CLI prints a **growth table**: per-scope ms/sim-frame over the first vs
last third of the game, with the unit-count range — the direct answer to "what gets
expensive as the unit count grows". Profiling overhead is visible in the table itself as
`Misc::Profiler::AddTime`.

Caveats: profiler scopes **nest** (`Sim::Path` time is also counted inside `Sim`), so
entries overlap and don't sum to 100%. Records only exist for scopes the engine actually
entered; if the API is missing on some engine build the widget logs that and skips it.
`ThreadPool::{RunTask,AddTask,WaitFor}` are **inflated under `-profile`**: every tiny
task then pays two locked `Misc::Profiler::AddTime` calls, so judge threading changes by
plain-run wall time, never by the profiled totals. `ThreadPool::RunTask` also sums time
across all worker threads and can exceed 100% of wall.

The heartbeat line also reports `draws=<N>` (draw frames since the last heartbeat,
counted via the `widget:Update` callin — the engine's *real* draw rate, i.e. whether
`-throttle-draw` is holding) and `widgets=<N>` (currently active widget count — whether
the default suite stayed disabled). `-worker-threads N` injects the `WorkerThreadCount`
springsetting for the run (-1 = auto, 0/1 = no workers); it only changes local task
scheduling, so it cannot desync — sweep it with plain runs and pick the fastest.

Interpreting the split for optimization work:

- **Synced sim** (`Sim*` scopes, synced Lua = BAR's LuaRules gadgets, pathfinding, unit
  scripts, LOS) is the deterministic re-simulation itself — it *cannot* be skipped or
  approximated without desyncing. If `Sim::Unit::*`/`Sim::Script` dominate, the run is
  single-core bound (faster CPU or upstream engine work only). If `Sim::Path`, `Sim::Los`
  or `Sim::Projectiles::Collisions` dominate, those parts use the engine ThreadPool —
  check the `WorkerThreadCount` springsetting (default -1 = auto) actually spins up
  workers headless (`ThreadPool::RunTask` in the table is the tell).
- **Unsynced overhead** (LuaUI = BAR's own default widget suite, which loads in replays;
  logging/infolog flushes; draw-adjacent scopes) is fair game — it does not affect
  determinism and can in principle be disabled or reduced.

For a C++-level answer beyond the engine's own scopes, use `perf` on the running
process: `perf record -g -p $(pidof spring-headless)` then `perf report` (symbol quality
depends on how the release binary was built).

## Cutting unsynced overhead (default-on speedups)

Profiling showed ~40-50% of the sim-phase wall time is **unsynced** work that cannot
affect the deterministic re-sim: BAR's default widget suite (`Lua::Callins::Unsynced`)
and the draw-side update chain that runs even headless (`Update::WorldDrawer`, `Draw`,
unit/feature drawer updates). Two default-on optimizations remove it; since the sim is
untouched, the output `.jsonl` must stay **byte-identical** — diff against a previous
run to verify any change here.

- **`-disable-widgets` (default true):** the snapshot widget disables every other active
  widget on the first `GameFrame`. This must happen at runtime: BAR's handler
  auto-enables any game-archive widget with `enabled=true` that is *absent* from the
  saved order list (order 12345), so a seeded config can only disable widgets it can
  name, and the suite's names vary by game version. The widget sets `handler = true` in
  `GetInfo()` (grants `widget.widgetHandler`), then calls the **queued**
  `widgetHandler:DisableWidget(name)` (applied between callins; never mutate the widget
  list mid-callin via the `*Raw` variants) for every `knownWidgets` entry that is
  `active` and not itself. pcall-guarded like the profiler dump.
- **`-throttle-draw` (default true):** in demo playback the engine yields from sim to
  draw every `GAME_SPEED/MinDrawFPS` sim frames and reserves `MinSimDrawBalance`
  (default **0.15** = 15%!) of CPU time for drawing; each draw runs the full unsynced
  update chain even with headless null-GL. `engine.WriteEngineConfig` writes
  `<data>/_barreplay_springsettings.cfg` = the user's `springsettings.cfg` (if any,
  preserving e.g. `WorkerThreadCount`) merged with `MinDrawFPS=1` +
  `MinSimDrawBalance=0.001` (≈1 draw/s), and `engine.Run` passes it via `--config`. The
  user's real config is never touched — important because the engine *writes runtime
  config changes back* to whatever file `--config` names. Both settings are read once at
  startup (`CGlobalConfig`), so `Spring.SetConfigInt` from the widget would not work.

**Replay speed is governed by the local server, not raw CPU (non-obvious).** In demo
playback the client process hosts a local `CGameServer` that releases the demo's
pre-recorded NEWFRAME packets paced by `modGameTime += dt * internalSpeed`, and
`LagProtection` (`rts/Net/GameServer.cpp`) continuously adjusts `internalSpeed` toward a
**hardcoded client-CPU target**: the client reports `GetTimePercentage("Sim")` (draw time
barely counts) every second, and the server holds that at 60% (`SpeedControl=1`, default)
or 75% (`SpeedControl=2`, injected by `-throttle-draw` — with one local client the
median/max distinction is moot, so this is a free ~+25% ceiling). Consequences: the sim
idles ~40%/~25% of wall time by design, and whenever the client outruns the feed its
packet queue starves, `ClientReadNet` returns empty-handed, and the main loop spins full
`UpdateUnsynced`+`Draw` passes (the heartbeat `draws=` counter exposes this: hundreds of
draws/s late game despite `MinDrawFPS=1`). Fully removing the governor (pin
`internalSpeed` to `userSpeedFactor` when a demo is being read) needs a small engine
patch — sync-safe, since pacing changes only when pre-recorded packets are released,
never their content — and is the main remaining speed lever (~25-35% at the 60% target).

## Conventions / gotchas

- Go module: `github.com/mabn/barreplay`, Go 1.24. No third-party deps (stdlib only).
- Unit-def internal names (`armcom`, `corllt`, …) and side names (`armada`, `cortex`)
  have no spaces — the BRSNAP `D`/`T` parsers rely on that.
- `fileName` from the API contains spaces; always `url.PathEscape` it (see `barapi.DownloadURL`).
- The demo header is little-endian, byte-packed; layout verified in
  `internal/demofile/demofile.go` against the real sample (magic `spring demofile`,
  version 5, headerSize 352).
- Output: `<out>/<gameId>.jsonl` — a `meta` line then interleaved `frame`/`event` lines.
  Read it back with `snapshot.NewReader`. On completion the CLI prints the engine
  wall-time (split into load + sim, with sim fps/speed-up), the engine profiler totals
  (see "Profiling a run"), `infolog.txt` size, and the snapshot's size + line count.
- `-progress` (`cmd/barreplay` + `engine.WatchProgress`) polls the tail of
  `<data>/infolog.txt` every 2s, parses the newest `[f=<frame>]` marker, and prints
  frame/total, in-game time, %, processing fps, speed-up (fps/30), and ETA. Total game
  length comes from the demo header `GameTime`; the engine sims at 30 frames/game-second.
- Development happens on branch `claude/bar-replay-snapshots-g8jmfj`; `main` is the base.
