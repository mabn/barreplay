import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

const SUBRESOURCES = [
  { src: "./public/app.js", name: (rev: string) => `app.${rev}.js` },
  { src: "./public/style.css", name: (rev: string) => `style.${rev}.css` },
];

const readAsset = (src: string) => readFileSync(fileURLToPath(new URL(src, import.meta.url)));

// revOf is the content hash both the URL and the emitted filenames carry: one
// hash over BOTH subresources, so editing either busts both. Slightly
// over-eager and deliberately so — it is one number to reason about.
function revOf(): string {
  const h = createHash("sha256");
  for (const s of SUBRESOURCES) h.update(readAsset(s.src));
  return h.digest("hex").slice(0, 8);
}

// assetRev fingerprints the SPA's subresources. index.html references them as
// /app.<rev>.js and /style.<rev>.css — the hash is in the NAME, not a ?v=
// query, so the URL of a given byte sequence never changes and the files can be
// served immutable for a year (see public/_headers). index.html itself stays
// no-cache, so a UI deploy propagates on a plain reload: the entry revalidates,
// its subresource URLs have changed, and browsers refetch exactly those.
//
// Vite copies public/ verbatim and does not fingerprint it, so the build has to
// emit the hashed names itself; `vite dev` serves public/ directly, so there
// the hashed URL is rewritten back to the plain one by middleware.
function assetRev(): Plugin {
  return {
    name: "asset-rev",
    transformIndexHtml(html) {
      return html.replaceAll("__ASSET_REV__", revOf());
    },
    // Build: emit a fingerprinted copy next to the verbatim one, so the URL in
    // index.html resolves as a real static asset (served by the asset layer,
    // not the Worker).
    generateBundle() {
      const rev = revOf();
      for (const s of SUBRESOURCES) {
        this.emitFile({ type: "asset", fileName: s.name(rev), source: readAsset(s.src) });
      }
    },
    // Dev: nothing emits the hashed name, so map it back to the real file.
    // Without this every `vite dev` session 404s its own app.js.
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url) req.url = req.url.replace(/^\/(app|style)\.[0-9a-f]{8}\.(js|css)(\?|$)/, "/$1.$2$3");
        next();
      });
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
