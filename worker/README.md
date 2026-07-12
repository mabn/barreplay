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

## Layout

```
worker/
  wrangler.jsonc          Worker config (name, main, account_id, assets + R2 binding)
  vite.config.ts          Vite + @cloudflare/vite-plugin
  index.html              viewer page (Vite entry)
  public/app.js           viewer logic (copied from internal/viz/web, URLs point at R2)
  public/style.css
  public/icons, ranks/    synced from internal/viz/bardata by tools/sync-assets.mjs (gitignored)
  src/worker/index.ts     Hono app: serve R2 (index.json, replays/**) + SPA fallback
  tools/sync-assets.mjs   copies the vendored icons into public/ before dev/build
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

The default is **real R2** (`wrangler r2 object put --remote`). The bucket must exist first —
`npx wrangler r2 bucket create barreplay-replays` — and you must be logged in
(`npx wrangler login`) to the account in `wrangler.jsonc` (`account_id`).

Because the listing is built live, you upload **one replay at a time** —
`npm run upload -- ../static <gameId>` pushes just that replay's `.brw`, `.resources`, and
chunk files, and it shows up in the picker immediately. For a bulk import, `rclone`/`aws s3
sync ./static/replays -> bucket/replays` against R2's S3 API works too (needs an R2 API
token).

For a fresh capture there is a one-step shortcut: `cmd/pack` converts the raw stream
AND uploads in the same run (it shells out to the same `npx wrangler r2 object put`,
so the auth requirements are identical):

```sh
# from the repo root:
go run ./cmd/pack -upload r2 ./caps/<gameId>.brepstream      # convert + push to real R2
go run ./cmd/pack -upload local ./caps/<gameId>.brepstream   # ...or seed the local dev simulator
```

## Uploading raw .brepstream captures (the breps pipeline)

`src/breps/split.ts` slices a raw widget `.brepstream` into servable pieces **in
TypeScript, without transcoding** — the stream's length-framed records and flagged
keyframes let it produce the same keys-first shape as a `.brp` bundle by byte
slicing: `replays/<id>.keys` (every keyframe record, one gzip stream),
`replays/<id>/c<n>` (each chunk's delta records) and `replays/<id>.brw` (a BRW1
head with **version byte 5**, one gzipped-JSON section: meta, teams, players, unit
defs, events, bounds, chunk index). This is the exact pipeline a future in-worker
upload API will run on POSTed streams; today it runs locally:

```sh
npm run upload-brep -- /path/to/<gameId>.brepstream           # split + push to real R2
npm run upload-brep -- /path/to/<gameId>.brepstream --local   # ...or the local dev simulator
npm run upload-brep -- /path/to/<gameId>.brepstream --out ./x # just write the pieces (debug)
go run ./cmd/pack -upload r2 <gameId>.brepstream              # what pack does for .brepstream inputs
```

The head is uploaded last (it is the object the live listing keys on), so a
half-finished upload never appears in the picker. **The viewer cannot play these
yet** — it decodes only the version-4 `.brp` wire, so a breps replay lists but
fails with "unsupported payload version 5" until the front-end's breps decoder
lands. `npm test` pins the splitter against the same harness fixture that pins
the Lua encoder <-> Go decoder lockstep.

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
