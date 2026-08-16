import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// assetRev stamps index.html's __ASSET_REV__ token with a content hash of the
// SPA's subresources (public/app.js + public/style.css — Vite copies public/
// verbatim, so nothing hashes their URLs otherwise). A UI deploy thus changes
// the /app.js?v=… URLs and browsers refetch on their own; index.html itself is
// served no-cache (see src/worker/app.ts + assets.run_worker_first). The Go
// viz server performs the same substitution at startup (internal/viz).
// Recomputed per transform so `vite dev` tracks edits.
function assetRev(): Plugin {
  return {
    name: "asset-rev",
    transformIndexHtml(html) {
      const h = createHash("sha256");
      for (const f of ["./public/app.js", "./public/style.css"]) {
        h.update(readFileSync(fileURLToPath(new URL(f, import.meta.url))));
      }
      return html.replaceAll("__ASSET_REV__", h.digest("hex").slice(0, 8));
    },
  };
}

// The origin the deployed viewer fetches replay DATA from: the R2 bucket bound
// to its own hostname. Serving those objects straight from the bucket puts
// Cloudflare's cache in front of R2 — a cache hit never becomes a GetObject,
// so it costs no Class B operation — whereas a Worker runs BEFORE the cache,
// making every read a billed GetObject no matter what cache-control it sets.
//
// $DATA_BASE overrides it (an empty value pins the viewer back to same-origin,
// which is the escape hatch if the bucket hostname ever misbehaves).
const DATA_BASE = process.env.DATA_BASE ?? "https://cdn-bar.fogofwar.dev";

// dataBase stamps index.html's __DATA_ORIGIN__ placeholder. Only a BUILD gets the real
// origin: under `vite dev` the local worker serves the preview bucket's pieces
// itself, and pointing dev at the production hostname would silently play
// production data against a locally-edited UI.
function dataBase(): Plugin {
  let isBuild = false;
  return {
    name: "data-base",
    configResolved(cfg) {
      isBuild = cfg.command === "build";
    },
    transformIndexHtml(html) {
      return html.replaceAll("__DATA_ORIGIN__", isBuild ? DATA_BASE : "");
    },
  };
}

// The Cloudflare plugin runs the Worker (src/worker/index.ts, per wrangler.jsonc) inside
// the real workerd runtime during `vite dev`, and builds both the client bundle and the
// Worker on `vite build`. No React/JSX plugin: the UI is plain TypeScript + Canvas/DOM.
export default defineConfig({
  plugins: [assetRev(), dataBase(), cloudflare()],
});
