// Worker entry point. The routes live in app.ts (kept free of workerd-only
// imports so the node tests can exercise them); this file adds the Durable
// Object class export wrangler's migration binding requires, and the cron
// handler, which is the one thing that cannot live in a Hono app.
import app, { indexStub } from "./app";
import { syncGames } from "./games";
import { ReplayIndex } from "./replayindex";

export { ReplayIndex };

export default {
  fetch: app.fetch,

  // Every minute (wrangler.jsonc "triggers"): mirror the newest games BAR
  // published into the `games` table. One page, no history walking — see
  // games.ts for why that is enough and what it costs.
  //
  // Failures are logged, not thrown. The sync is idempotent and the next tick
  // is a minute away, so a BAR API blip resolves itself; letting it throw
  // would only turn a self-healing hiccup into a minute-by-minute stream of
  // failed cron invocations in the dashboard.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const r = await syncGames(indexStub(env));
      // Quiet on a no-op tick: most runs find nothing new, and a line a minute
      // saying so would bury the ones that did something.
      if (r.added > 0 || r.failed > 0) {
        console.log(`games sync: scanned=${r.scanned} fresh=${r.fresh} added=${r.added} failed=${r.failed}`);
      }
    } catch (e) {
      console.error(`games sync failed: ${e}`);
    }
  },
} satisfies ExportedHandler<Env>;
