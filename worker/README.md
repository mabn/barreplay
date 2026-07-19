# barreplay worker

A Cloudflare Worker that hosts the barreplay viewer as **static files, with no server
on the playback path**. Built with [Hono](https://hono.dev) and
[Vite](https://vite.dev) (via
[`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/)).
No front-end framework — the viewer is the same plain Canvas/vanilla-JS app as
`cmd/barreplay-viz`.

## How it works

The `.brp` format was designed so serving is a byte copy, not a re-encode: the
head is a pure function of the file's meta, the keyframes section and each frame
chunk are independently-gzipped byte ranges. The Go viz server and this Worker
share ONE URL scheme, so the same `worker/public` front-end works against both.
The files are precomputed **offline** by `cmd/barreplay-static` and served
straight from an **R2 bucket**:

| URL | Static object (in R2) |
| --- | --- |
| `GET /index.json` | built live by the Worker from the bucket (no stored file) |
| `GET /replays/<id>.brw` | `replays/<id>.brw` (head: meta, teams, icons, chunk index) |
| `GET /replays/<id>.keys` | `replays/<id>.keys` (every keyframe, one gzip stream — streamed first, makes the whole timeline scrubbable) |
| `GET /replays/<id>/c<n>` | `replays/<id>/c<n>` (chunk n's delta frames; absent for single-frame chunks) |
| `GET /replays/<id>.resources` | `replays/<id>.resources` |

The Worker (`src/worker/index.ts`) is a thin Hono app that streams these out of R2 —
no frame is ever decoded server-side. The replay listing (`/index.json`) is
built **live** from the bucket (it lists the `replays/` prefix), so there is no listing file
to maintain: uploading one replay's handful of files makes it appear, and deleting them
removes it. The SPA and the vendored unit/rank
icons (`/icons/*`, `/ranks/*`) are fixed static assets bundled with the deploy. Map terrain
is fetched **browser-side directly** from `api.bar-rts.com` (degrades gracefully if
unreachable), so there is no map proxy.

## The replay catalog (Durable Object + SQLite)

The landing page (no `?replay=` in the URL) is a **replay list with per-game stats** —
when the game started, how long it ran, which map, the team-size spec ("8v8"), and the
download size — ordered most recent game first. Those stats live inside each `.brp`'s
meta record, which a bucket listing can't see, so they are kept in a small SQLite table
inside a **Durable Object** (`src/worker/replayindex.ts`, single instance, migration
`v1: new_sqlite_classes`):

| URL | What |
| --- | --- |
| `GET /api/replays` | the catalog, newest game first (rows with no start time last) — `[{id, rid, startUnix, durationSec, map, gameSize, sizeBytes, settings}]`, nulls for unknown stats |
| `PUT /api/replays/<id>` | upsert one row (same JSON shape, minus `id`); called by `pack -upload` / the ingest daemon after a replay's files land in the bucket |

`rid` is the **revision** the replay's pieces are actually served under:
publishes are append-only — `pack -upload` (and the ingest daemon) put the
pieces at `replays/<gameId>-<rev>…` where `rev` is the first 8 hex of the
source stream's SHA-256, and the catalog row (still keyed by the bare gameId)
points at the current revision. No served object is ever overwritten or
deleted, which is what makes the `/replays/*` `immutable` cache-control sound:
a re-upload lands under a fresh rid and the row moves, superseded revisions
stay servable (old shared links keep playing) but are hidden from the landing
list. `rid: null` means a pre-revisioning upload living under the bare id.

`settings` is a flat object of notable game-settings flags rendered as badges in the
list — keys like `ranked`, `lava` (water-is-lava), `mods` (any tweakdefs*/tweakunits*
set), `scavUnits`, `extraUnits`, `noAir`/`noNukes`/`noLrpc`/`noEndgameLrpc`, and the
enum-valued `quickStart`/`comBuilders` — with boolean or short string values; only
present flags are sent (a vanilla ranked game is `{"ranked": true}`). `pack` distills
them from the demo startscript's `[modoptions]` (`viz.SettingsFlags` in Go — modoptions
are NOT stored in the `.brp`, so this rides only the PUT); `pack -no-demo` uploads have
`settings: null` and just show an empty cell.

Writes can be guarded with a shared secret: `npx wrangler secret put REPLAY_PUT_TOKEN`
makes the PUT require `Authorization: Bearer <token>`; `pack` sends the same-named env
var. Without the secret (local dev) the endpoint is open.

The front-end merges `GET /api/replays` with `/index.json`, so a replay whose files are
in the bucket but was never registered still appears (with only its byte size). To
(re-)register one replay by hand:

```sh
curl -X PUT https://<worker-host>/api/replays/<gameId> \
  -H "authorization: Bearer $REPLAY_PUT_TOKEN" -H "content-type: application/json" \
  -d '{"startUnix":1752000000,"durationSec":1987,"map":"Isidis crack 1.1","gameSize":"8v8","sizeBytes":8400000,"settings":{"ranked":true,"lava":true}}'
```

The Go viz server (`cmd/barreplay-viz`) serves the same `GET /api/replays` shape
computed live from its `.brp` files (`internal/viz/catalog.go`), so the shared front-end
works against both backends; the row shape must stay in lockstep with
`src/worker/replayentry.ts`.

## Layout

```
worker/
  wrangler.jsonc          Worker config (name, main, account_id, assets + R2 + DO bindings)
  vite.config.ts          Vite + @cloudflare/vite-plugin
  index.html              viewer page (Vite entry)
  public/app.js           viewer logic (copied from internal/viz/web, URLs point at R2)
  public/style.css
  public/icons, ranks/    synced from internal/viz/bardata by tools/sync-assets.mjs (gitignored)
  src/worker/index.ts     wrangler entry: re-exports the app + the Durable Object class
  src/worker/app.ts       Hono app: serve R2 (index.json, replays/**), /api/replays,
                          /api/upload + jobs, SPA fallback (no workerd imports — node-testable)
  src/worker/replayindex.ts  the catalog + ingest-jobs Durable Object (SQLite)
  src/worker/replayentry.ts  catalog row shape + PUT body validation (node-testable, no workerd)
  src/worker/preamble.ts  minimal .brepstream preamble scan for /api/upload (gameId, ally team)
  tools/sync-assets.mjs   copies the vendored icons into public/ before dev/build
  tools/r2put.ts          shared upload backend: parallel S3 PUTs (with R2 creds) or parallel wrangler
  tools/upload.ts         upload a barreplay-static bundle (npm run upload)
```

## Producing and uploading replay data

```sh
# 0. create the buckets once (prod + the preview one `wrangler dev` binds)
npx wrangler r2 bucket create barreplay-replays
npx wrangler r2 bucket create barreplay-replays-preview

# 1. from the repo root: build the packer and pack captures into a bucket mirror
go build ./cmd/barreplay-static
./barreplay-static -out ./static ./snapshots/*.brp     # writes index.json + replays/**

# 2. upload to real R2 (walks only replays/**; no index.json — the listing is dynamic)
cd worker
npm run upload -- ../static <id>         # ONE replay to real R2 (the common case)
npm run upload -- ../static              # every replay in the dir, to real R2
npm run upload -- ../static <id> --local # into the local dev simulator (for `npm run dev`)
```

The default is **real R2**. The bucket must exist first — `npx wrangler r2 bucket create
barreplay-replays` — and you need either R2 API credentials (fast path, below) or a
wrangler login (`npx wrangler login`) to the account in `wrangler.jsonc` (`account_id`).

### Upload speed: the S3 fast path

Go publishers (`pack -upload r2`, the ingest daemon) upload **natively** when
`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` are set: a minimal SigV4 signer in
`internal/packer/r2.go` (pinned against aws4fetch's signatures) PUTs 16
objects in flight against `https://<account>.r2.cloudflarestorage.com` — no
node process involved. `-upload local` PUTs each piece through the running
dev worker's bearer-guarded `PUT /replays/*` route instead (the dev server
binds the simulator's bucket; a whole replay lands in milliseconds, vs ~1s of
node+wrangler startup **per object** through `wrangler r2 object put`). Only
the fallbacks — r2 without credentials, or local with the dev server not
running — shell into the TS tooling below.

The TS upload tools go through `tools/r2put.ts`, which picks a transport:

- **S3 API (fast).** Set `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` (create a token
  under Cloudflare dash → R2 → *Manage R2 API Tokens*, "Object Read & Write" on the
  bucket) and objects are PUT straight against
  `https://<account_id>.r2.cloudflarestorage.com` with [`aws4fetch`](https://github.com/mhart/aws4fetch)
  signing, 16 in flight in one process — a whole replay in a couple of seconds. The
  account id comes from `wrangler.jsonc` (`CLOUDFLARE_ACCOUNT_ID` overrides).
- **wrangler (fallback, and always for `--local`).** One `wrangler r2 object put` per
  object, 8 in flight (the local simulator stays serial — concurrent processes against
  the same miniflare state flake with 500s). Each spawn pays ~2 s of node+wrangler
  startup, which is why the old serial upload was slow; parallelism hides most of it,
  credentials stay wrangler's.

Either way each replay's `.brw` head is uploaded **after all its other objects** (a
completion barrier, not just ordering): the head is what the live listing keys on, so a
half-uploaded replay never appears in the picker.

Because the listing is built live, you upload **one replay at a time** —
`npm run upload -- ../static <gameId>` pushes just that replay's `.brw`, `.resources`, and
chunk files, and it shows up in the picker immediately. For a bulk import, `rclone`/`aws s3
sync ./static/replays -> bucket/replays` against R2's S3 API works too (same R2 API
token).

For a fresh capture there is a one-step shortcut: `cmd/pack` converts the raw stream
AND uploads in the same run (it shells into these same tools, so the auth options are
identical — export the R2 credentials to get the fast path). It also registers the
replay in the catalog (PUT /api/replays/<id>, see above) so it appears in the landing
list with its stats — point it at the deployed worker with `-index-url` or
`BARREPLAY_INDEX_URL` (for `-upload local` it defaults to the vite dev server):

```sh
# from the repo root:
BARREPLAY_INDEX_URL=https://<worker-host> \
go run ./cmd/pack -upload r2 ./caps/<gameId>.brepstream      # convert + push to real R2
go run ./cmd/pack -upload local ./caps/<gameId>.brepstream   # ...or seed the local dev simulator
```

Note on local buckets: both dev servers (`npm run dev` and `npx wrangler dev`) bind the
**preview** bucket, so seeding the simulator needs `--local --preview` with the upload
tool (`pack -upload local` passes both automatically).

## Drag & drop uploads (the ingest pipeline)

The landing page accepts a dropped `.brepstream` (the Replay uploader widget's
capture). The viewer serves exactly one wire format — the version-4 `.brp`
pieces — and the Worker deploys no Go and no transcoder, so the intake is split
between the Worker (cheap validation + storage) and a **Go daemon** running
wherever the repo lives (`cmd/barreplay-ingest`, e.g. a VM):

| URL | What |
| --- | --- |
| `POST /api/upload` | open; validates the stream's preamble (`src/worker/preamble.ts`), archives the raw bytes at `streams/<gameId>/<ts>-a<ally>.brepstream` (append-only, never listed, never served publicly), inserts a pending job, returns `{job, gameId, streamKey}` |
| `GET /api/jobs/<id>` | open; the job's state for the uploading browser's poll (`pending → processing → done \| error`) |
| `GET /api/jobs` | bearer-guarded; the daemon's work queue (pending + stalled-processing jobs, oldest first) |
| `POST /api/jobs/<id>` | bearer-guarded; daemon transitions (`processing`, `done`, `error` + message) |
| `GET /api/streams/<gameId>/<file>` | bearer-guarded; the daemon downloads the archived stream (it speaks only HTTPS to the Worker — no S3 reads, no inbound connectivity) |

The daemon polls, claims a job, downloads the stream, and publishes it through
the same `internal/packer` pipeline as `pack -upload`: demo fetch from the BAR
API for the rich metadata (falling back to the stream's own GAME preamble when
the API doesn't know the game), `.brp` conversion, revisioned static-bundle
upload, catalog PUT, then reports `done`. With the R2 credentials exported
(the intended deployment) the upload is **native Go** — concurrent SigV4 PUTs
straight against the bucket's S3 endpoint, so the host needs no node at all;
without them it falls back to shelling these tools via npx. The browser's
dropzone follows along and opens the replay when it lands. Uploads are
accepted while the daemon is down — jobs wait as `pending`, and a
`processing` job whose daemon died is re-offered after 15 minutes.

```sh
# on the VM / wherever the repo + worker/node_modules live:
export BARREPLAY_INDEX_URL=https://<worker-host>
export REPLAY_PUT_TOKEN=...                # if the worker guards writes
export R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...   # S3 fast path for the puts
go run ./cmd/barreplay-ingest              # poll every 10s, forever
go run ./cmd/barreplay-ingest -once        # drain the backlog and exit
go run ./cmd/barreplay-ingest -upload local -index-url http://127.0.0.1:5173  # against `npm run dev`
```

The raw archives under `streams/` accumulate on purpose (nothing in the bucket
is ever deleted): they are the substrate for the planned multi-player merge
(docs/widget-remote-upload.md), keyed by gameId with the recorder's ally team
(`-a<n>`, `-spec` for spectators) in the name.

## Commands

```sh
npm install
npm run dev         # vite dev — runs the Worker in workerd + HMR (needs a local R2, see below)
npm run build       # sync icons, build client bundle + Worker into dist/
npm run preview     # preview the production build
npm run typecheck   # tsc --noEmit
npm run cf-typegen  # regenerate worker-configuration.d.ts from wrangler.jsonc
npm run deploy      # build, then wrangler deploy (needs Cloudflare auth)
```

For local dev, seed the local R2 with a packed bundle (`wrangler dev` binds the
`preview_bucket_name`):

```sh
npm run upload -- ../static --local
```

## Alternative: public R2 domain

Instead of the Worker proxying R2, you can expose the bucket on a public R2 custom domain
and point the viewer's fetch base at it — then the Worker only serves the SPA. The
pass-through route is used here so the project is self-contained and testable.
