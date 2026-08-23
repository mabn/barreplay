// What the RECURRING reads cost, in rows.
//
// The Durable Object's SQL is billed by rows read, and three of this worker's
// callers are machines on a timer: the cron every minute, and an ingest daemon
// polling for work every ten seconds from however many hosts are running one.
// A query whose cost is the size of a table rather than the size of its answer
// is therefore not a slow query here, it is an outage on a schedule — which is
// what it was, once: a full scan of the games mirror per poll and a full scan
// of every healthcheck ever recorded per cron tick spent a day's entire
// rows-read allowance on finding nothing, and every route then failed with
// "Exceeded allowed rows read" until midnight.
//
// So this file seeds tables far larger than the deployment's and asserts that
// each of those reads stays SMALL — not merely smaller. The numbers below are
// bounds with room in them, not measurements to keep up to date; what they are
// really asserting is the absence of a scan, and a failure here means a new
// one has appeared (or an index has stopped being used), not that something
// got a little slower.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

import type { ReplayIndex } from "../../src/worker/replayindex";

/** Seeded far beyond the real deployment: the mirror gains ~2000 games a day
 * and a re-simulation records a healthcheck every ten seconds for an hour, so
 * these are next month's sizes, which is the point. */
const GAMES = 5000;
const REPLAYS = 300;
const JOBS = 200;
const SAMPLES_PER_JOB = 400;
const LOBBIES = 300;
const NOW = 1787000000;

/** Run a block inside a ReplayIndex of this test's own, with a tally of every
 * row its SQL reads.
 *
 * `sql.exec` is wrapped rather than each statement measured by hand, because
 * the point is to bill a whole METHOD — including the reads it makes through
 * the helpers it calls, which is where a scan hides. rowsRead is only final
 * once a cursor has been consumed, so the shim consumes it up front and hands
 * back the rows; every caller in the object either takes .toArray() or reads
 * .rowsWritten. */
function measured<T>(fn: (index: ReplayIndex, tally: () => number) => T): Promise<T> {
  const name = expect.getState().currentTestName ?? "index";
  const stub = env.REPLAY_INDEX.get(env.REPLAY_INDEX.idFromName(name));
  return runInDurableObject(stub, (instance: ReplayIndex, state) => {
    const sql = state.storage.sql;
    const real = sql.exec.bind(sql);
    let read = 0;
    (sql as unknown as { exec: unknown }).exec = (q: string, ...args: unknown[]) => {
      const cur = real(q, ...(args as string[]));
      const rows = cur.toArray();
      read += cur.rowsRead;
      return { toArray: () => rows, rowsWritten: cur.rowsWritten, rowsRead: cur.rowsRead };
    };
    try {
      return fn(instance, () => {
        const n = read;
        read = 0;
        return n;
      });
    } finally {
      (sql as unknown as { exec: unknown }).exec = real;
    }
  });
}

function seed(index: ReplayIndex): void {
  const sql = (index as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
  const seq = (n: number) =>
    `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${n}) SELECT n FROM seq`;
  const roster = `'[{"ally":0,"count":8,"players":[{"name":"p' || n || '","os":25}]}]'`;
  // Games and replays are staggered in time, and each game's mirroring is
  // stamped with its own age: a query that reads "the last minute of
  // arrivals" must find two rows here, not five thousand.
  sql.exec(`INSERT INTO games (id, start_unix, duration_sec, map, map_file, game_size, preset,
              player_count, players, settings, engine_version, game_version, synced_unix)
    SELECT printf('g%06d', n), ${NOW} - n*40, 900, 'Map ' || (n % 40), 'map_' || (n % 40), '8v8', 'team', 16,
           ${roster}, '{"ranked":true}', 'e', 'v', ${NOW} - n*40
    FROM (${seq(GAMES)})`);
  sql.exec(`INSERT INTO replays (id, start_unix, duration_sec, map, game_size, size_bytes,
              player_count, players, settings, updated_unix, placeholder)
    SELECT printf('g%06d', n), ${NOW} - n*40, 900, 'Map ' || (n % 40), '8v8', 8000000, 16,
           ${roster}, '{"ranked":true}', ${NOW}, 0
    FROM (${seq(REPLAYS)})`);
  sql.exec(`INSERT INTO replay_players (replay_id, name_lower, name)
    SELECT printf('g%06d', n), 'p' || n, 'p' || n FROM (${seq(GAMES)})`);
  sql.exec(`INSERT INTO replay_settings (replay_id, flag)
    SELECT printf('g%06d', n), 'ranked' FROM (${seq(GAMES)})`);
  sql.exec(`INSERT INTO jobs (id, stream_key, game_id, kind, state, created_unix, updated_unix)
    SELECT printf('j%06d', n), '', printf('g%06d', n), 'resim', 'done', ${NOW}, ${NOW}
    FROM (${seq(JOBS)})`);
  sql.exec(`INSERT INTO job_samples (job_id, at_unix, state, frame, percent, eta_sec, rss_bytes, swap_bytes, cpu_pct)
    SELECT printf('j%06d', (n % ${JOBS}) + 1), ${NOW} + (n / ${JOBS}) * 10, 'simulating', n, 50.0, 100.0, 3e9, 0, 600.0
    FROM (${seq(JOBS * SAMPLES_PER_JOB)})`);
  // Lobby observations, nearly all of them unmatched — which is the state they
  // stay in forever when no game ever claims them.
  sql.exec(`INSERT INTO lobbies (lobby_id, started_unix, name, map, players, player_count, ended_unix, matched_game_id)
    SELECT n, ${NOW} - n*3600, 'lobby ' || n, 'Map ' || (n % 40), '["p1"]', 8,
           CASE WHEN n % 10 = 0 THEN NULL ELSE ${NOW} END, NULL
    FROM (${seq(LOBBIES)})`);
}

test("the polled and cron reads do not scan the tables they read from", async () => {
  const costs = await measured((index, tally) => {
    seed(index);
    tally();
    const out: Record<string, number> = {};

    // The ingest daemons' poll, every 10s, per host.
    index.jobsPending("upload");
    out.jobsPendingUpload = tally();
    index.jobsPending("resim");
    out.jobsPendingResim = tally();

    // The same poll when there is nothing queued: the mirror backfill, whose
    // cost is the window it inspects rather than the size of the mirror. The
    // second call does not scan at all — the first one queued a game, so this
    // one is answered by jobsPending out of an index, which is what every poll
    // for the length of the run would be.
    // NOTE the seed above: the newest 200 mirrored games already have a job
    // row, so this measures the case that matters — a daemon that has worked
    // through the recent past and must be handed something older. It has to
    // come back with a game, not just come back cheaply: a scan that reports
    // an empty mirror while thousands of candidates sit behind it costs
    // nothing to run and stops the pipeline dead.
    const offered = index.jobsOffer("resim", "job-backfill-1");
    out.jobsOfferScan = tally();
    expect(offered.length, "the backfill must reach past the games it has taken").toBe(1);
    index.jobsOffer("resim", "job-backfill-2");
    out.jobsOfferQueued = tally();

    // The cron, every minute.
    index.lobbiesOpen();
    out.lobbiesOpen = tally();
    index.lobbiesMatch();
    out.lobbiesMatch = tally();
    index.jobSamplePrune(NOW - 30 * 24 * 3600);
    out.jobSamplePrune = tally();

    // A page of the catalog, as the landing list asks for it. The daemon's
    // scan still asks for the whole thing (see runOnce in cmd/bringest), which
    // is why the ORDER BY has to be able to stop early for everyone else.
    index.list(undefined, 50, 0);
    out.listPage = tally();

    // A running job's healthcheck, every 10s: the first beat learns how many
    // samples the job has, the rest must not ask again.
    index.jobUpdate("j000001", "processing", null, null, { state: "simulating", percent: 12 });
    out.healthcheckFirst = tally();
    index.jobUpdate("j000001", "processing", null, null, { state: "simulating", percent: 13 });
    out.healthcheckNext = tally();
    return out;
  });

  const report = JSON.stringify(costs, null, 2);
  // A poll is answered out of an index, not out of the tables.
  expect(costs.jobsPendingUpload, report).toBeLessThan(50);
  expect(costs.jobsPendingResim, report).toBeLessThan(50);
  // The backfill stops at its 200th candidate rather than reading the mirror:
  // here that means stepping over the 300 latest-ended games (published, the
  // newest 200 of them also with job rows) plus the 200-candidate window and
  // no further, where the unindexed ORDER BY read all 5000 twice over.
  expect(costs.jobsOfferScan, report).toBeLessThan(4000);
  expect(costs.jobsOfferQueued, report).toBeLessThan(50);
  // Partial index over the open observations, not a scan of every one ever
  // recorded.
  expect(costs.lobbiesOpen, report).toBeLessThan(100);
  // Arrival-driven: with nothing mirrored in the last minute there is nothing
  // to match, and it stops before reading any observation at all.
  expect(costs.lobbiesMatch, report).toBeLessThan(100);
  // Driven from the jobs table over a band of finishing times, where it used
  // to read every sample ever recorded to list the job ids.
  expect(costs.jobSamplePrune, report).toBeLessThan(100);
  // A page is a page: the listing walks replays_start and stops, where a
  // leading ORDER BY expression made it sort every row in the catalog first.
  expect(costs.listPage, report).toBeLessThan(400);
  // The first beat counts the job's samples; every beat after it is answered
  // from memory.
  expect(costs.healthcheckNext, report).toBeLessThan(50);
});
