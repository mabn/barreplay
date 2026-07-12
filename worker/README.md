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
  src/breps/split.ts      TS .brepstream splitter (raw stream -> static pieces, no transcode)
  tools/sync-assets.mjs   copies the vendored icons into public/ before dev/build
  tools/r2put.ts          shared upload backend: parallel S3 PUTs (with R2 creds) or parallel wrangler
  tools/upload.ts         upload a barreplay-static bundle (npm run upload)
  tools/upload-brepstream.ts  split + upload a raw .brepstream (npm run upload-brep)
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

Both upload tools go through `tools/r2put.ts`, which picks a transport:

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
identical — export the R2 credentials to get the fast path):

```sh
# from the repo root:
go run ./cmd/pack -upload r2 ./caps/<gameId>.brepstream      # convert + push to real R2
go run ./cmd/pack -upload local ./caps/<gameId>.brepstream   # ...or seed the local dev simulator
```

## The .brepstream splitter (parked — the viewer serves .brp wire only)

**Design decision:** the viewer downloads exactly one wire format, the version-4
`.brp` pieces — the most compact encoding of the playback path. Raw `.brepstream`
records are ~1.4×+ larger served (fixed-width absolute columns vs the `.brp`
codec's varint deltas), so **nothing uploads brepstream-encoded chunks for
playback**; a raw stream is always converted to `.brp` first (locally that's
`pack -upload`, which does it in Go).

`src/breps/split.ts` remains as the TypeScript half of that future story: it
parses the stream's preamble and record framing (pinned by `npm test` against the
same harness fixture as the Lua↔Go lockstep) and can slice a stream into
version-5 pieces without transcoding. That parsing is the foundation for the
planned **TS transcoder** (`brepstream → .brp-wire pieces`) that an in-worker
upload API (drag & drop, widget streaming) will need, since the Worker deploys no
Go. `npm run upload-brep` (with `--out` for inspection) still exercises it, but
its version-5 output is deliberately rejected by the viewer — treat it as an
experiment harness, not an upload path.

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
