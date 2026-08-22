// Vitest, running inside workerd via @cloudflare/vitest-pool-workers — the
// only way to drive the ReplayIndex Durable Object, whose `cloudflare:workers`
// import and SQLite storage are both out of plain node's reach.
//
// It covers ONLY tests/do/**: everything else (the Hono routes with a fake
// Env, the pure modules) stays on `tsx --test`, which boots in milliseconds
// and needs no runtime. `npm test` runs both — see package.json.
//
// The bindings come from wrangler.jsonc itself rather than a second copy here,
// so a test worker cannot quietly diverge from the deployed one.
//
// There is no storage-isolation option to set: this version's whole option set
// is main/remoteBindings/verbose/additionalExports/miniflare/wrangler — the
// vitest-3 `isolatedStorage` and `singleWorker` are gone. Tests that need an
// empty table therefore address their OWN Durable Object instance; see the
// helper in tests/do/replayindex.test.ts.
//
// The vitest-4 shape of this integration: a PLUGIN carrying the worker options,
// not a `test.poolOptions.workers` block — that was the vitest-3 API, and the
// package ships a codemod for the difference (vitest-v3-to-v4). Anything found
// online in the older form has to be translated.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["tests/do/**/*.test.ts"],
  },
});
