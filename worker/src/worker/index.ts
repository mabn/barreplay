// Worker entry point. The routes live in app.ts (kept free of workerd-only
// imports so the node tests can exercise them); this file adds the Durable
// Object class export wrangler's migration binding requires, and the cron
// handler, which is the one thing that cannot live in a Hono app.
import app, { indexStub } from "./app";
import { syncGames } from "./games";
import { syncLava } from "./lavasync";
import { JOB_SAMPLE_RETENTION_SEC, ReplayIndex } from "./replayindex";
import { syncLobbies } from "./teiserver";

export { ReplayIndex };

/** Which minute of the hour the sample sweep runs in. Any value does; not
 * zero, only so it does not share the tick with whatever else the platform
 * does on the hour. */
const PRUNE_MINUTE = 17;

/** Which minute of the hour the lava sync runs UNCONDITIONALLY. Every other
 * tick it runs only when the games sync just mirrored a lava-shaped game (the
 * trigger that makes a finished lava game reach lavabalance within a minute);
 * this sweep is the retry path — a trigger that failed because lavabalance was
 * down is re-attempted here, finding everything still unmarked and therefore
 * still pending — and it is what drains a backlog, one batch an hour. Hourly,
 * not per-tick, because the candidate query's cost is the count of lava-flagged
 * games ever mirrored (see ReplayIndex.gamesLavaPending) and 1440 of those a
 * day is the ROW BUDGET pattern to avoid. */
const LAVA_SYNC_MINUTE = 43;

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
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    let lavaCandidates = 0;
    try {
      const r = await syncGames(indexStub(env));
      lavaCandidates = r.lavaCandidates;
      // Quiet on a no-op tick: most runs find nothing new, and a line a minute
      // saying so would bury the ones that did something.
      if (r.added > 0 || r.failed > 0) {
        console.log(`games sync: pages=${r.pages} scanned=${r.scanned} fresh=${r.fresh} added=${r.added} failed=${r.failed}`);
      }
    } catch (e) {
      console.error(`games sync failed: ${e}`);
    }

    // Same tick, second step: poll teiserver's lobby list for the names
    // the rts-api mirror can never carry (teiserver.ts). Its own try/catch,
    // so a teiserver outage never costs the games mirror a run and vice
    // versa; skipped entirely without the secrets, so local dev and forks
    // run the games sync alone. BEFORE the lava sync, deliberately: the
    // lobby match is arrival-driven, pairing a game on the tick it lands in
    // the mirror — the same tick `modded > 0` triggers the lava sync — and
    // the lobby details it copies onto the games row must be there before
    // that submission reads them, or lavabalance stores the game without
    // its parties forever.
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

    // Same tick, third step: offer freshly-finished lava games to the sibling
    // lavabalance worker over the service binding (lavasync.ts — it marks what
    // it offers, so a run after downtime catches up by itself and a game the
    // other side declines cannot hold up the ones behind it). Triggered by the
    // games sync mirroring a game of that shape, plus the hourly sweep (see
    // LAVA_SYNC_MINUTE), which is also what drains a backlog.
    // Its own try/catch: lavabalance being down must not cost the mirror.
    const sweep = new Date(controller.scheduledTime).getUTCMinutes() === LAVA_SYNC_MINUTE;
    if ((lavaCandidates > 0 || sweep) && env.LAVABALANCE !== undefined) {
      try {
        const lv = await syncLava(indexStub(env), env.LAVABALANCE.fetch.bind(env.LAVABALANCE));
        if (lv.submitted > 0) {
          console.log(
            `lava sync: candidates=${lv.candidates} submitted=${lv.submitted} rated=${lv.rated} ` +
              `ignored=${lv.ignored} skipped=${lv.skipped} duplicate=${lv.duplicate} ` +
              `rejected=${lv.rejected}${lv.more ? " (more pending)" : ""}`,
          );
        }
      } catch (e) {
        console.error(`lava sync failed: ${e}`);
      }
    }
    // The job_samples table is the one thing here that would otherwise grow
    // without a rule: a finished job's healthcheck history deliberately
    // outlives it (that curve is the point), so something has to age it out,
    // and the cron is the worker's only periodic hook. Its own try, so a
    // failure cannot take the mirror down with it.
    //
    // ONCE AN HOUR, not once a minute: what it removes is a month old, so the
    // minute it happens in is worth nothing, and the cron's only reason to run
    // every minute is the mirror. (The sweep is cheap now — see
    // ReplayIndex.jobSamplePrune — but "cheap" times 1440 is how this worker
    // spent a day's rows-read budget on housekeeping in the first place.)
    // The SCHEDULED time, not the clock: that is the minute the trigger was
    // for, where a reading taken inside the handler is a firing that ran a
    // second early away from ever matching.
    if (new Date(controller.scheduledTime).getUTCMinutes() === PRUNE_MINUTE) {
      try {
        const cutoff = Math.floor(Date.now() / 1000) - JOB_SAMPLE_RETENTION_SEC;
        const dropped = await indexStub(env).jobSamplePrune(cutoff);
        if (dropped > 0) console.log(`job samples pruned: ${dropped}`);
      } catch (e) {
        console.error(`job sample prune failed: ${e}`);
      }
    }
  },
} satisfies ExportedHandler<Env>;
