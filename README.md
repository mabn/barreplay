# barreplay

A Go tool that turns a **Beyond All Reason** (BAR) replay link into on-disk
**snapshots** of game state (unit positions, types, teams, health, and lifecycle
events), sampled periodically throughout the match.

It works by **re-simulating** the replay in the Recoil (Spring) engine headlessly.
A BAR replay (`.sdfz`) only stores the deterministic input stream — not unit
positions — so the only way to recover positions is to replay it in the engine and
sample state from inside via a small read-only Lua widget.

> A later phase will add a UI that scrubs back and forth through the captured data.
> That is out of scope here; the `snapshot` package is the seam it will read from.

## Pipeline

```
replay link / gameId / local .sdfz
        │
        ▼  internal/barapi      resolve gameId → metadata, download .sdfz from OVH storage
        ▼  internal/demofile    gunzip + parse header & startscript (engine/game/map/gameId)
        ▼  internal/engine      locate spring-headless, provision content, inject widget, launch
        ▼  assets/lua           snapshot_widget.lua samples units each N frames → BRSNAP stdout lines
        ▼  internal/capture     parse BRSNAP lines → snapshot records
        ▼  snapshot             pluggable Writer persists them (v1: JSONL)
```

### Package layout

| Package | Responsibility |
| --- | --- |
| `snapshot/` | **Public data model + pluggable `Writer`.** Owns the on-disk format so it can be swapped for a binary/columnar layout later without touching anything else. v1 impl is line-delimited JSON. |
| `internal/barapi` | Resolve a gameId/URL via `api.bar-rts.com` and download the `.sdfz` from the OVH bucket. |
| `internal/demofile` | Parse the `.sdfz` header (byte-packed, little-endian) and the embedded TDF startscript. |
| `internal/engine` | Locate `spring-headless`/`pr-downloader`, provision missing content, write the widget, build the playback startscript, launch and stream stdout. |
| `internal/capture` | Parse the widget's `BRSNAP` stdout protocol into `snapshot` records. |
| `assets/lua` | The embedded, read-only Lua widget injected into the engine's write-dir. |

## Build

```sh
go build ./cmd/barreplay
go test ./...
```

## Usage

```
barreplay [flags] <replay-link | gameId | path.sdfz>
```

Key flags:

| Flag | Meaning |
| --- | --- |
| `-data <dir>` | BAR/Spring data directory (`engine/`, `games/`, `maps/`); also the engine `--write-dir`. Required to run the engine. (`$BAR_DATA_DIR` also works.) |
| `-out <dir>` | Output directory for snapshot files (default `./snapshots`). |
| `-every <frames>` | Sampling interval in sim frames (30 = 1 Hz, the default). |
| `-engine <path>` | Path to `spring-headless` (overrides auto-location under `-data/engine/`). |
| `-no-provision` | Assume engine/game/map are already installed; skip `pr-downloader`. |
| `-game` / `-map` | Override the `pr-downloader` game/map identifiers (the rapid-tag mapping is best-effort). |
| `-rapid-repo <url>` | Override the `pr-downloader` rapid master repo (default: BAR's repo). |
| `-progress` | Poll `<data>/infolog.txt` every 2s and print replay progress: current/total frame, in-game time / total, % complete, ETA, and processing speed (sim frames/sec and speed-up vs realtime, e.g. 45 fps = 1.5x). |
| `-no-run` | Download + parse only; don't launch the engine (useful for inspecting metadata). |

### Examples

Inspect a replay's metadata without running anything:

```sh
barreplay -no-run https://www.beyondallreason.info/replays?gameId=836d486a5480a9e830be54db7d2c7be9
# demo: gameId=836d486a... engine=2025.06.24 map="Isidis crack 1.1" game="Beyond All Reason test-30541-..." gameTime=720s
```

Full capture (requires a BAR install / engine — see below); `-progress` streams live
status and the run prints a summary when it finishes:

```sh
barreplay -progress -data ~/.local/share/Beyond-All-Reason/data -out ./snaps \
    https://www.beyondallreason.info/replays?gameId=836d486a5480a9e830be54db7d2c7be9
# progress: frame 2700/5790  •  01:30 / 03:13 game (46.6%)  •  512 sim-fps (17.1x)  •  ETA 00:12
# ...
# done: wrote snaps/836d486a...jsonl
#   engine simulation took 12.847s
#   infolog.txt: 45.20 MB
#   snapshot: 3.10 MB, 256 lines
```

## Output format (v1: JSONL)

One JSON object per line, tagged by `type`:

```json
{"type":"meta","meta":{"gameId":"836d486a...","engineVersion":"2025.06.24","mapName":"Isidis crack 1.1","sampleEvery":30,"unitDefs":{"1":"armcom",...},"teams":[...]}}
{"type":"frame","frame":{"frame":30,"t":1.0,"units":[{"id":100,"def":1,"team":0,"pos":{"x":512,"y":80,"z":1024},"hp":3000,"maxHp":3000}]}}
{"type":"event","event":{"frame":45,"kind":"created","id":101,"def":2,"team":1}}
```

`unitDefs` maps a unit's `def` id to its internal name; the mapping is written once
in `meta` and is stable for the whole game. Read it back with `snapshot.NewReader`.

To change the persisted format, implement `snapshot.Writer` — nothing else changes.

## Requirements for a real run

`barreplay` launches the engine; the host must therefore have:

- **`spring-headless`** matching the replay's engine version (e.g. `2025.06.24`).
  The version **must match** or the deterministic replay desyncs. It is typically at
  `<data>/engine/<version>/spring-headless`. If missing, build the `engine-headless`
  target from the matching RecoilEngine tag, or point `-engine` at a build.
- The **game archive** (the `gameVersion` from the demo) and the **map** under
  `<data>/games` and `<data>/maps`. Unless `-no-provision` is set, `barreplay` runs the
  bundled `pr-downloader` **pointed at BAR's rapid repo** (`repos.beyondallreason.dev`)
  to fetch whatever is missing — no manual `pr-downloader` steps needed. A replay pins
  one exact game build, so `barreplay` resolves the demo's game name to its precise
  `byar:git:<sha>` rapid tag (via BAR's `versions.gz` index, cached under
  `<data>/cache/`) and downloads *that* — using
  the moving `byar:test` tag would install the wrong build and the engine would abort
  with `content_error: Dependent archive … not found`. Provisioning is best-effort (it
  warns and continues if a fetch fails, since content may already be installed). Rapid
  pool downloads use `PRD_RAPID_USE_STREAMER=false` by default (the streamer is faster
  but stalls mid-pool on WSL/behind proxies, leaving a `.sdp.incomplete` the engine
  ignores — so the game would be reported "not found"); set it to `true` to opt back in.
  Use `-game`/`-map`/`-rapid-repo` to override identifiers, and set `PRD_SSL_CERT_FILE=<ca>`
  in the environment if you are behind a proxy (it is passed through to `pr-downloader`).
- **A working GL stack (GPU or full software GL) — see the next section.** Recoil's
  `spring-headless` (through at least engine `2025.06.24`) still initializes GL and
  builds a unit-icon render-to-texture atlas at load; on a GPU-less host it never
  finishes and the game never starts playing, so no snapshots are produced.

## Running on Linux / Windows / WSL

The engine, not this tool, is the constraint. Two facts drive the choice of engine:

1. **Engine version must match the replay** (or the re-sim desyncs), so you generally
   run the exact `spring-headless` the replay was recorded with.
2. **The pre-2026-04-12 `spring-headless` needs real GL.** The headless icon-atlas hang
   (`CreateAtlasTexture … atlasRendered=0` looping forever at frame `-1`) was a Recoil
   bug fixed on 2026-04-12 (*"do not run atlas/iconhandler in headless"*). Builds after
   that skip the atlas and run with **no GPU at all**; builds at/before it need GL.

Pick the row that matches your engine + host:

| Host | Engine | What to run |
| --- | --- | --- |
| **Windows** (native) | any, incl. old | `barreplay.exe` (`GOOS=windows go build ./cmd/barreplay`) against `spring-headless.exe`. Windows has a real GL driver, so the atlas completes — the most reliable route. |
| **Linux / WSL, no GPU** | **post-2026-04-12** | Just run it — `-engine` at that headless build; fully headless, no GPU/Xvfb. Only valid when the replay was recorded on a compatible engine. |
| **Linux / WSL, no GPU** | old (e.g. `2025.06.24`) | Headless will hang. Run the **graphical** binary instead: `-engine <data>/engine/<ver>/spring` under Xvfb + Mesa llvmpipe (`LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe xvfb-run -a …`). Needs `libsdl2-2.0-0` + `libopenal1`; slow. |
| **WSL2 + WSLg + GPU** (Win11) | old | WSLg provides GPU GL (d3d12). Run the **graphical** `-engine <data>/engine/<ver>/spring`; BAR calls WSLg "too slow for the game", so prefer the Windows-native route. |

`-engine` accepts **any** engine binary (headless or graphical) — the tool just execs it
with `--isolation --write-dir <script>`, which both accept — so switching to the
graphical `spring`/`spring.exe` needs no code change, only the flag. See
[`CLAUDE.md`](./CLAUDE.md) for the full GPU/GL caveat and the source-level explanation.

### Manual end-to-end verification

On a machine with BAR installed:

```sh
go build ./cmd/barreplay
./barreplay -data <BAR data dir> -out ./snaps \
    https://www.beyondallreason.info/replays?gameId=836d486a5480a9e830be54db7d2c7be9
```

Expect: the `.sdfz` downloaded into `<data>/demos`, a fast run (the widget forces max
playback speed via `setmin/maxspeed` — add `-progress` to watch the speed-up), and
`./snaps/<gameId>.jsonl` containing a `meta` line followed by ~`gameTime` frame blocks.
On completion the tool reports the engine simulation time, the `infolog.txt` size, and
the snapshot's size and line count. Spot-check that unit counts rise and fall plausibly
and that positions fall within the map bounds.

## Notes & known rough edges

- The widget forces `spectatorfullview 1` so `Spring.GetAllUnits()` returns every
  unit regardless of line-of-sight. It is strictly read-only (only `Get*` +
  `Spring.Echo`), so it cannot desync the replay.
- Dropping the widget into `<data>/LuaUI/Widgets/` with `enabled = true` is **not**
  enough: BAR only auto-runs a user widget already named in its saved order list, and
  a replay forces `allowuserwidgets = true`, which paradoxically skips the
  `enabled`-based auto-enable for fresh user widgets. So `barreplay` seeds
  `<data>/LuaUI/Config/BYAR.lua` to enable the widget, backing up and restoring your
  real widget config around the run. (A gadget would need engine dev-Lua to load from
  the write-dir, so a widget is the right mechanism.) `-engine`, `-no-provision`,
  `-game`, `-map`, and `-rapid-repo` are the escape hatches for install-specific setups.
- The transport from Lua to Go is tagged stdout lines (`BRSNAP ...`). `internal/capture`
  isolates this so a TCP-socket transport can be added later without touching the
  `snapshot` format.
```
