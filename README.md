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
| `-no-run` | Download + parse only; don't launch the engine (useful for inspecting metadata). |

### Examples

Inspect a replay's metadata without running anything:

```sh
barreplay -no-run https://www.beyondallreason.info/replays?gameId=836d486a5480a9e830be54db7d2c7be9
# demo: gameId=836d486a... engine=2025.06.24 map="Isidis crack 1.1" game="Beyond All Reason test-30541-..." gameTime=720s
```

Full capture (requires a BAR install / engine — see below):

```sh
barreplay -data ~/.local/share/Beyond-All-Reason/data -out ./snaps \
    https://www.beyondallreason.info/replays?gameId=836d486a5480a9e830be54db7d2c7be9
# → ./snaps/836d486a...jsonl
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
  `<data>/games` and `<data>/maps`. If a `pr-downloader` binary is found beside the
  engine and `-no-provision` is not set, `barreplay` fetches missing content; use
  `-game`/`-map` to override the identifiers if the automatic mapping misses.

### Manual end-to-end verification

On a machine with BAR installed:

```sh
go build ./cmd/barreplay
./barreplay -data <BAR data dir> -out ./snaps \
    https://www.beyondallreason.info/replays?gameId=836d486a5480a9e830be54db7d2c7be9
```

Expect: the `.sdfz` downloaded into `<data>/demos`, a fast headless run (min/max
speed forced to 9999 in the startscript and `setmaxspeed` from the widget), and
`./snaps/<gameId>.jsonl` containing a `meta` line followed by ~`gameTime` frame
blocks. Spot-check that unit counts rise and fall plausibly and that positions fall
within the map bounds.

## Notes & known rough edges

- The widget forces `spectatorfullview 1` so `Spring.GetAllUnits()` returns every
  unit regardless of line-of-sight. It is strictly read-only (only `Get*` +
  `Spring.Echo`), so it cannot desync the replay.
- Headless widget **auto-enable** and the exact `pr-downloader` **rapid-tag mapping**
  from a `gameVersion` string are the two most install-specific pieces; `-engine`,
  `-no-provision`, `-game`, and `-map` exist as escape hatches.
- The transport from Lua to Go is tagged stdout lines (`BRSNAP ...`). `internal/capture`
  isolates this so a TCP-socket transport can be added later without touching the
  `snapshot` format.
```
