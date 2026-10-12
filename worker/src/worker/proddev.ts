// Local entry for `npm run dev:prod` (wrangler.proddev.jsonc): the ordinary
// Hono app, reading PRODUCTION's catalog, games mirror, job queue and replay
// files through the read-only proxy Worker (src/prodproxy, reached over the
// remote service binding PROD). See src/worker/readonly.ts.
//
// What stays LOCAL: the SummaryHub (no daemon connects to a dev server, so an
// on-demand summary answers "unavailable" and the page falls back to the
// published file), and the cron, which is not exported here at all — the
// games mirror, lobby poll and lava sync all write.
import app from "./app";
import { ReadOnlyError, readOnlyBucket, readOnlyIndex } from "./readonly";
import { SummaryHub } from "./summaryhubdo";

export { SummaryHub };

type ProdDevEnv = Omit<Env, "REPLAY_INDEX" | "BUCKET" | "LAVABALANCE"> & { PROD: Fetcher };

// A refused write is a 403 that says so, not the generic 500 app.ts answers
// for an unhandled error. Replacing the handler is local to this bundle: the
// deployed worker's entry is index.ts and never imports this file.
app.onError((err, c) => {
  if (err instanceof ReadOnlyError) return c.json({ error: err.message }, 403);
  console.error(`unhandled error on ${c.req.method} ${c.req.path}: ${err.message}\n${err.stack ?? ""}`);
  return c.text("Internal Server Error", 500);
});

export default {
  fetch(req: Request, env: ProdDevEnv, ctx: ExecutionContext) {
    // Every call to production is logged with the page request behind it:
    // the remote binding reports its failures as bare "Network connection
    // lost" / "internal error; reference = ..." lines with no stack and no
    // URL, so this is the only way to tell which request they belong to.
    const page = `${req.method} ${new URL(req.url).pathname}`;
    const proxy = async (r: Request) => {
      const call = new URL(r.url).pathname;
      const t0 = Date.now();
      try {
        const res = await env.PROD.fetch(r);
        if (!res.ok) console.warn(`[prod] ${page} -> ${call}: HTTP ${res.status} (${Date.now() - t0} ms)`);
        return res;
      } catch (err) {
        console.error(`[prod] ${page} -> ${call}: ${(err as Error).message} (${Date.now() - t0} ms)`);
        throw err;
      }
    };
    const prodEnv = { ...env, REPLAY_INDEX: readOnlyIndex(proxy), BUCKET: readOnlyBucket(proxy) } as unknown as Env;
    return app.fetch(req, prodEnv, ctx);
  },
} satisfies ExportedHandler<ProdDevEnv>;
