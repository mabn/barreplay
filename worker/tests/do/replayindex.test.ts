// The ReplayIndex Durable Object, driven inside workerd (vitest-pool-workers)
// — the half of the index the node tests cannot reach: real SQLite, the real
// schema, the real upsert/index statements.
//
// What earns a test here is anything whose behaviour IS the SQL: the games
// mirror's dedupe and inserts, and the rule that decides which row owns an
// id's entries in the two derived tables. Logic that is only JavaScript
// (parsing the API, the sync loop) stays in tests/games.test.ts, where it runs
// without a runtime.
import { env, runInDurableObject } from "cloudflare:test";
import { assert, expect, test } from "vitest";

import type { GameEntry } from "../../src/worker/games";
import type { ReplayIndex } from "../../src/worker/replayindex";
import { emptyFilter } from "../../src/worker/replayentry";
import type { ReplayEntry, ReplayFilter } from "../../src/worker/replayentry";

/** Run a block inside a ReplayIndex instance, with its SQL to hand.
 *
 * Each test gets its OWN instance, named after itself. The production worker
 * uses a single one (idFromName("index")), but the pool offers no per-test
 * storage isolation to lean on — vitest-3's `isolatedStorage` is not among
 * this version's options — so without this every test would read the rows the
 * last one wrote, and half of these count rows or read the whole catalog,
 * which only means anything on an empty table. */
function inIndex<T>(fn: (index: ReplayIndex, sql: SqlStorage) => T): Promise<T> {
  const name = expect.getState().currentTestName ?? "index";
  const stub = env.REPLAY_INDEX.get(env.REPLAY_INDEX.idFromName(name));
  return runInDurableObject(stub, (instance: ReplayIndex, state) => fn(instance, state.storage.sql));
}

const rows = (sql: SqlStorage, q: string, ...args: unknown[]): Record<string, unknown>[] =>
  sql.exec(q, ...(args as string[])).toArray();

function game(id: string, over: Partial<GameEntry> = {}): GameEntry {
  return {
    id,
    startUnix: 1787349909,
    durationSec: 217,
    map: "Great Divide V1",
    mapFile: "great_divide_v1",
    gameSize: "1v1",
    preset: "duel",
    playerCount: 2,
    players: [
      { ally: 0, count: 1, players: [{ name: "Rouben", os: 36.83 }] },
      { ally: 1, count: 1, players: [{ name: "LaufendeStahlwand", os: 13.25 }] },
    ],
    settings: { unranked: true },
    engineVersion: "2026.07.04",
    gameVersion: "Beyond All Reason test-31027-900131b",
    ...over,
  };
}

function replay(id: string, over: Partial<ReplayEntry> = {}): ReplayEntry {
  return {
    id,
    rid: `${id}-abcd1234`,
    startUnix: 1787349909,
    durationSec: 217,
    map: "Great Divide V1",
    gameSize: "8v8",
    sizeBytes: 8_400_000,
    settings: { lava: true },
    players: [{ ally: 0, count: 1, players: [{ name: "Uploader", os: 20 }] }],
    playerCount: 1,
    uploaderAlly: 0,
    uploads: null,
    view: "ally",
    widgetVersion: null,
    widgetSha: null,
    widgetDate: null,
    // Server-owned; a publisher's entry never carries them.
    placeholder: false,
    processing: false,
    ...over,
  };
}

test("gamesUnknown reports the ids the mirror has never recorded", async () => {
  await inIndex((index) => {
    expect(index.gamesUnknown(["a1", "b2", "c3"])).toEqual(["a1", "b2", "c3"]);
    index.gamesInsert([game("a1"), game("c3")]);
    // Only the genuinely new id survives, and the page's order is kept.
    expect(index.gamesUnknown(["a1", "b2", "c3"])).toEqual(["b2"]);
    expect(index.gamesUnknown([])).toEqual([]);
  });
});

test("gamesInsert stores the whole row", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([game("a1")]);
    const [r] = rows(sql, `SELECT * FROM games`);
    expect(r).toMatchObject({
      id: "a1",
      start_unix: 1787349909,
      duration_sec: 217,
      map: "Great Divide V1",
      map_file: "great_divide_v1",
      game_size: "1v1",
      preset: "duel",
      player_count: 2,
      engine_version: "2026.07.04",
      game_version: "Beyond All Reason test-31027-900131b",
    });
    expect(JSON.parse(r.players as string)).toHaveLength(2);
    expect(JSON.parse(r.settings as string)).toEqual({ unranked: true });
    assert(typeof r.synced_unix === "number" && r.synced_unix > 0, "synced_unix is stamped");
  });
});

test("gamesInsert indexes players and settings for the filters", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([game("a1")]);
    expect(rows(sql, `SELECT name, name_lower FROM replay_players WHERE replay_id = 'a1' ORDER BY name_lower`)).toEqual([
      { name: "LaufendeStahlwand", name_lower: "laufendestahlwand" },
      { name: "Rouben", name_lower: "rouben" },
    ]);
    expect(rows(sql, `SELECT flag FROM replay_settings WHERE replay_id = 'a1'`)).toEqual([{ flag: "unranked" }]);
  });
});

test("re-syncing a game refreshes it instead of failing or duplicating", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([game("a1")]);
    index.gamesInsert([
      game("a1", {
        map: "Isidis crack 1.1",
        preset: "team",
        settings: { lava: true },
        players: [{ ally: 0, count: 1, players: [{ name: "Someone" }] }],
      }),
    ]);
    expect(rows(sql, `SELECT COUNT(*) AS n FROM games`)).toEqual([{ n: 1 }]);
    expect(rows(sql, `SELECT map, preset FROM games`)).toEqual([{ map: "Isidis crack 1.1", preset: "team" }]);
    // The derived tables follow the row: the names and flags the game no
    // longer has must stop matching, which is why indexRow deletes first.
    expect(rows(sql, `SELECT name FROM replay_players WHERE replay_id = 'a1'`)).toEqual([{ name: "Someone" }]);
    expect(rows(sql, `SELECT flag FROM replay_settings WHERE replay_id = 'a1'`)).toEqual([{ flag: "lava" }]);
  });
});

test("a mirrored game never overwrites a published replay's derived rows", async () => {
  await inIndex((index, sql) => {
    // The same gameId in both tables: the catalog holds the capture somebody
    // published, the mirror holds BAR's account of the same game.
    index.upsert(replay("dup"));
    index.gamesInsert([game("dup")]);

    expect(rows(sql, `SELECT COUNT(*) AS n FROM games WHERE id = 'dup'`)).toEqual([{ n: 1 }]);
    // The catalog owns the entries: the roster is the uploader's, not the
    // API's, and the badge is the capture's. Without that rule the two would
    // take turns deleting each other's rows.
    expect(rows(sql, `SELECT name FROM replay_players WHERE replay_id = 'dup'`)).toEqual([{ name: "Uploader" }]);
    expect(rows(sql, `SELECT flag FROM replay_settings WHERE replay_id = 'dup'`)).toEqual([{ flag: "lava" }]);
  });
});

test("publishing a mirrored game takes ownership of its entries", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([game("later")]);
    expect(rows(sql, `SELECT COUNT(*) AS n FROM replay_players WHERE replay_id = 'later'`)).toEqual([{ n: 2 }]);

    index.upsert(replay("later"));

    expect(rows(sql, `SELECT name FROM replay_players WHERE replay_id = 'later'`)).toEqual([{ name: "Uploader" }]);
    expect(rows(sql, `SELECT flag FROM replay_settings WHERE replay_id = 'later'`)).toEqual([{ flag: "lava" }]);
  });
});

test("the filter bar's facets ignore games nothing has published", async () => {
  await inIndex((index) => {
    index.upsert(replay("published"));
    index.gamesInsert([game("mirrored")]);

    const f = index.facets();
    // The mirror is thousands of games with no listable replay behind them:
    // offering their names and flags would be offering filters that can only
    // produce an empty list.
    expect(f.players).toEqual(["Uploader"]);
    expect(f.settings).toEqual(["lava"]);
    // The catalog's own facets are unaffected.
    expect(f.maps).toEqual(["Great Divide V1"]);
    expect(f.sizes).toEqual([1]);
  });
});

test("the catalog list is blind to the mirror", async () => {
  await inIndex((index) => {
    index.gamesInsert([game("mirrored")]);
    expect(index.list()).toEqual([]);
    // Including through the derived tables the two now share: filtering by a
    // mirrored game's player must not surface it as a replay.
    expect(index.list({ from: null, to: null, map: null, minPlayers: null, maxPlayers: null, player: "rouben", settings: [] })).toEqual([]);
  });
});

// --- the idle re-sim poll: work invented from the games mirror --------------

/** jobsOffer needs a job id from its caller (the route passes a UUID); these
 * pass a readable one so a test can name the job it expects back. */
const OFFER = "job-1";

test("an idle re-sim poll queues the newest game nothing has published", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([
      game("older", { startUnix: 1000 }),
      game("newest", { startUnix: 3000 }),
      game("middle", { startUnix: 2000 }),
    ]);

    const offered = index.jobsOffer("resim", OFFER);

    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({ id: OFFER, gameId: "newest", kind: "resim", state: "pending" });
    // A re-sim has no archived stream to point at — the demo is the input.
    expect(offered[0].streamKey).toBe("");
    expect(rows(sql, `SELECT COUNT(*) AS n FROM jobs`)).toEqual([{ n: 1 }]);
  });
});

test("the backfill takes the biggest game among the newest candidates", async () => {
  await inIndex((index) => {
    index.gamesInsert([
      game("duel", { startUnix: 5000, gameSize: "1v1", playerCount: 2 }),
      game("team", { startUnix: 4000, gameSize: "8v8", playerCount: 16 }),
      game("small", { startUnix: 3000, gameSize: "2v2", playerCount: 4 }),
    ]);

    // Not the newest: an hour of engine time buys the 8v8 as cheaply as the
    // duel that happened to finish later.
    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "team" });
  });
});

test("the size preference is bounded by the recency window", async () => {
  await inIndex((index) => {
    // A 30v30 well outside the newest 20 candidates, and 20 duels in front of
    // it. The window is what keeps the daemon on recent games instead of
    // walking the whole archive biggest-first.
    index.gamesInsert([
      game("ancient-huge", { startUnix: 1000, playerCount: 60 }),
      ...Array.from({ length: 20 }, (_, i) => game(`recent-${i}`, { startUnix: 5000 + i, playerCount: 2 })),
    ]);

    // The 30v30 is out of the window entirely; among the 20 duels that are in
    // it, the tie goes to the newest.
    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "recent-19" });
  });
});

test("games of equal size are taken newest first", async () => {
  await inIndex((index) => {
    index.gamesInsert([
      game("older", { startUnix: 4000, playerCount: 16 }),
      game("newer", { startUnix: 5000, playerCount: 16 }),
    ]);
    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "newer" });
  });
});

test("a game with no roster is taken last, not first", async () => {
  await inIndex((index) => {
    // playerCount is null when the API's reply named nobody. Unknown must not
    // outrank a known 8v8 — nor be refused outright, since it is still a game.
    index.gamesInsert([
      game("unknown-size", { startUnix: 5000, playerCount: null, players: null }),
      game("known", { startUnix: 4000, playerCount: 16 }),
    ]);
    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "known" });
  });
});

test("the backfill passes over games that are already published", async () => {
  await inIndex((index) => {
    index.gamesInsert([game("published", { startUnix: 3000 }), game("bare", { startUnix: 2000 })]);
    index.upsert(replay("published"));

    // Re-simulating a game the catalog already holds would replace a capture
    // that exists with one that mostly repeats it.
    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "bare" });
  });
});

test("the backfill passes over a game that already has a job, failed ones included", async () => {
  await inIndex((index) => {
    index.gamesInsert([game("tried", { startUnix: 3000 }), game("fresh", { startUnix: 2000 })]);
    index.jobInsert("old-job", "", "tried", "resim");
    index.jobUpdate("old-job", "error", "engine died at frame 400");

    // The whole point of excluding finished jobs and not just live ones: a
    // game that cannot be re-simulated must not come back every poll, an hour
    // of engine time at a time. Pasting its link is still a retry.
    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "fresh" });
  });
});

test("the backfill passes over a modded game", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([
      game("modded", { startUnix: 3000, settings: { mods: true, ranked: true } }),
      // The modes that ship AS tweak blobs carry the same flag, so they are
      // out too — deliberately, since they are modded games.
      game("lava", { startUnix: 2500, settings: { lava: true, mods: true } }),
      game("vanilla", { startUnix: 2000, settings: { ranked: true } }),
    ]);

    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "vanilla" });
    // Nothing was queued for the modded ones, then or later.
    expect(rows(sql, `SELECT game_id FROM jobs`)).toEqual([{ game_id: "vanilla" }]);
  });
});

test("a game with no settings recorded at all is still eligible", async () => {
  await inIndex((index) => {
    // settings is null when the API's reply carried no gameSettings. There is
    // nothing to refuse it on, and treating unknown as modded would empty the
    // work list on a bad day at the API.
    index.gamesInsert([game("unknown", { settings: null })]);
    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "unknown" });
  });
});

test("a poll with pending work is left alone", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([game("candidate")]);
    index.jobInsert("requested", "", "somegame", "resim");

    expect(index.jobsOffer("resim", OFFER)).toEqual([expect.objectContaining({ id: "requested" })]);
    expect(rows(sql, `SELECT COUNT(*) AS n FROM jobs`)).toEqual([{ n: 1 }]);
  });
});

test("at most one auto-queued job is ever waiting", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([game("a", { startUnix: 3000 }), game("b", { startUnix: 2000 })]);

    const first = index.jobsOffer("resim", "job-1");
    const second = index.jobsOffer("resim", "job-2");

    // The second poll finds the job the first one made, rather than making
    // another — the backfill only fires into an empty pending list.
    expect(second).toEqual(first);
    expect(rows(sql, `SELECT COUNT(*) AS n FROM jobs`)).toEqual([{ n: 1 }]);
  });
});

test("an upload poll is never backfilled", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([game("candidate")]);
    // There is no stream to invent for a game nobody uploaded, so an idle
    // upload daemon stays idle.
    expect(index.jobsOffer("upload", OFFER)).toEqual([]);
    expect(rows(sql, `SELECT COUNT(*) AS n FROM jobs`)).toEqual([{ n: 0 }]);
  });
});

test("an idle poll with nothing to mirror returns nothing", async () => {
  await inIndex((index) => {
    expect(index.jobsOffer("resim", OFFER)).toEqual([]);
  });
});

// --- the catalog follows the pipeline: placeholder rows and the pill --------

test("claiming a job puts the game in the catalog, seeded from the mirror", async () => {
  await inIndex((index) => {
    index.gamesInsert([game("busy")]);
    index.jobInsert("j", "", "busy", "resim");

    expect(index.list()).toEqual([]);
    expect(index.jobClaim("j", "resim")).toBe(true);

    const [row] = index.list();
    // In the list while the work runs — and showing what the mirror knows,
    // rather than a row of dashes.
    expect(row).toMatchObject({
      id: "busy",
      map: "Great Divide V1",
      gameSize: "1v1",
      playerCount: 2,
      placeholder: true,
      processing: true,
    });
    expect(row.players).toHaveLength(2);
  });
});

test("reporting processing without claiming creates the row too", async () => {
  await inIndex((index) => {
    index.jobInsert("j", "streams/x", "uploading", "upload");
    index.jobUpdate("j", "processing", null);

    // No mirror row behind this one: an upload can be of a game the mirror has
    // never seen, and the row is worth having anyway.
    expect(index.list()).toMatchObject([{ id: "uploading", placeholder: true, processing: true, map: null }]);
  });
});

test("a heartbeat does not pile up rows", async () => {
  await inIndex((index) => {
    index.jobInsert("j", "", "busy", "resim");
    index.jobUpdate("j", "processing", null);
    index.jobUpdate("j", "processing", null);
    index.jobUpdate("j", "processing", null);
    expect(index.list()).toHaveLength(1);
  });
});

// The live progress column, whose whole behaviour is the CASE in jobUpdate's
// UPDATE: kept and refreshed while the job runs, kept when a beat carries none,
// and cleared by the terminal state.
test("progress follows the running job and goes out with it", async () => {
  await inIndex((index) => {
    index.jobInsert("j", "", "busy", "resim");
    index.jobUpdate("j", "processing", null, null, { state: "loading" });
    expect(index.jobGet("j")?.progress).toEqual({ state: "loading" });

    index.jobUpdate("j", "processing", null, null, { state: "simulating", percent: 12.5 });
    expect(index.jobGet("j")?.progress).toEqual({ state: "simulating", percent: 12.5 });

    // A beat with nothing to say keeps the last reading.
    index.jobUpdate("j", "processing", null);
    expect(index.jobGet("j")?.progress).toEqual({ state: "simulating", percent: 12.5 });

    // ...and finishing drops it, while the stats reported with it stay.
    index.jobUpdate("j", "done", null, { tookSec: 12 });
    expect(index.jobGet("j")?.progress).toBe(null);
    expect(index.jobGet("j")?.stats).toEqual({ tookSec: 12 });
  });
});

// Taking over a stale job must not inherit the dead daemon's last reading:
// "43%, 12 minutes left" from a run that is gone describes nothing.
test("claiming a job clears the previous holder's progress", async () => {
  await inIndex((index, sql) => {
    index.jobInsert("j", "", "busy", "resim");
    index.jobUpdate("j", "processing", null, null, { state: "simulating", percent: 43 });
    // Age it past the resim stale window so the claim is allowed.
    sql.exec(`UPDATE jobs SET updated_unix = updated_unix - ? WHERE id = 'j'`, 100 * 60);

    expect(index.jobClaim("j", "resim")).toBe(true);
    expect(index.jobGet("j")?.progress).toBe(null);
  });
});

// The healthcheck HISTORY: one row per beat, kept after the job ends (unlike
// the live progress, which is cleared) because a dead run's memory curve is
// exactly what nobody has otherwise.
test("every healthcheck is kept as a sample, and outlives the job", async () => {
  await inIndex((index, sql) => {
    index.jobInsert("j", "", "busy", "resim");
    for (let i = 0; i < 3; i++) {
      index.jobUpdate("j", "processing", null, null, {
        state: "simulating", frame: 1000 * i, percent: i, rssBytes: 1e9 + i, cpuPct: 500 + i,
      });
      // The worker stamps each beat with its own clock, and all three land in
      // the same second here. Age everything already recorded by a second so
      // the next beat has its own slot — otherwise they are one point, since
      // the (job, time) key makes a same-second beat an update.
      sql.exec(`UPDATE job_samples SET at_unix = at_unix - 1 WHERE job_id = 'j'`);
    }
    expect(index.jobSamples("j")).toHaveLength(3);

    index.jobUpdate("j", "error", "engine died", { tookSec: 2400 });
    expect(index.jobGet("j")?.progress).toBe(null);
    const kept = index.jobSamples("j");
    expect(kept).toHaveLength(3);
    expect(kept[0]).toMatchObject({ state: "simulating", frame: 0, rssBytes: 1e9 });
    expect(kept[2]).toMatchObject({ frame: 2000, cpuPct: 502 });
  });
});

// A beat retried inside the same second is the same reading, not a second
// point: the (job, time) key makes the insert idempotent.
test("a repeated beat in one second updates its sample instead of adding one", async () => {
  await inIndex((index) => {
    index.jobInsert("j", "", "busy", "resim");
    index.jobUpdate("j", "processing", null, null, { state: "loading", cpuPct: 1 });
    index.jobUpdate("j", "processing", null, null, { state: "simulating", cpuPct: 2 });
    const s = index.jobSamples("j");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ state: "simulating", cpuPct: 2 });
  });
});

// parseJobProgress is shallow on purpose — its fields were only ever displayed
// — but these land in typed SQL columns, so a field of the wrong type must
// become NULL rather than throw inside the bind and 500 the healthcheck.
test("a sample coerces wire junk to null instead of failing the beat", async () => {
  await inIndex((index) => {
    index.jobInsert("j", "", "busy", "resim");
    const bad = { state: 42, frame: {}, percent: "43", rssBytes: NaN, cpuPct: [1] };
    expect(index.jobUpdate("j", "processing", null, null, bad as never)).toBe(true);
    expect(index.jobSamples("j")[0]).toMatchObject({
      state: null, frame: null, percent: null, rssBytes: null, cpuPct: null,
    });
  });
});

// Past the cap the series is HALVED, not truncated: a run that beats for hours
// keeps its whole span (first and last sample survive) at half the resolution,
// where dropping the oldest would lose the load phase and refusing to record
// would lose the end — the part that says how it died.
test("a series past the cap is thinned, keeping its span", async () => {
  await inIndex((index, sql) => {
    index.jobInsert("j", "", "busy", "resim");
    // Seed just under the cap directly; driving 720 beats through jobUpdate
    // would be 720 catalog-placeholder writes as well.
    for (let i = 0; i < 720; i++) {
      sql.exec(`INSERT INTO job_samples (job_id, at_unix, percent) VALUES ('j', ?, ?)`, 1000 + i, i);
    }
    expect(index.jobSamples("j")).toHaveLength(720);

    index.jobUpdate("j", "processing", null, null, { state: "simulating", percent: 99 });
    const after = index.jobSamples("j");
    expect(after.length).toBeLessThan(400);
    expect(after.length).toBeGreaterThan(300);
    expect(after[0].atUnix).toBe(1000);
    expect(after[after.length - 1].percent).toBe(99);
  });
});

// The history outlives its job, so something has to age it out. Nothing else
// here grows without a rule.
test("pruning drops the samples of long-finished and vanished jobs", async () => {
  await inIndex((index, sql) => {
    index.jobInsert("old", "", "a", "resim");
    index.jobInsert("recent", "", "b", "resim");
    index.jobInsert("live", "", "c", "resim");
    for (const id of ["old", "recent", "live"]) {
      index.jobUpdate(id, "processing", null, null, { state: "simulating" });
    }
    index.jobUpdate("old", "done", null);
    index.jobUpdate("recent", "done", null);
    // Orphaned samples: a job row that is simply not there.
    sql.exec(`INSERT INTO job_samples (job_id, at_unix) VALUES ('gone', 1)`);

    const now = Math.floor(Date.now() / 1000);
    sql.exec(`UPDATE jobs SET updated_unix = ? WHERE id = 'old'`, now - 40 * 24 * 3600);

    expect(index.jobSamplePrune(now - 30 * 24 * 3600)).toBeGreaterThan(0);
    expect(index.jobSamples("old")).toHaveLength(0);
    expect(index.jobSamples("gone")).toHaveLength(0);
    expect(index.jobSamples("recent")).toHaveLength(1);
    expect(index.jobSamples("live")).toHaveLength(1);
  });
});

test("a published replay keeps its row and never becomes a placeholder", async () => {
  await inIndex((index) => {
    index.upsert(replay("real"));
    index.jobInsert("j", "", "real", "resim");
    index.jobClaim("j", "resim");

    // The row it already had, marked as being worked on — a re-sim of a game
    // with a one-sided upload stays openable the whole time.
    expect(index.list()).toMatchObject([{ id: "real", rid: "real-abcd1234", placeholder: false, processing: true }]);
  });
});

test("publishing turns the placeholder into an ordinary row", async () => {
  await inIndex((index) => {
    index.gamesInsert([game("done")]);
    index.jobInsert("j", "", "done", "resim");
    index.jobClaim("j", "resim");
    // The daemon publishes first and only then reports done, which is what
    // makes this the normal ending.
    index.upsert(replay("done"));
    index.jobUpdate("j", "done", null);

    expect(index.list()).toMatchObject([{ id: "done", placeholder: false, processing: false }]);
  });
});

test("a job that fails without publishing takes its row away again", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([game("doomed")]);
    index.jobInsert("j", "", "doomed", "resim");
    index.jobClaim("j", "resim");
    expect(index.list()).toHaveLength(1);

    index.jobUpdate("j", "error", "engine died at frame 400");

    // Otherwise every failed re-sim would leave a permanent dead entry in a
    // list of things you can play.
    expect(index.list()).toEqual([]);
    // The mirror row is untouched, and so are the derived entries it owns.
    expect(rows(sql, `SELECT COUNT(*) AS n FROM games`)).toEqual([{ n: 1 }]);
    expect(rows(sql, `SELECT COUNT(*) AS n FROM replay_players WHERE replay_id = 'doomed'`)).toEqual([{ n: 2 }]);
  });
});

test("the pill goes out with the job, whatever it was doing", async () => {
  await inIndex((index) => {
    index.upsert(replay("real"));
    index.jobInsert("j", "", "real", "resim");
    index.jobClaim("j", "resim");
    expect(index.list()[0].processing).toBe(true);

    index.jobUpdate("j", "error", "no");

    // Derived from the jobs table, so nothing had to remember to clear it.
    expect(index.list()[0]).toMatchObject({ id: "real", processing: false, placeholder: false });
  });
});

// The catalog scan's door into the job table: the same dedupe resimEnqueue
// does, without the catalog refusal that would reject every one of its
// candidates (they are all published — that is what makes them candidates).
test("announcing takes a game the catalog already holds", async () => {
  await inIndex((index) => {
    index.upsert(replay("onesided", { uploaderAlly: 1 }));
    // The open door refuses it, which is right for a person pasting a link.
    expect(index.resimEnqueue("a", "onesided").status).toBe("in-catalog");

    const first = index.jobAnnounce("b", "onesided", "resim");
    expect(first.status).toBe("queued");
    expect(first.job?.kind).toBe("resim");
    // Claiming it marks the existing catalog row as being worked on WITHOUT
    // turning it into a placeholder: a revision exists, so it stays openable.
    expect(index.jobClaim("b", "resim")).toBe(true);
    expect(index.list()).toMatchObject([{ id: "onesided", placeholder: false, processing: true }]);

    // A second daemon scanning the same catalog gets the same row back rather
    // than a second hour of engine time.
    expect(index.jobAnnounce("c", "onesided", "resim")).toMatchObject({ status: "duplicate", job: { id: "b" } });
    expect(index.jobClaim("c", "resim")).toBe(false);
  });
});

// A failed scan re-sim must not wedge the game: nothing else can retry it,
// since a scan candidate has no link for anyone to paste.
test("announcing again after a failure is how a scanned game is retried", async () => {
  await inIndex((index) => {
    index.upsert(replay("onesided", { uploaderAlly: 1 }));
    index.jobAnnounce("a", "onesided", "resim");
    index.jobUpdate("a", "error", "desynced");
    // The failure stays on its own row for a person to read...
    expect(index.jobGet("a")).toMatchObject({ state: "error", error: "desynced" });
    // ...and the published row it was upgrading is untouched by the failure.
    expect(index.list()).toMatchObject([{ id: "onesided", placeholder: false, processing: false }]);
    expect(index.jobAnnounce("b", "onesided", "resim").status).toBe("queued");
  });
});

test("a game being worked on is not 'already published' to a re-sim request", async () => {
  await inIndex((index) => {
    index.gamesInsert([game("busy")]);
    index.jobInsert("existing", "", "busy", "resim");
    index.jobClaim("existing", "resim");

    // The placeholder row must not make this look published: the honest
    // answer is the job already doing the work.
    const res = index.resimEnqueue("new", "busy");
    expect(res.status).toBe("duplicate");
    expect(res.job?.id).toBe("existing");
  });
});

// --- paging and the duration filter ----------------------------------------

test("list pages with limit/offset over the ordered listing", async () => {
  await inIndex((index) => {
    for (let i = 0; i < 7; i++) index.upsert(replay(`r${i}`, { startUnix: 1000 + i }));

    // Newest first, as the listing always is.
    expect(index.list(undefined, 3, 0).map((e) => e.id)).toEqual(["r6", "r5", "r4"]);
    expect(index.list(undefined, 3, 3).map((e) => e.id)).toEqual(["r3", "r2", "r1"]);
    // The front-end asks for one row MORE than it shows; a short answer is how
    // it learns there is no next page.
    expect(index.list(undefined, 3, 6).map((e) => e.id)).toEqual(["r0"]);
    expect(index.list(undefined, 3, 99)).toEqual([]);
    // No limit is the whole listing — what bringest's catalog scan asks for.
    expect(index.list()).toHaveLength(7);
    expect(index.list(undefined, 0, 0)).toHaveLength(7);
  });
});

test("paging applies to the filtered listing, not to the catalog", async () => {
  await inIndex((index) => {
    for (let i = 0; i < 6; i++) {
      index.upsert(replay(`m${i}`, { startUnix: 2000 + i, map: i % 2 ? "Wanted" : "Other" }));
    }
    const filter = { ...emptyFilter(), map: "Wanted" };
    // Three match; a page of two then leaves exactly one.
    expect(index.list(filter, 2, 0).map((e) => e.id)).toEqual(["m5", "m3"]);
    expect(index.list(filter, 2, 2).map((e) => e.id)).toEqual(["m1"]);
  });
});

test("the duration filter bounds are inclusive, and unknown lengths match neither", async () => {
  await inIndex((index) => {
    index.upsert(replay("short", { durationSec: 300 }));
    index.upsert(replay("medium", { durationSec: 1800 }));
    index.upsert(replay("long", { durationSec: 5400 }));
    index.upsert(replay("unknown", { durationSec: null }));

    const ids = (f: Partial<ReplayFilter>) =>
      index.list({ ...emptyFilter(), ...f }).map((e) => e.id).sort();

    expect(ids({ minDuration: 1800 })).toEqual(["long", "medium"]);
    expect(ids({ maxDuration: 1800 })).toEqual(["medium", "short"]);
    expect(ids({ minDuration: 600, maxDuration: 3600 })).toEqual(["medium"]);
    // An open top end is simply no maxDuration — which is what the slider
    // writes when its right thumb sits at an hour, so the 90-minute game is in.
    expect(ids({ minDuration: 1200 })).toEqual(["long", "medium"]);
    // A row that never recorded a length cannot be claimed to fall inside one.
    expect(ids({ minDuration: 0 })).not.toContain("unknown");
    expect(ids({})).toContain("unknown");
  });
});
