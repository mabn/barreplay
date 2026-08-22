// Worker entry point. The routes live in app.ts (kept free of workerd-only
// imports so the node tests can exercise them); this file adds the Durable
// Object class export wrangler's migration binding requires, and the cron
// handler, which is the one thing that cannot live in a Hono app.
import app, { indexStub } from "./app";
import { syncGames } from "./games";
import { JOB_SAMPLE_RETENTION_SEC, ReplayIndex } from "./replayindex";
import { syncLobbies } from "./teiserver";

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
    // The job_samples table is the one thing here that would otherwise grow
    // without a rule: a finished job's healthcheck history deliberately
    // outlives it (that curve is the point), so something has to age it out,
    // and the cron is the worker's only periodic hook. Its own try, so a
    // failure cannot take the mirror down with it.
    try {
      const cutoff = Math.floor(Date.now() / 1000) - JOB_SAMPLE_RETENTION_SEC;
      const dropped = await indexStub(env).jobSamplePrune(cutoff);
      if (dropped > 0) console.log(`job samples pruned: ${dropped}`);
    } catch (e) {
      console.error(`job sample prune failed: ${e}`);
    }

    // Same tick, third step: poll teiserver's lobby list for the names
    // the rts-api mirror can never carry (teiserver.ts). Its own try/catch,
    // so a teiserver outage never costs the games mirror a run and vice
    // versa; skipped entirely without the secrets, so local dev and forks
    // run the games sync alone.
    if (env.TEISERVER_EMAIL !== undefined && env.TEISERVER_PASSWORD !== undefined) {
      try {
        const r = await syncLobbies(indexStub(env), {
          email: env.TEISERVER_EMAIL,
          password: env.TEISERVER_PASSWORD,
          base: env.TEISERVER_BASE,
        });
        if (r.started > 0 || r.ended > 0 || r.matched > 0 || r.failed > 0) {
          console.log(
            `lobby sync: active=${r.active} started=${r.started} ended=${r.ended} matched=${r.matched} failed=${r.failed}`,
          );
        }
      } catch (e) {
        console.error(`lobby sync failed: ${e}`);
      }
    }
  },
} satisfies ExportedHandler<Env>;
