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
go build ./cmd/barreplay        # build the CLI -> ./barreplay
go test ./...                   # all unit tests (no engine required)
go vet ./... && gofmt -l .      # lint; gofmt -l prints nothing when clean
go run ./cmd/barreplay -no-run <link|gameId|file.sdfz>   # download+parse only, no engine
```

Tests are hermetic: `barapi` uses a mock HTTP server, `demofile` tests against the
real fixture `internal/demofile/testdata/sample_header.sdfz`, and `snapshot`/`capture`
are pure. None of them launch the engine.

## Architecture (where things live)

```
cmd/barreplay/main.go     CLI: link/gameId/.sdfz -> full pipeline
internal/barapi/          resolve gameId via api.bar-rts.com; download .sdfz from OVH
internal/demofile/        gunzip + parse packed header + TDF startscript
internal/engine/          locate spring-headless/pr-downloader, provision, launch, stream stdout
internal/capture/         parse the widget's BRSNAP stdout protocol -> snapshot records
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
`Config.SnapshotStreamPath`), not to stdout: the tool drains the engine's stdout to
`io.Discard` and parses the file after the engine exits. `-progress` still works off
`infolog.txt` (the widget's heartbeat lines keep `[f=]` markers flowing there).

### Widget wire protocol (BRSNAP)

The Lua widget writes tagged lines to its output file; `internal/capture` parses that
file after the run. Evolve the widget and `capture` together.

**Why a file, not `Spring.Echo`:** the engine flushes its log on every Echo *and* caps
each Echo at a few hundred units (a real replay hit 617), so streaming snapshots through
stdout was slow and silently truncated. `System` exposes `io` to widgets (BAR's own
`savetable.lua` uses `io.open`), so the widget opens the substituted `__OUTPUT_PATH__`
and writes each whole sampled frame (`F` line + all `U` lines) with one `out:write`,
flushing at each heartbeat and closing in `GameOver`/`Shutdown`. No size cap, one write
per frame. Only the small `[barreplay]` heartbeat lines still go through `Spring.Echo`
(for `infolog.txt` / `-progress`). `capture` still cross-checks each frame's `U` count
against the `F` line's declared `<count>` and warns on a mismatch.

```
BRSNAP D <defID> <name>                        unit-def id -> internal name (preamble)
BRSNAP T <teamID> <allyTeam> <side>            team info (preamble)
BRSNAP READY                                   end of preamble
BRSNAP F <frame> <timeSec> <count>             start of a periodic snapshot
BRSNAP U <id> <def> <team> <x> <y> <z> <hp> <maxHp>   one unit (follows an F line)
BRSNAP EV <frame> <kind> <id> <def> <team>     unit lifecycle event
```

The widget is strictly read-only (`Get*` + `Spring.Echo` only) so it cannot desync the
deterministic replay. `__SAMPLE_EVERY__` is substituted at write time (`-every`, default 30 = 1 Hz).
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
  simulation wall-time, `infolog.txt` size, and the snapshot's size + line count.
- `-progress` (`cmd/barreplay` + `engine.WatchProgress`) polls the tail of
  `<data>/infolog.txt` every 2s, parses the newest `[f=<frame>]` marker, and prints
  frame/total, in-game time, %, processing fps, speed-up (fps/30), and ETA. Total game
  length comes from the demo header `GameTime`; the engine sims at 30 frames/game-second.
- Development happens on branch `claude/bar-replay-snapshots-g8jmfj`; `main` is the base.
