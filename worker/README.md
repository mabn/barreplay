# barreplay worker

A Cloudflare Worker that hosts the barreplay viewer as **static files, with no server
on the playback path**. Built with [Hono](https://hono.dev) and
[Vite](https://vite.dev) (via
[`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/)).
No front-end framework — the viewer is the same plain Canvas/vanilla-JS app as
`cmd/barreplay-viz`.

## How it works

The `.brp` format was designed so serving is a byte copy, not a re-encode: the
`/api/replay` head is a pure function of the file's meta, and each frame chunk is an
independently-gzipped byte range. So the Go server's endpoints are precomputed **offline**
into plain files by `cmd/barreplay-static` and served straight from an **R2 bucket**:

| Go server endpoint | Static object (in R2) |
| --- | --- |
| `GET /api/replays` | `index.json` |
| `GET /api/replay?file=<id>.brp` | `replays/<id>.brw` |
| `GET /api/replay/chunk?file=<id>&i=<n>` | `replays/<id>/c<n>` |
| `GET /api/replay/chunk?...&key=1` (skim) | HTTP `Range: bytes=0-(keyLen-1)` on `c<n>` |
| `GET /api/replay/resources?file=<id>` | `replays/<id>.resources` |

The Worker (`src/worker/index.ts`) is a thin Hono app that streams these out of R2 with
Range support — no frame is ever decoded server-side. The SPA and the vendored unit/rank
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
# from the repo root: build the packer and pack captures into a bucket mirror
go build ./cmd/barreplay-static
./barreplay-static -out ./static ./snapshots/*.brp     # writes index.json + replays/**

# upload the mirror to the R2 bucket (any S3-compatible sync works)
wrangler r2 object put barreplay-replays/index.json --file ./static/index.json
# ...or rclone/aws s3 sync ./static -> the bucket
```

`barreplay-static` rebuilds `index.json` from whatever is in the output dir, so keep a
local mirror of the bucket, pack new captures into it, and sync the whole dir up.

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

For local dev/preview, seed the local R2 with a packed bundle (wrangler dev binds the
`preview_bucket_name`):

```sh
for k in index.json replays/<id>.brw replays/<id>.resources replays/<id>/c0 ...; do
  wrangler r2 object put "barreplay-replays-preview/$k" --file "./static/$k" --local
done
```

## Alternative: public R2 domain

Instead of the Worker proxying R2, you can expose the bucket on a public R2 custom domain
and point the viewer's fetch base at it — then the Worker only serves the SPA. The
pass-through route is used here so the project is self-contained and testable.
