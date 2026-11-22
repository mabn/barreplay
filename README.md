# barreplay

**Live site: <https://replay.fogofwar.dev>.** Browse and play back Beyond All
Reason games, and read a summary of each one. To add games yourself, download
the [FogOfWar app](https://replay.fogofwar.dev/setup).

barreplay recovers **unit positions** from Beyond All Reason (BAR) games and
plays them back in the browser: a top-down map with every unit, its health,
what it is building, projectiles, shields, the chat and the map drawings,
scrubbable at any speed. Beside the playback, a game summary tells the story
of the game: who was winning when, the battles, the swings, awards.

A BAR replay (`.sdfz`) does not contain positions. It stores only the players'
inputs, and the deterministic Recoil (Spring) engine recomputes everything
else. So barreplay **re-simulates** the replay in a headless engine, with a
read-only Lua widget writing down the game state once a second. The result is
a `.brp` file, a compact delta-coded binary the viewer streams
keyframes-first.

## How it works

![barreplay architecture](docs/architecture.svg)

**Games come from BAR.** Every minute the worker's cron reads BAR's public
game list (`api.bar-rts.com`) and records the games that just finished in its
games mirror. It also scrapes the Teiserver lobby pages, so a mirrored game
gets its lobby name and the players' parties, and it hands lava games to
[lavabalance](https://lavabalance.fogofwar.dev), a sibling site that keeps
OpenSkill ratings for that mode.

**Re-simulation turns a game into a `.brp`.** Three things can run one:

- **`bringest -resim`**, a daemon on a Linux machine with the engine. It asks
  the worker for work: games an admin queued, games a visitor asked for from
  a "not simulated yet" page, games that only have a one-sided upload, and,
  when nothing is queued, recent games out of the mirror (lava 8v8 games
  first, then modded and bigger games).
- **FogOfWar.exe**, a Windows app a player runs on their own PC. It re-simulates
  a game they paste, or recent unpublished games on its own, and uploads the
  `.brp`. Its runs show up in the queue as "app" jobs.
- **`barreplay`**, the command-line tool: one replay link in, one `.brp` out.

Each run downloads the demo, provisions the exact engine and game build the
replay pins, injects [the widget](assets/lua/replay_uploader.lua) in its
re-sim mode, runs the demo at full speed and packs the widget's
`.brepstream` into a `.brp`. Where one is published, it runs a patched build
of the engine that is several times faster and produces the same bytes (see
[Engine patches](#engine-patches)).

**Publishing.** `bringest -resim` writes the `.brp` straight to the R2 bucket
under `replays/<YYYY-MM>/<gameId>.brp` and registers it in the catalog with
`PUT /api/replays/<gameId>`. Uploads, from FogOfWar.exe or dropped on the
landing page, go to `POST /api/upload`; the worker archives them and queues a
job, and plain `bringest`, running on any machine without an engine, packs
or checks them and publishes them the same way. Nothing in the bucket is ever
overwritten: a second capture of a game becomes another revision.

**Game summaries.** `internal/insights` reduces a `.brp` to a summary file
published beside it (`<gameId>.insights10.json`): army value and income per
side, battles, the win-probability line and its swings, eliminations, awards,
a report per player. A summary is computed at publish time. When the viewer
finds it missing or outdated, it asks the worker, whose SummaryHub Durable
Object hands the request over a WebSocket to a plain `bringest`, which computes
and publishes it while the reader waits.

**The viewer** has no playback server. The browser reads the `.brp` with HTTP
Range requests from `cdn-bar.fogofwar.dev`, the bucket on its own hostname,
cached at Cloudflare's edge: first a small head with the meta, events and
chat, then all keyframes as one stream (the whole timeline is scrubbable in
seconds), then the delta chunks around the playhead. The worker serves the
page, the catalog (`/api/replays`), the games list, the job queue, and a
caching proxy to BAR's map API. The summary page is a separate library that
lavabalance imports at run time from `/embed/summary.js`.

## Repository layout

The Go side is stdlib-only, except `cmd/fogofwar`, which is its own module.
The worker is Hono + Vite on Cloudflare Workers, with two Durable Objects and
an R2 bucket. `CLAUDE.md` is the exhaustive reference; this table is the map.

| Path | What it is |
| --- | --- |
| `cmd/barreplay` | CLI: one replay link in, one `.brp` out. Downloads, provisions, injects the widget, runs the engine. |
| `cmd/bringest` | The ingest daemon. Publishes uploads and computes on-demand summaries; with `-resim`, re-simulates queued games. |
| `cmd/fogofwar` | FogOfWar.exe, the Windows desktop app (Wails). Released by `.github/workflows/fogofwar.yml`; see `docs/fogofwar-release.md`. |
| `cmd/pack` | Convert a `.brepstream` to `.brp`, print a size breakdown, publish to R2 and the catalog. |
| `cmd/insights` | Compute and publish game summaries for published replays (one, or the whole catalog). |
| `cmd/winfit` | Fit the win-probability models from summary files. |
| `cmd/publish-engine` | Gate a patched engine build (byte-identical output), upload it to R2 and print the hash to pin. |
| `cmd/upload-maps` | Upload BAR's high-resolution map images to the bucket. |
| `cmd/barreplay-static` | Write `.brp` files as a static-hosting bundle. |
| `snapshot/` | The data model and the `.brp` codec. Nothing else knows the on-disk format. |
| `internal/capture` | Parse the widget's `.brepstream`. |
| `internal/demofile` | Parse the `.sdfz`: header, startscript, chat, map drawings, self-destruct orders, winners. |
| `internal/engine` | Locate or download the engine and the patched build, provision content with `pr-downloader`, launch and watch the engine, memory guard, ETA. |
| `internal/resim` | The re-simulation pipeline as one call, with live progress. |
| `internal/packer` | Pack, upload (native SigV4 to R2), register in the catalog. |
| `internal/combat` | Derive kills, damage and big blasts from the raw hits a re-sim records. |
| `internal/insights`, `internal/insightsrun` | The game summary and the win models; the runner shared by `cmd/insights` and `bringest`. |
| `internal/gamecat` | Sort games into lava, ranked and unranked. |
| `internal/barapi` | BAR's replay API and demo download. |
| `internal/viz` | The published bundle, the catalog row, BAR's unit icon table. |
| `assets/lua` | The widget. Injected by the Go tool, it is the re-sim sampler; published as is, it records a live game for the player who runs it. |
| `worker/` | The Cloudflare Worker: the viewer (`worker/public`), the summary library (`worker/src/summary`), the catalog, job queue, games mirror, cron. See [`worker/README.md`](worker/README.md). |
| `patches/` | Engine patches for faster, leaner headless re-simulation. |
| `experiments/` | One-off studies (win-model variants, building worth, unit mix) kept with their code. |
| `tools/` | The widget test harness and the late-game benchmark. |
| `docs/` | Format specs, the engine build recipe, the engine speed work. |

Why a widget and not an engine change: widgets run in the unsynced Lua state,
read game state through `Spring.Get*`, and cannot desync the replay. The
sampler writes its stream to a file inside the engine's write-dir rather than
through `Spring.Echo`, which flushes the log on every call and truncates long
lines. Getting BAR to load a user widget in a replay is non-obvious; see
"Making BAR actually load the widget" in `CLAUDE.md`.

## Replay file format

Two formats. Only the second is ever served.

**`.brepstream`** is what the widget writes: a binary keyframe-plus-delta
stream, spec in [`docs/brepstream-format.md`](docs/brepstream-format.md). It
carries the unit defs in full, team and player preambles, per-unit position,
velocity, health, build progress and build target, per-team economy,
lifecycle events, chat and map drawings, and the game's facts (who won,
eliminations). A re-simulation adds the killer of every unit, every damage
event, where each unit's life ended, which side could see each unit,
long-range projectile tracks, big explosions and shield charge.

**`.brp`** (version 6) is the packed capture, owned by `snapshot/brp.go` and
specified byte for byte in [`docs/brp-format.md`](docs/brp-format.md), with the
measured design evaluation in [`docs/brp-optimizations.md`](docs/brp-optimizations.md).
It is a container of tagged sections:

| Section | Contents |
| --- | --- |
| `M` | meta JSON: game, players, unit defs, the chunk index and where every other section sits |
| `E`, `C` | events and comms (chat and map drawings), right behind the meta so one read gets all three |
| `K` | every keyframe, one gzip stream |
| `F` | delta-frame chunks, 64 samples each |
| `X` | team resources |
| `G`, `H`, `U`, `V` | re-sim analysis: facts, hits, unit ends, visibility |
| `R`, `W`, `Q` | projectile tracks, blasts, shield charge |

The predictor resets at every chunk boundary, the video-codec model. A delta
frame stores only a dead-id list and the units whose columns differ from
prediction; positions predict from the previous velocity, so a unit moving at
constant speed costs zero bytes, and about two thirds of all unit records do.
Changed columns are zigzag-varint deltas against the unit's previous sample.
Elevation is not stored. A real 33-minute 8v8 is about 8 MB, where the
original JSONL format was 476 MB. The writer is deterministic: the same
capture always produces the same bytes, which is what the engine-patch gate
relies on.

**On the wire** the `.brp` is served as is. The browser Range-reads it and
derives unit names, footprints and army costs from the meta's unit-def table;
the icon table ships with the viewer, since it is fixed per BAR version.
Nothing is re-encoded server-side. The codecs stay in lockstep: the Go encoder
and decoder in `snapshot/` and the JavaScript decoders in
`worker/public/app.js`, pinned by a shared test fixture. Replays published
before the single-file layout (a `.brw` head, `.resources`, split chunk files)
still play.

## Engine patches

A headless re-simulation of a big game used to take most of an hour and
several gigabytes of memory, and every improvement has to leave the produced
`.brp` byte-identical to the stock engine's. `patches/engine-<version>/`
holds the series that apply onto that tag of
[RecoilEngine](https://github.com/beyond-all-reason/RecoilEngine); the build
recipe is [`docs/building-recoil.md`](docs/building-recoil.md).

For engine 2026.07.04, on a 16-player, 50-minute game (re-simulated whole):

| Build | Re-sim time | Record |
| --- | --- | --- |
| stock | 38m17s | [`docs/engine-speed-plan.md`](docs/engine-speed-plan.md) |
| patched, revision 5 (the speed work, PGO + LTO) | about 10 minutes | same; day by day in [`docs/worklog-engine-speed.md`](docs/worklog-engine-speed.md) |

Memory is a separate axis ([`MEMORY.md`](patches/engine-2026.07.04/MEMORY.md)):
lazy zeroing of the static memory pools and the on-demand bitmap allocator
cut a 16-player game's peak from 5.4 GB to 3.9 GB.

The biggest wins:

- **Unpaced demo playback.** The local game server paces packet release to
  hold client CPU at a fixed target, so the sim idled and the main loop spun
  draw passes. Releasing packets as fast as the client consumes them changes
  timing only, never content.
- **Lazy zeroing of the static memory pools.** Recoil `memset`s 1.05 GiB of
  already-zeroed `.bss` before `main`; zeroing only the pages handed out
  keeps the pool's invariant and saves about 1.1 GB resident.
- **An engine event log** that lets the widget read explosions and hits
  directly, which BAR's widget sandbox otherwise hides.
- **The late-game speed work**: the cost of a 10,000-unit late game is
  mostly aircraft movement and weapon targeting, attacked patch by patch
  under switches and measured on CRIU checkpoints of that late state
  (`tools/bench-ckpt`).

A gated build is uploaded by `publish-engine` under a semver such as
`2026.7.4-barreplay.5` and pinned by SHA-256 in
`internal/engine/patcheddl.go` (Linux) and the Windows table beside it.
`bringest -resim` and FogOfWar.exe download the pinned build and fall back to
the stock engine for versions nobody has patched. The capture cannot tell
which build made it.

## Build and run

```sh
go build ./cmd/...
go test ./...
go vet ./... && gofmt -l .
(cd worker && npm test)
```

Capture one replay (needs the engine, see below):

```sh
./barreplay -data <BARdata> -out ./snaps https://www.beyondallreason.info/replays?gameId=<id>
```

View captures locally (the worker's dev server over a simulated bucket):

```sh
cd worker && npm run dev                # http://127.0.0.1:5173
./pack -upload local ./snaps/<gameId>.brp
```

Publish a capture, or only look at its size breakdown:

```sh
./pack ./caps/<gameId>.brepstream       # packs, fetches demo metadata, uploads, registers
./pack -upload= ./caps/<gameId>.brp     # size breakdown only, publishes nothing
```

Run the daemons (they read `./.env` for `REPLAY_PUT_TOKEN` and the R2 keys):

```sh
./bringest                              # publish uploads, compute summaries on demand
./bringest -resim -data <BARdata>       # re-simulate queued games
```

Build FogOfWar.exe (its own module):

```sh
cd cmd/fogofwar && GOOS=windows go build -tags desktop,production -ldflags "-H windowsgui" -o FogOfWar.exe .
```

The worker deploys with `npm run deploy` from `worker/`, which runs the tests,
builds, smoke-tests the built worker, and deploys. `worker/README.md` has the
runbook, including the R2 CORS policy, the cache rule for the data hostname,
and the Cloudflare Access setup for the admin routes.

### Requirements for a real run

The engine is the constraint, not this tool.

- The engine **matching the replay's engine version exactly**. A mismatch
  desyncs silently, so `barreplay` refuses one. It downloads the release into
  `<BARdata>/engine/<version>/` when missing, which needs `7z` on the path.
- The game build and map the replay pins. `pr-downloader` fetches them from
  BAR's rapid repo, resolving the demo's game name to its exact
  `byar:git:<sha>` tag. Provisioning is idempotent and best-effort.
- Memory. A big 8v8 wants 4 to 8 GB resident. A memory guard stops the engine
  before the host runs out, which matters because a global OOM kill can take
  the whole systemd scope with it; the job then fails as "out of memory" and
  the daemon moves on. See "Running out of memory" in `CLAUDE.md`.
- No GPU. The headless engine runs on a plain cloud VM.

One engine run per data dir: runs share widget config and the infolog, so
`barreplay` takes an advisory lock and a second concurrent run must use a
separate `-data`.

## Documentation

- [`docs/brp-format.md`](docs/brp-format.md), [`docs/brepstream-format.md`](docs/brepstream-format.md): byte-level specs.
- [`docs/brp-optimizations.md`](docs/brp-optimizations.md): the measured evaluation behind the codec.
- [`docs/projectiles-and-explosions.md`](docs/projectiles-and-explosions.md): how projectiles and blasts are recorded.
- [`docs/building-recoil.md`](docs/building-recoil.md): building the engine, stock and patched, Linux and Windows.
- [`docs/engine-speed-plan.md`](docs/engine-speed-plan.md): the engine speed work and its result.
- [`docs/fogofwar-release.md`](docs/fogofwar-release.md): releasing FogOfWar.exe.
- [`worker/README.md`](worker/README.md): deploying and operating the site.
- `CLAUDE.md`: the full design record, with the reasoning behind every non-obvious decision.

## Licence

The repository is MIT ([`LICENSE`](LICENSE)). `patches/` is GPL-2.0-or-later,
since it derives from Recoil. BAR's files under `internal/viz/bardata/` keep
their own licences. [`LICENCE_NOTICE`](LICENCE_NOTICE) says which is which.
