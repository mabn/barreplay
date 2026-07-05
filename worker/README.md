# barreplay worker

A Cloudflare Worker that hosts the barreplay UI and server, built with
[Hono](https://hono.dev) and [Vite](https://vite.dev) (via
[`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/)).
No heavy front-end framework — the UI is plain TypeScript + Canvas/DOM.

This is **scaffolding**. The HTTP server currently lives in Go (`cmd/barreplay-viz` +
`internal/viz`); the endpoints there are intended to be ported into `src/worker/index.ts`
incrementally. Nothing here rewrites the Go server yet.

## Layout

```
worker/
  wrangler.jsonc          Worker config (name, main, account_id, assets binding)
  vite.config.ts          Vite + @cloudflare/vite-plugin
  index.html              Client entry (Vite)
  src/
    worker/index.ts       Hono app: JSON API + SPA fallback (the "server")
    client/main.ts        Plain-TS UI entry (the "UI")
    client/style.css
  public/                 Static files copied verbatim into the build
```

Static assets (the built client) are served by the runtime before the Worker runs;
requests that don't match an asset fall through to the Hono app. Requests under `/api/*`
are handled by Hono; everything else falls back to `index.html` (SPA).

## Commands

```sh
npm install
npm run dev         # vite dev — runs the Worker in the real workerd runtime + HMR client
npm run build       # build client bundle + Worker into dist/
npm run preview     # preview the production build
npm run typecheck   # tsc --noEmit
npm run cf-typegen  # regenerate worker-configuration.d.ts from wrangler.jsonc
npm run deploy      # wrangler deploy (needs Cloudflare auth)
```
