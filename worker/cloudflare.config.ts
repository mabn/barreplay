// The Worker configuration `cf` reads (`cf dev`, `cf build`, `cf deploy`) and
// the Cloudflare Vite plugin and the vitest pool load. It replaced
// wrangler.jsonc; the reasoning behind each setting moved with it.
//
// ONE FILE, THREE WORKERS, picked by MODE (`--mode`, which `cf` passes to Vite):
//   production / development / test   the "replay" worker itself — `cf deploy`,
//                                     `npm run dev` and `npm test` (no --mode)
//   proddev     `npm run dev:prod`: the same app over PRODUCTION data, read-only,
//               through the proxy below (src/worker/proddev.ts, readonly.ts).
//               Never deployed.
//   prodproxy   the read-only production proxy behind proddev
//               (src/prodproxy), deployed by hand with `npm run deploy:prodproxy`
//               (`cf deploy --mode prodproxy`); redeploy it only when
//               READ_METHODS changes.
// Wrangler kept these as three files (wrangler.jsonc, wrangler.proddev.jsonc,
// wrangler.prodproxy.jsonc); the Vite plugin 2.0 has no configPath option, so a
// mode is the one way to point it at another Worker.
import { bindings, defineConfig, defineWorker, exports, triggers } from "cf/config";
// Imported (rather than named by path) so the generated Env types the Durable
// Object bindings with their classes, as `wrangler types` did.
import * as replayEntry from "./src/worker/index.ts" with { type: "cf-worker" };

// Read by more than this file, by TEXT: internal/packer/r2.go (and the Go CLIs
// that publish to R2) and tools/r2put.ts take the account and the bucket from
// these two lines, so keep them `const NAME = "value";` on one line each.
// Same Cloudflare account as the sibling claudebar/lavabalance worker.
const ACCOUNT_ID = "9a1829e6502587e153ffa45b76de7ed3";
// The growing set of replay data lives in this R2 bucket (see the README).
const REPLAY_BUCKET = "barreplay-replays";

const COMPATIBILITY_DATE = "2026-06-27";

// ADMIN LOGIN (Cloudflare Access, src/worker/access.ts): the admin routes
// verify an Access JWT against these two. Neither is secret: the team domain
// is the subdomain every Access login page for this account lives on, and the
// AUD tag is the Access application's audience — the self-hosted application
// for replay.fogofwar.dev/admin/login (README "Admin login"). Both missing =
// every admin route 401s (fail-closed). ADMIN_OPEN=true belongs in .dev.vars
// ONLY, never here.
const ACCESS = {
  ACCESS_TEAM_DOMAIN: bindings.text("bartools.cloudflareaccess.com"),
  ACCESS_AUD: bindings.text("94214a467ff0d56eac5a9b0f4637a189722107d5770b90d387af453642f2b83d"),
};

// Everything still goes through the Worker EXCEPT the plain vendored files.
// "/*" keeps the original guarantee — the SPA entry is served no-cache by the
// serveEntry route (index.html carries content-hashed subresource URLs, so a
// revalidated entry is all a UI deploy needs to propagate), and no route can
// fall through to the asset layer's single-page-application handling, which
// would answer /api/* with index.html. That trap is why this is "/*" plus
// exclusions rather than a list of the paths the Worker wants: the list form is
// deny-by-default in exactly the wrong direction.
//
// The exclusions matter twice over. A cold replay load requests 300-650 unit
// icons; through the Worker each one is an invocation, and served by the asset
// layer they are cached on Cloudflare's network instead. And public/_headers
// only applies to what the ASSET LAYER serves — a Worker response ignores it —
// so without these exclusions the cache-control rules for those prefixes would
// be silently dead.
//
// The favicons are named individually rather than matched: they are two fixed
// files, and /favicon.ico in particular must resolve to the real object. Left
// to the Worker it reached the catch-all, where the asset layer's
// single-page-application handling answered it with index.html — a 200
// carrying the whole HTML document, labelled text/html, as the tab icon.
//
// The widget download (synced into public/ from assets/lua by
// tools/sync-assets.mjs) is excluded for the _headers reason: routed through
// the Worker its no-cache rule would be dead, and it is the one file here whose
// bytes change under a stable URL. /embed/* (the game summary other sites
// import, see vite.config.ts) likewise: its CORS and cache rules live in
// _headers. /fogofwar-app.webp is the /setup page's screenshot.
const RUN_WORKER_FIRST = [
  "/*",
  "!/icons/*",
  "!/ranks/*",
  "!/favicon.ico",
  "!/favicon.svg",
  "!/replay_uploader.lua",
  "!/fogofwar-app.webp",
  "!/embed/*",
];

const config = defineConfig((ctx) => {
  switch (ctx.mode) {
    case "proddev":
      return { accountId: ACCOUNT_ID, worker: proddev() };
    case "prodproxy":
      return { accountId: ACCOUNT_ID, worker: prodproxy() };
    default:
      return { accountId: ACCOUNT_ID, worker: replay() };
  }
});

// The TYPE is the deployed Worker's alone. `cf` generates the global `Env`
// (.cloudflare/types) from this export's type, and over the three-way union
// every binding came out optional and the Durable Object stubs untyped. Only
// the type is narrowed — what runs is `config` above — and the other two
// entries type their own env (ProdDevEnv in src/worker/proddev.ts, ProxyEnv in
// src/prodproxy/index.ts).
export default config as unknown as { accountId: string; worker: ReturnType<typeof replay> };

// The live Durable Object classes of the replay Worker. This REPLACES
// Wrangler's ordered `migrations` list (v1 new_sqlite_classes ReplayIndex, v2
// SummaryHub): cf declares the classes that exist, and both were created
// SQLite-backed. A rename or delete would be a tombstone entry here — see
// https://developers.cloudflare.com/cf/wrangler/reference/#convert-durable-object-migrations
const REPLAY_EXPORTS = {
  ReplayIndex: exports.durableObject({ storage: "sqlite" }),
  SummaryHub: exports.durableObject({ storage: "sqlite" }),
};

// The replay Worker as a REFERENCE for its own Durable Object bindings (and
// the proxy's): naming the Worker by a config rather than the string "replay"
// is what types each binding with its class, as `wrangler types` did.
const replayRef = defineWorker({
  name: "replay",
  compatibilityDate: COMPATIBILITY_DATE,
  entrypoint: replayEntry,
  exports: REPLAY_EXPORTS,
});

// The deployed viewer: replay.fogofwar.dev.
function replay() {
  return {
    name: "replay",
    compatibilityDate: COMPATIBILITY_DATE,
    entrypoint: replayEntry,

    // The public hostname, as a Custom Domain (Cloudflare creates the DNS record
    // and provisions the certificate for this exact hostname, so no wildcard
    // cert and no Advanced Certificate Manager). REQUIREMENT: the fogofwar.dev
    // zone must live in the SAME account as ACCOUNT_ID — a Custom Domain cannot
    // bind a zone held by another account.
    domains: ["replay.fogofwar.dev"],

    // Also serve on replay.bartools.workers.dev. EXPLICIT on purpose: with a
    // custom domain present the default flips to off, and a deploy would then
    // disable the subdomain. The viewer works from either hostname because the
    // bulk replay fetches go to the absolute cdn-bar.fogofwar.dev data origin
    // either way — which is why the workers.dev origin must also be in
    // r2-cors.json (README's CORS step), or the browser blocks every replay
    // piece there.
    workersDev: true,

    observability: { enabled: true },

    // The Vite build's client bundle is served as static assets by the runtime;
    // `single-page-application` serves index.html for unmatched navigations.
    assets: {
      notFoundHandling: "single-page-application" as const,
      runWorkerFirst: RUN_WORKER_FIRST,
    },

    // The games mirror, lobby poll, lava sync and job-sample pruning
    // (src/worker/index.ts's scheduled handler) run once a minute.
    triggers: [triggers.scheduled({ schedule: "* * * * *" })],

    env: {
      ...ACCESS,
      ASSETS: bindings.assets(),
      BUCKET: bindings.r2({ name: REPLAY_BUCKET }),
      // The sibling lavabalance worker (claudebar/lavabalance, same account):
      // the cron's lava sync submits candidate games to its open POST
      // /api/games over this binding. No change on its side is needed.
      LAVABALANCE: bindings.worker({ worker: "lavabalance" }),
      // The replay catalog, job queue and games mirror (src/worker/replayindex.ts)
      // and the on-demand summary hub (src/worker/summaryhub.ts): one
      // SQLite-backed Durable Object each, defined by THIS worker.
      REPLAY_INDEX: bindings.durableObject({ worker: replayRef, exportName: "ReplayIndex" }),
      SUMMARY_HUB: bindings.durableObject({ worker: replayRef, exportName: "SummaryHub" }),
    },

    exports: REPLAY_EXPORTS,
  };
}

// `npm run dev:prod`: the same app with a different entry (src/worker/proddev.ts)
// and no bucket or catalog object of its own — both are read through the
// deployed read-only proxy over the REMOTE binding PROD. `dev.remote` is what
// makes the local dev server talk to the deployed Worker; it needs
// `cf auth login` on this machine.
function proddev() {
  return {
    name: "replay-proddev",
    compatibilityDate: COMPATIBILITY_DATE,
    entrypoint: "src/worker/proddev.ts",
    assets: {
      notFoundHandling: "single-page-application" as const,
      runWorkerFirst: RUN_WORKER_FIRST,
    },
    env: {
      ...ACCESS,
      ASSETS: bindings.assets(),
      PROD: bindings.worker({ worker: "replay-prod-readonly", dev: { remote: true } }),
      // Only the summary hub is local (and idle: no daemon connects to a dev
      // server). REPLAY_INDEX is the proxy's, so it is not declared here.
      SUMMARY_HUB: bindings.durableObject({ worker: "replay-proddev", exportName: "SummaryHub" }),
    },
    exports: {
      SummaryHub: exports.durableObject({ storage: "sqlite" as const }),
    },
  };
}

// The READ-ONLY PRODUCTION PROXY (src/prodproxy). No public route at all: no
// workers.dev hostname, no preview URLs, no custom domain — a binding from this
// account is the only way in. It binds PRODUCTION's bucket and catalog and only
// ever reads them: every route it serves is a get/head/list or an allowlisted
// ReplayIndex read.
function prodproxy() {
  return {
    name: "replay-prod-readonly",
    compatibilityDate: COMPATIBILITY_DATE,
    entrypoint: "src/prodproxy/index.ts",
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true },
    env: {
      BUCKET: bindings.r2({ name: REPLAY_BUCKET }),
      // The object of the deployed "replay" worker — this script defines no
      // Durable Object class of its own, so it declares no exports.
      REPLAY_INDEX: bindings.durableObject({ worker: "replay", exportName: "ReplayIndex" }),
    },
  };
}
