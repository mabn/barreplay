import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
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

// The game-summary library (src/summary/), bundled into ONE self-contained ES
// module that app.js imports the first time the Summary tab opens. It is
// TypeScript in several files, so unlike app.js it does need a bundler, and it
// is built here rather than as a Vite client entry because the viewer is not a
// Vite app: app.js is a classic script copied verbatim from public/.
//
// The bundle is fingerprinted like the other subresources, by its OWN hash
// (its bytes, after bundling): index.html carries the URL in its __SUMMARY_MODULE__ placeholder,
// which app.js reads from window.__SUMMARY_JS__, so app.js itself does not
// change when only the summary does. `vite dev` serves a fresh bundle per
// request at a fixed /summary.dev.js.
async function bundleSummary(entry = "index.ts"): Promise<string> {
  const out = await esbuild({
    entryPoints: [fileURLToPath(new URL(`./src/summary/${entry}`, import.meta.url))],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    legalComments: "none",
  });
  return out.outputFiles[0].text;
}

const summaryName = (code: string) => `summary.${createHash("sha256").update(code).digest("hex").slice(0, 8)}.js`;

// The summary for OTHER SITES (src/summary/embed.ts, mountGameSummary), which
// import it from this deployment at run time — `import("https://replay.
// fogofwar.dev/embed/summary.js")` — so a deploy here reaches them with no
// change on their side. /embed/summary.js is the one stable name: a two-line
// module, served no-cache, that re-exports the fingerprinted bundle beside it
// (embed/summary.<rev>.js, immutable). Both live under /embed/, which
// wrangler.jsonc hands to the asset layer so public/_headers can give them
// their CORS and cache rules (a cross-origin module import needs the former).
const EMBED_LOADER = "embed/summary.js";
const embedLoader = (bundle: string) =>
  "// The game summary for other sites; see worker/vite.config.ts.\n" +
  `export * from "./${bundle}";\n`;

function summaryBundle(): Plugin {
  let isBuild = false;
  let built: string | null = null;
  let embed: string | null = null;
  return {
    name: "summary-bundle",
    configResolved(cfg) {
      isBuild = cfg.command === "build";
    },
    async buildStart() {
      if (isBuild) [built, embed] = await Promise.all([bundleSummary(), bundleSummary("embed.ts")]);
    },
    async transformIndexHtml(html) {
      if (!isBuild) return html.replaceAll("__SUMMARY_MODULE__", "/summary.dev.js");
      built ??= await bundleSummary();
      return html.replaceAll("__SUMMARY_MODULE__", "/" + summaryName(built));
    },
    async generateBundle() {
      built ??= await bundleSummary();
      this.emitFile({ type: "asset", fileName: summaryName(built), source: built });
      embed ??= await bundleSummary("embed.ts");
      const embedFile = summaryName(embed);
      this.emitFile({ type: "asset", fileName: "embed/" + embedFile, source: embed });
      this.emitFile({ type: "asset", fileName: EMBED_LOADER, source: embedLoader(embedFile) });
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const entry = req.url?.startsWith("/summary.dev.js")
          ? "index.ts"
          : req.url?.startsWith("/" + EMBED_LOADER) ? "embed.ts" : null;
        if (!entry) return next();
        try {
          const code = await bundleSummary(entry);
          res.setHeader("content-type", "text/javascript; charset=utf-8");
          res.setHeader("cache-control", "no-cache");
          res.setHeader("access-control-allow-origin", "*");
          res.end(code);
        } catch (e) {
          next(e);
        }
      });
    },
  };
}

// The Cloudflare plugin runs the Worker (src/worker/index.ts, per wrangler.jsonc) inside
// the real workerd runtime during `vite dev`, and builds both the client bundle and the
// Worker on `vite build`. No React/JSX plugin: the UI is plain TypeScript + Canvas/DOM.
export default defineConfig({
  plugins: [assetRev(), dataBase(), summaryBundle(), cloudflare()],
});
