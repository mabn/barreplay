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
`engine.Locate` → `engine.EnsureContent` (pr-downloader) → `engine.WriteWidget` →
`engine.BuildStartscript` → `engine.Run` (stdout) → `capture.Consume` →
`snapshot.NewJSONLWriter`.

### Widget wire protocol (BRSNAP)

The Lua widget echoes tagged lines to stdout; `internal/capture` parses them. Evolve
the widget and `capture` together.

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

Provisioning is best-effort — a download failure is a warning, not a hard abort
(idempotent; skips content already installed). Behind a proxy you may still need
`PRD_RAPID_USE_STREAMER=false` and `PRD_SSL_CERT_FILE=<ca>` in the environment — the
tool passes them through. The equivalent manual recipe:

```sh
# from inside the extracted engine/data dir:
PRD_RAPID_REPO_MASTER=https://repos.beyondallreason.dev/repos.gz \
PRD_RAPID_USE_STREAMER=false \
PRD_SSL_CERT_FILE=/path/to/ca-bundle.crt \   # only if the system trust store lacks the proxy CA
./pr-downloader --filesystem-writepath . --download-game "byar:git:<commit-sha>"
./pr-downloader --filesystem-writepath . --download-map "Isidis crack 1.1"
```

Pin the exact game with the `byar:git:<sha>` rapid tag (from the demo's `gameVersion`)
rather than the moving `byar:test`. Check the mapping in
`https://repos.beyondallreason.dev/byar/versions.gz` (gzipped rapid index).

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
  Read it back with `snapshot.NewReader`.
- Development happens on branch `claude/bar-replay-snapshots-g8jmfj`; `main` is the base.
