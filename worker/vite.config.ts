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

// The Cloudflare plugin runs the Worker (src/worker/index.ts, per wrangler.jsonc) inside
// the real workerd runtime during `vite dev`, and builds both the client bundle and the
// Worker on `vite build`. No React/JSX plugin: the UI is plain TypeScript + Canvas/DOM.
export default defineConfig({
  plugins: [assetRev(), cloudflare()],
});
