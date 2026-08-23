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

test("gamesInsert indexes settings; rosters stay JSON on the row", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([game("a1")]);
    // The settings entries feed the backfill's modded-first ranking. The
    // roster is deliberately NOT indexed anywhere — replay_players is gone
    // (indexing the mirror's rosters cost ~48 rows written per game, the
    // write half of the 2026-08-23 outage); the player filter reads the
    // roster JSON on the catalog rows directly.
    expect(rows(sql, `SELECT name FROM sqlite_master WHERE name = 'replay_players'`)).toEqual([]);
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
    // The derived table follows the row: the flags the game no longer has
    // must stop matching, which is why indexRow deletes first.
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
    // The catalog owns the entries: the badge is the capture's, not the
    // API's. Without that rule the two would take turns deleting each
    // other's rows.
    expect(rows(sql, `SELECT flag FROM replay_settings WHERE replay_id = 'dup'`)).toEqual([{ flag: "lava" }]);
  });
});

test("publishing a mirrored game takes ownership of its entries", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([game("later")]);
    expect(rows(sql, `SELECT flag FROM replay_settings WHERE replay_id = 'later'`)).toEqual([{ flag: "unranked" }]);

    index.upsert(replay("later"));

    expect(rows(sql, `SELECT flag FROM replay_settings WHERE replay_id = 'later'`)).toEqual([{ flag: "lava" }]);
  });
});

test("the maps list is maintained by publishes, not scanned per read", async () => {
  await inIndex((index, sql) => {
    index.upsert(replay("a", { map: "Great Divide V1" }));
    index.upsert(replay("b", { map: "All That Glitters v2" }));
    // A second publish of a known map adds nothing.
    index.upsert(replay("c", { map: "Great Divide V1" }));
    // The mirror is thousands of games with no listable replay behind them:
    // a mirrored game's map must not become a choice that filters to an
    // empty list.
    index.gamesInsert([game("mirrored", { map: "Mirror Only Map" })]);
    // A publish with no map has nothing to add.
    index.upsert(replay("d", { map: null }));

    expect(index.mapNames()).toEqual(["All That Glitters v2", "Great Divide V1"]);
    // The list is a maintained unique_values row, sorted, not a DISTINCT scan.
    expect(rows(sql, `SELECT value FROM unique_values WHERE key = 'maps'`)).toEqual([
      { value: JSON.stringify(["All That Glitters v2", "Great Divide V1"]) },
    ]);
  });
});

test("mapNames serves from memory between writes", async () => {
  await inIndex((index, sql) => {
    index.upsert(replay("a", { map: "Great Divide V1" }));
    expect(index.mapNames()).toEqual(["Great Divide V1"]);
    // Prove the cache answers: yank the table out from under it. (A minute's
    // staleness is the accepted worst case after an eviction; every write
    // path refreshes the copy, so a new map still shows up immediately.)
    sql.exec(`DELETE FROM unique_values`);
    expect(index.mapNames()).toEqual(["Great Divide V1"]);
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
    // A 30v30 well outside the 200 most recently ended candidates, and 200
    // duels in front of it. The window is what keeps the daemon on recent
    // games instead of walking the whole archive biggest-first.
    index.gamesInsert([
      game("ancient-huge", { startUnix: 1000, playerCount: 60 }),
      ...Array.from({ length: 200 }, (_, i) => game(`recent-${i}`, { startUnix: 500000 + i, playerCount: 2 })),
    ]);

    // The 30v30 is out of the window entirely; among the 200 duels that are
    // in it, the tie goes to the latest-ended.
    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "recent-199" });
  });
});

test("games of equal size are taken latest-ended first", async () => {
  await inIndex((index) => {
    index.gamesInsert([
      game("older", { startUnix: 4000, playerCount: 16 }),
      game("newer", { startUnix: 5000, playerCount: 16 }),
    ]);
    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "newer" });
  });
});

test("the window is ordered by when games ENDED, not when they started", async () => {
  await inIndex((index) => {
    // The mirror only learns a game once it is over, so end order is arrival
    // order: an hour-long game that started first but ended last is the
    // NEWEST thing in the mirror, not the oldest. Ordered by start it was
    // born buried under every shorter game that started after it — which is
    // exactly how an hour-long modded 16-player FFA kept losing to duels.
    index.gamesInsert([
      game("marathon", { startUnix: 1000, durationSec: 3600, playerCount: 2 }),
      game("quick-late", { startUnix: 4000, durationSec: 200, playerCount: 2 }),
    ]);
    // marathon ends at 4600, quick-late at 4200.
    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "marathon" });
  });
});

test("a game with no recorded duration still ranks by its start", async () => {
  await inIndex((index) => {
    // durationSec is null when the API never said; end time then degrades to
    // the start time instead of the row falling out of order entirely.
    index.gamesInsert([
      game("timed", { startUnix: 3000, durationSec: 500, playerCount: 2 }),
      game("untimed", { startUnix: 5000, durationSec: null, playerCount: 2 }),
    ]);
    // untimed counts as ending at 5000, after timed's 3500.
    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "untimed" });
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

test("the backfill takes a modded game first, ahead of a bigger one", async () => {
  await inIndex((index, sql) => {
    index.gamesInsert([
      // The biggest game on offer, and the one that would win on size alone.
      game("big", { startUnix: 3000, playerCount: 16, settings: { ranked: true } }),
      // A quarter the size, and picked before it: an 8v8 is one of forty
      // played this hour, where this is the only game of its kind today.
      game("modded", { startUnix: 2500, playerCount: 4, settings: { mods: true } }),
      // The modes that ship AS tweak blobs carry the same flag, so lava and
      // zombies games are preferred by the same rule.
      game("lava", { startUnix: 2000, playerCount: 2, settings: { lava: true, mods: true } }),
    ]);

    expect(index.jobsOffer("resim", OFFER)[0]).toMatchObject({ gameId: "modded" });
    // Then the other modded one, still before the 8v8. (No rest to wait out:
    // a scan that found something does not take the cooldown.)
    sql.exec(`UPDATE jobs SET state = 'done'`);
    expect(index.jobsOffer("resim", "offer-2")[0]).toMatchObject({ gameId: "lava" });
    // And only once they are gone does size decide again.
    sql.exec(`UPDATE jobs SET state = 'done'`);
    expect(index.jobsOffer("resim", "offer-3")[0]).toMatchObject({ gameId: "big" });
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
        state: "simulating", frame: 1000 * i, percent: i,
        rssBytes: 1e9 + i, swapBytes: i * 1024, cpuPct: 500 + i,
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
    expect(kept[2]).toMatchObject({ frame: 2000, cpuPct: 502, swapBytes: 2048 });
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
    const bad = { state: 42, frame: {}, percent: "43", rssBytes: NaN, swapBytes: "lots", cpuPct: [1] };
    expect(index.jobUpdate("j", "processing", null, null, bad as never)).toBe(true);
    expect(index.jobSamples("j")[0]).toMatchObject({
      state: null, frame: null, percent: null, rssBytes: null, swapBytes: null, cpuPct: null,
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
// The invariant the whole backfill exists for: while ANY mirrored game is
// unpublished, a poll gets one. It is not enough to be cheap — a scan that
// looks only at the newest slice of the mirror is cheapest of all, and reports
// an empty queue the moment the daemon has worked through that slice, with
// thousands of older games behind it and an engine host sitting idle in front
// of them.
test("the backfill reaches past the games it has already taken", async () => {
  await inIndex((index, sql) => {
    const now = 1787349909;
    for (let i = 0; i < 30; i++) {
      index.gamesInsert([game(`g${String(i).padStart(3, "0")}`, { startUnix: now - i * 60 })]);
    }
    // The newest 25 have all been through the pipeline already.
    for (let i = 0; i < 25; i++) {
      index.jobInsert(`j${i}`, "", `g${String(i).padStart(3, "0")}`, "resim");
      sql.exec(`UPDATE jobs SET state = 'done' WHERE id = ?`, `j${i}`);
    }
    // So the next one offered is the newest of what is LEFT, not nothing.
    expect(index.jobsOffer("resim", "j-next").map((j) => j.gameId)).toEqual(["g025"]);
  });
});

// The backfill's pacing IS the host's pacing: a game it does not hand out is an
// engine sitting idle. So it rests only when it has nothing — resting after a
// successful queue put the deployment on a strict five-minute grid for jobs
// that take ninety seconds, which is most of an engine host's day spent
// waiting for a clock.
test("the backfill hands out the next game at once, and rests only when empty", async () => {
  await inIndex((index, sql) => {
    for (const id of ["g1", "g2"]) {
      index.gamesInsert([game(id, { startUnix: 1787349909 })]);
    }
    // One game, taken and finished, exactly as a daemon works through it.
    expect(index.jobsOffer("resim", "j-1").map((j) => [j.id, j.gameId])).toEqual([["j-1", "g1"]]);
    index.jobClaim("j-1", "resim");
    index.jobUpdate("j-1", "done", null);

    // The next poll gets the other game immediately — no cooldown was taken by
    // a scan that found work, because the daemon stopped asking while it ran.
    expect(index.jobsOffer("resim", "j-2").map((j) => j.gameId)).toEqual(["g2"]);
    index.jobClaim("j-2", "resim");
    index.jobUpdate("j-2", "done", null);

    // Now the mirror is exhausted: THIS is the answer a poll would repeat
    // every ten seconds forever, so it is the one that rests.
    expect(index.jobsOffer("resim", "j-3")).toEqual([]);
    index.gamesInsert([game("g3", { startUnix: 1787349909 })]);
    expect(index.jobsOffer("resim", "j-4")).toEqual([]);
    // ...until the rest is over.
    sql.exec(`UPDATE schema_meta SET value = 0 WHERE key = 'backfill_after'`);
    expect(index.jobsOffer("resim", "j-5").map((j) => j.gameId)).toEqual(["g3"]);
  });
});

// The pipeline's third door, and the one nobody has to open: a publish that
// leaves a game one-sided QUEUES its own re-simulation. This is what replaced
// the re-sim daemon listing the whole catalog on a timer and applying the same
// predicate to every row — same games, told once instead of hunted for.
test("a one-sided publish queues the game's re-simulation", async () => {
  await inIndex((index) => {
    index.upsert(replay("onesided", { uploaderAlly: 1, view: "ally" }), "rj-1");
    const queued = index.jobsPending("resim");
    expect(queued.map((j) => [j.id, j.gameId, j.kind])).toEqual([["rj-1", "onesided", "resim"]]);

    // A SECOND upload of the same game — the other teammate's — adds nothing:
    // one hour of engine time answers both.
    index.upsert(replay("onesided", { rid: "onesided-22222222", uploaderAlly: 0 }), "rj-2");
    expect(index.jobsPending("resim").map((j) => j.id)).toEqual(["rj-1"]);

    // And the re-simulation's OWN publish does not queue another: it declares
    // the full view, which is what the game was missing.
    index.upsert(replay("onesided", { rid: "onesided-fefefefe", uploaderAlly: null, view: "full" }), "rj-3");
    expect(index.jobsPending("resim").map((j) => j.id)).toEqual(["rj-1"]);
  });
});

test("a full-view publish queues nothing, and neither does a row that cannot say", async () => {
  await inIndex((index) => {
    // A spectator's upload: it saw everything already.
    index.upsert(replay("spect", { uploaderAlly: null, view: "full" }), "rj-1");
    // A publish with no recorder provenance at all — most of the catalog, from
    // before the GAME record carried it. "Unknown" is not "ally": guessing here
    // would spend an hour of engine time on a game that may not need it.
    index.upsert(replay("silent", { uploaderAlly: null, view: null }), "rj-2");
    // And a publisher that never wants a re-sim queued simply omits the id.
    index.upsert(replay("noid", { uploaderAlly: 1 }));
    expect(index.jobsPending("resim")).toEqual([]);
  });
});

test("pruning drops the samples of long-finished jobs, once", async () => {
  await inIndex((index, sql) => {
    index.jobInsert("old", "", "a", "resim");
    index.jobInsert("recent", "", "b", "resim");
    index.jobInsert("live", "", "c", "resim");
    for (const id of ["old", "recent", "live"]) {
      index.jobUpdate(id, "processing", null, null, { state: "simulating" });
    }
    index.jobUpdate("old", "done", null);
    index.jobUpdate("recent", "done", null);

    const now = Math.floor(Date.now() / 1000);
    sql.exec(`UPDATE jobs SET updated_unix = ? WHERE id = 'old'`, now - 40 * 24 * 3600);

    expect(index.jobSamplePrune(now - 30 * 24 * 3600)).toBeGreaterThan(0);
    expect(index.jobSamples("old")).toHaveLength(0);
    expect(index.jobSamples("recent")).toHaveLength(1);
    expect(index.jobSamples("live")).toHaveLength(1);
    // The watermark: a second run over the same cutoff visits nothing, which
    // is what keeps the sweep from re-probing every job it has ever pruned for
    // the life of the deployment.
    expect(index.jobSamplePrune(now - 30 * 24 * 3600)).toBe(0);
    // A job is visited on the run whose cutoff crosses the moment it finished
    // — which for `recent`, finished just now, is a cutoff a month from now.
    expect(index.jobSamplePrune(now + 60)).toBeGreaterThan(0);
    expect(index.jobSamples("recent")).toHaveLength(0);
    expect(index.jobSamples("live")).toHaveLength(1);
  });
});

// Holding a job back. The half that is easy to miss: a RUNNING job has to be
// reset, because nothing here can stop the daemon — leaving the row claimed
// would just mean waiting out the stale window before it was handed out again.
test("disabling a job stops it being offered and resets a running one", async () => {
  await inIndex((index) => {
    index.jobInsert("j", "", "busy", "resim");
    index.jobClaim("j", "resim");
    index.jobUpdate("j", "processing", null, null, { state: "simulating", percent: 20 });
    expect(index.list()).toMatchObject([{ id: "busy", processing: true, placeholder: true }]);

    expect(index.jobSetDisabled("j", true)).toBe(true);
    const j = index.jobGet("j");
    expect(j).toMatchObject({ disabled: true, state: "pending", progress: null });
    expect(index.jobsPending("resim")).toEqual([]);
    expect(index.jobClaim("j", "resim")).toBe(false);
    // Nothing is being worked on, and nothing was published: the row that only
    // existed to show the work must not linger in the replay list.
    expect(index.list()).toEqual([]);
    // The samples stay — they are the record of work that really happened, and
    // the charts are the reason to look at a job you had to turn off.
    expect(index.jobSamples("j")).toHaveLength(1);

    expect(index.jobSetDisabled("j", false)).toBe(true);
    expect(index.jobsPending("resim")).toHaveLength(1);
    expect(index.jobSetDisabled("nope", true)).toBe(false);
  });
});

// A daemon that was mid-run keeps beating until its engine stops. Those beats
// must not put the row back into "processing" a second after it was reset —
// but the outcome, when it finally lands, is still worth recording.
test("a disabled job ignores heartbeats but still records how it ended", async () => {
  await inIndex((index) => {
    index.jobInsert("j", "", "busy", "resim");
    index.jobClaim("j", "resim");
    index.jobSetDisabled("j", true);

    index.jobUpdate("j", "processing", null, null, { state: "simulating", percent: 55 });
    expect(index.jobGet("j")).toMatchObject({ state: "pending", progress: null });
    expect(index.jobSamples("j")).toHaveLength(0);

    index.jobUpdate("j", "done", null, { tookSec: 2400 });
    expect(index.jobGet("j")).toMatchObject({ state: "done", stats: { tookSec: 2400 } });
  });
});

// The mirror backfill hands out games with no job row of ANY state, so a
// disabled row is what keeps a game it names out of the auto-queue for good.
test("a disabled job keeps its game out of the mirror backfill", async () => {
  await inIndex((index) => {
    index.gamesInsert([game("keepout"), game("fine")]);
    index.jobInsert("j", "", "keepout", "resim");
    index.jobSetDisabled("j", true);
    const offered = index.jobsOffer("resim", "new-1");
    expect(offered).toHaveLength(1);
    expect(offered[0].gameId).toBe("fine");
  });
});

// The jobs table knows a gameId and nothing else about the game, so the queue
// joins the duration and the team spec off whichever table knows them. This is
// real SQL over three tables that all have an `id` and two of which have an
// `updated_unix`, so it is also the test that the ORDER BY is qualified — an
// unqualified column there is an ambiguous-column ERROR, not a wrong answer.
test("queue rows join the game's size and duration from either table", async () => {
  await inIndex((index) => {
    // Published: the catalog knows it.
    index.upsert(replay("captured", { durationSec: 2417, gameSize: "8v8" }));
    index.jobInsert("j1", "", "captured", "resim");
    // Never uploaded: only the mirror knows it, which is most of this queue.
    index.gamesInsert([game("mirrored", { durationSec: 217, gameSize: "1v1" })]);
    index.jobInsert("j2", "", "mirrored", "resim");
    // Neither knows it: a drag&drop upload from a private lobby.
    index.jobInsert("j3", "streams/x", "stranger");

    const byId = Object.fromEntries(index.queuePage(25, 0).jobs.map((j) => [j.id, j]));
    expect(byId.j1.game).toEqual({ durationSec: 2417, gameSize: "8v8" });
    expect(byId.j2.game).toEqual({ durationSec: 217, gameSize: "1v1" });
    expect(byId.j3.game).toBe(null);
    // The job's own fields survive the join unqualified-name-for-unqualified-name.
    expect(byId.j3).toMatchObject({ streamKey: "streams/x", kind: "upload", state: "pending" });
  });
});

// A game the catalog and the mirror both hold: the catalog wins, because it
// describes what was actually captured.
test("the catalog's own numbers beat the mirror's", async () => {
  await inIndex((index) => {
    index.gamesInsert([game("both", { durationSec: 100, gameSize: "1v1" })]);
    index.upsert(replay("both", { durationSec: 2417, gameSize: "8v8" }));
    index.jobInsert("j", "", "both", "resim");
    expect(index.queuePage(25, 0).jobs[0].game).toEqual({ durationSec: 2417, gameSize: "8v8" });
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
    expect(rows(sql, `SELECT flag FROM replay_settings WHERE replay_id = 'doomed'`)).toEqual([{ flag: "unranked" }]);
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

// Searching by the game's own id: the whole thing, or the head of one out of a
// link or a log line.
test("the id filter matches a whole id and a prefix, and nothing else", async () => {
  await inIndex((index) => {
    const full = "92488a6a2807186a199996b9a0712fa5";
    index.upsert(replay(full, { startUnix: 3000 }));
    index.upsert(replay("92488a6a2807186a199996b9a0712fff", { startUnix: 2000 }));
    index.upsert(replay("ffffffffffffffffffffffffffffffff", { startUnix: 1000 }));

    const ids = (f: Partial<ReplayFilter>) => index.list({ ...emptyFilter(), ...f }).map((e) => e.id);
    expect(ids({ id: full })).toEqual([full]);
    // The shared head of the two, which is most of an id: both, newest first.
    expect(ids({ id: "92488a6a2807186a199996b9a0712f" })).toEqual([full, "92488a6a2807186a199996b9a0712fff"]);
    expect(ids({ id: "92" })).toEqual([full, "92488a6a2807186a199996b9a0712fff"]);
    // The upper bound of the range must not swallow the rest of the catalog.
    expect(ids({ id: "9" })).not.toContain("ffffffffffffffffffffffffffffffff");
    expect(ids({ id: "0000" })).toEqual([]);
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

// ---- The teiserver lobby poll's SQL half (teiserver.ts holds the logic) ----

test("teiserver session jar round-trips through one row", async () => {
  await inIndex((index, sql) => {
    expect(index.teiserverCookies()).toBeNull();
    index.teiserverCookiesPut({ guardian_default_token: "g1", _teiserver_key: "s1" });
    expect(index.teiserverCookies()).toEqual({ guardian_default_token: "g1", _teiserver_key: "s1" });
    // A later login replaces the jar wholesale — and stays ONE row.
    index.teiserverCookiesPut({ guardian_default_token: "g2" });
    expect(index.teiserverCookies()).toEqual({ guardian_default_token: "g2" });
    expect(rows(sql, `SELECT COUNT(*) AS n FROM teiserver_session`)[0].n).toBe(1);
  });
});

test("lobby observations open, back-date, close, and reuse the lobby id", async () => {
  await inIndex((index, sql) => {
    expect(index.lobbiesOpen()).toEqual([]);
    index.lobbiesObserve([
      { lobbyId: 7, name: "First Game", map: "Great Divide V1", players: ["A"], playerCount: 1, elapsedSec: 120 },
    ]);
    const open = index.lobbiesOpen();
    expect(open.length).toBe(1);
    expect(open[0].lobbyId).toBe(7);
    // started_unix is back-dated by the page's running clock.
    const now = Math.floor(Date.now() / 1000);
    expect(now - open[0].startedUnix).toBeGreaterThanOrEqual(120);
    expect(now - open[0].startedUnix).toBeLessThanOrEqual(125);
    // Closing frees the id; a fresh game in the same lobby is a SECOND row.
    index.lobbiesEnd([7]);
    expect(index.lobbiesOpen()).toEqual([]);
    index.lobbiesObserve([
      { lobbyId: 7, name: "Second Game", map: "Great Divide V1", players: null, playerCount: 2, elapsedSec: 0 },
    ]);
    expect(index.lobbiesOpen().length).toBe(1);
    expect(rows(sql, `SELECT COUNT(*) AS n FROM lobbies WHERE lobby_id = 7`)[0].n).toBe(2);
    // Ending an id with no open observation is a no-op, not an error.
    index.lobbiesEnd([7]);
    index.lobbiesEnd([7]);
    expect(rows(sql, `SELECT COUNT(*) AS n FROM lobbies WHERE ended_unix IS NULL`)[0].n).toBe(0);
  });
});

test("lobbiesMatch names the game and survives a re-sync", async () => {
  await inIndex((index, sql) => {
    index.lobbiesObserve([
      {
        lobbyId: 42,
        name: "Chillmus most welcome | 8v8",
        map: "Great Divide V1",
        players: ["ROUBEN", "laufendestahlwand"],
        playerCount: 2,
        elapsedSec: 30,
      },
    ]);
    const started = rows(sql, `SELECT started_unix FROM lobbies WHERE lobby_id = 42`)[0].started_unix as number;
    // The game as rts-api will eventually report it: started just before the
    // observation, same map, same players (case differing).
    index.gamesInsert([game("g42", { startUnix: started - 10 })]);
    expect(index.lobbiesMatch()).toEqual({ matched: 1, pruned: 0 });
    const g = rows(sql, `SELECT lobby_name, lobby_id FROM games WHERE id = 'g42'`)[0];
    expect(g.lobby_name).toBe("Chillmus most welcome | 8v8");
    expect(g.lobby_id).toBe(42);
    expect(rows(sql, `SELECT matched_game_id FROM lobbies WHERE lobby_id = 42`)[0].matched_game_id).toBe("g42");
    // Matching RETIRES the observation even though the page diff never closed
    // it (the lobby may be running its next game already): it leaves the open
    // set, so the next sync tick opens a FRESH entry for the same lobby id —
    // one lobby names game after game, one row per game.
    expect(index.lobbiesOpen()).toEqual([]);
    expect(rows(sql, `SELECT ended_unix FROM lobbies WHERE lobby_id = 42`)[0].ended_unix).not.toBeNull();
    index.lobbiesObserve([
      { lobbyId: 42, name: "Chillmus renamed", map: "Otago 1.43", players: null, playerCount: 16, elapsedSec: 0 },
    ]);
    expect(index.lobbiesOpen().length).toBe(1);
    expect(rows(sql, `SELECT COUNT(*) AS n FROM lobbies WHERE lobby_id = 42`)[0].n).toBe(2);
    // Nothing left to match (the fresh observation has no candidate game);
    // the write is not repeated.
    expect(index.lobbiesMatch()).toEqual({ matched: 0, pruned: 0 });
    // A later re-sync of the game (regression: lobby_name is NOT in the
    // upsert's column list) keeps the name the match wrote.
    index.gamesInsert([game("g42", { startUnix: started - 10 })]);
    expect(rows(sql, `SELECT lobby_name FROM games WHERE id = 'g42'`)[0].lobby_name).toBe(
      "Chillmus most welcome | 8v8",
    );
  });
});

// Matching is ARRIVAL-DRIVEN: a run considers the games mirrored since the
// last one, not every unnamed game an observation could still reach. That is
// the whole cost of the step (the alternative re-reads a slice of the mirror
// as old as the oldest observation, every minute, forever), and it loses
// nothing: the observation is always the older of the two — it is opened while
// the lobby is still PLAYING the game, and the game reaches rts-api only once
// it has ended — so a game that did not match on the tick it landed has
// nothing new to match against on the next one.
test("lobbiesMatch considers the games mirrored since its last run", async () => {
  await inIndex((index, sql) => {
    const now = Math.floor(Date.now() / 1000);
    index.gamesInsert([game("g1", { startUnix: now })]);
    // Mirrored ten minutes ago; the run below is what moves the watermark past
    // it. (Ordering the other way round — the game first, its lobby seen
    // afterwards — cannot happen for real; it is how the test says "this game
    // is no longer an arrival".)
    sql.exec(`UPDATE games SET synced_unix = ? WHERE id = 'g1'`, now - 600);
    expect(index.lobbiesMatch()).toEqual({ matched: 0, pruned: 0 });
    index.lobbiesObserve([
      { lobbyId: 7, name: "Late observation", map: "Great Divide V1", players: null, playerCount: 8, elapsedSec: 0 },
    ]);
    expect(index.lobbiesMatch()).toEqual({ matched: 0, pruned: 0 });
    expect(rows(sql, `SELECT lobby_name FROM games WHERE id = 'g1'`)[0].lobby_name).toBeNull();
  });
});

test("lobbiesMatch leaves an already-named game and a wrong-map lobby alone", async () => {
  await inIndex((index, sql) => {
    index.lobbiesObserve([
      { lobbyId: 1, name: "Wrong Map Lobby", map: "Otago 1.43", players: ["Rouben"], playerCount: 1, elapsedSec: 0 },
    ]);
    const started = rows(sql, `SELECT started_unix FROM lobbies WHERE lobby_id = 1`)[0].started_unix as number;
    index.gamesInsert([game("named", { startUnix: started - 5 })]);
    sql.exec(`UPDATE games SET lobby_name = 'Existing Name', lobby_id = 99 WHERE id = 'named'`);
    expect(index.lobbiesMatch()).toEqual({ matched: 0, pruned: 0 });
    expect(rows(sql, `SELECT lobby_name FROM games WHERE id = 'named'`)[0].lobby_name).toBe("Existing Name");
    expect(rows(sql, `SELECT matched_game_id FROM lobbies WHERE lobby_id = 1`)[0].matched_game_id).toBeNull();
  });
});

test("lobbiesMatch prunes old matched observations and keeps unmatched ones forever", async () => {
  await inIndex((index, sql) => {
    const old = Math.floor(Date.now() / 1000) - 49 * 3600;
    sql.exec(
      `INSERT INTO lobbies (lobby_id, started_unix, name, map, players, player_count, ended_unix, matched_game_id)
       VALUES (1, ?, 'old matched', 'M', NULL, NULL, ?, 'gX'),
              (2, ?, 'old unmatched', 'M', NULL, NULL, ?, NULL)`,
      old,
      old + 60,
      old,
      old + 60,
    );
    expect(index.lobbiesMatch()).toEqual({ matched: 0, pruned: 1 });
    expect(rows(sql, `SELECT name FROM lobbies ORDER BY lobby_id`).map((r) => r.name)).toEqual(["old unmatched"]);
  });
});

test("list joins the lobby name from the games mirror", async () => {
  await inIndex((index, sql) => {
    index.upsert(replay("both"));
    index.upsert(replay("alone"));
    // The teiserver poll matched "both"'s game and named it.
    index.gamesInsert([game("both")]);
    sql.exec(`UPDATE games SET lobby_name = 'Chillmus | 8v8' WHERE id = 'both'`);
    const byId = new Map(index.list().map((e) => [e.id, e]));
    expect(byId.get("both")?.lobbyName).toBe("Chillmus | 8v8");
    // map_file rides the same join: the archive name behind the list's
    // terrain thumbnails, known only to the mirror.
    expect(byId.get("both")?.mapFile).toBe("great_divide_v1");
    // A replay with no mirror row (or an unnamed one) reads null, not absent —
    // the key's presence is how the front-end tells this backend from the Go
    // server, which omits it wholesale.
    expect(byId.get("alone")?.lobbyName).toBeNull();
    expect(byId.get("alone")?.mapFile).toBeNull();
  });
});

test("list surfaces the processing job's live percent for the pill", async () => {
  await inIndex((index) => {
    index.upsert(replay("busy"));
    index.jobInsert("j", "", "busy", "resim");
    index.jobUpdate("j", "processing", null);
    // Processing but nothing measurable yet (download, provisioning, load).
    expect(index.list()).toMatchObject([{ id: "busy", processing: true, processingPercent: null }]);
    index.jobUpdate("j", "processing", null, null, { state: "simulating", percent: 52.4 });
    expect(index.list()).toMatchObject([{ id: "busy", processing: true, processingPercent: 52 }]);
    // The job ending clears both: processing is derived, progress is wiped.
    index.jobUpdate("j", "done", null);
    expect(index.list()).toMatchObject([{ id: "busy", processing: false, processingPercent: null }]);
  });
});

test("a current schema is detected read-only and a stale one still migrates", async () => {
  // The constructor's DDL used to run unconditionally, and CREATE TABLE IF
  // NOT EXISTS counts as a WRITE even when it changes nothing — so the day
  // the free tier's rows-written allowance ran out, every route died in the
  // constructor before its first read. The contract now: deciding "nothing
  // to migrate" is ONE read of the schema_version stamp and zero writes; a
  // stale or missing stamp is noticed and the migration restores it.
  await inIndex((index, sql) => {
    const priv = index as unknown as { schemaCurrent(): boolean; migrateSchema(): void };
    expect(priv.schemaCurrent(), "a freshly constructed instance is current").toBe(true);

    // The whole no-migration decision, as the constructor takes it, measured:
    // reads only.
    const real = sql.exec.bind(sql);
    let written = 0;
    (sql as unknown as { exec: unknown }).exec = (q: string, ...args: unknown[]) => {
      const cur = real(q, ...(args as string[]));
      const out = cur.toArray();
      written += cur.rowsWritten;
      return { toArray: () => out, rowsWritten: cur.rowsWritten, rowsRead: cur.rowsRead };
    };
    try {
      expect(priv.schemaCurrent()).toBe(true);
      expect(written, "deciding there is nothing to migrate must not write").toBe(0);
    } finally {
      (sql as unknown as { exec: unknown }).exec = real;
    }

    // An old stamp means migrate; so does no stamp at all — "no such table"
    // is the signal a pre-stamp database gives, not an error.
    sql.exec(`UPDATE schema_version SET version = 0`);
    expect(priv.schemaCurrent(), "an old stamp must be noticed").toBe(false);
    priv.migrateSchema();
    expect(priv.schemaCurrent()).toBe(true);

    sql.exec(`DROP TABLE schema_version`);
    expect(priv.schemaCurrent(), "a missing stamp table means a pre-stamp database").toBe(false);
    priv.migrateSchema();
    expect(priv.schemaCurrent()).toBe(true);
  });
});

test("a migration that cannot run leaves the previous schema serving", async () => {
  // The live incident: with the write allowance spent, creating the new index
  // was a real write and threw — and failing the construction took every READ
  // down for a performance optimization. ensureSchema must log and serve on;
  // the next instantiation retries.
  await inIndex((index, sql) => {
    const priv = index as unknown as {
      ensureSchema(): void;
      schemaCurrent(): boolean;
      migrateSchema(): void;
    };
    sql.exec(`UPDATE schema_version SET version = 0`);
    const proto = Object.getPrototypeOf(index) as { migrateSchema(): void };
    const realMigrate = proto.migrateSchema;
    proto.migrateSchema = () => {
      throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
    };
    const realError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => logged.push(args.join(" "));
    try {
      priv.ensureSchema();
    } finally {
      proto.migrateSchema = realMigrate;
      console.error = realError;
    }
    expect(logged.join("\n")).toContain("Exceeded allowed rows written");
    // Reads still work on the previous schema…
    expect(index.list(emptyFilter(), 10, 0)).toEqual([]);
    // …and the retry brings it current once the migration can run.
    expect(priv.schemaCurrent()).toBe(false);
    priv.ensureSchema();
    expect(priv.schemaCurrent()).toBe(true);
  });
});

test("a failing schema check or derived rebuild never kills construction", async () => {
  // The overage gate spares no statement — even schemaCurrent's read of
  // sqlite_master threw "Exceeded allowed rows written" live. Every
  // constructor step must log and serve on, so the request fails (if it
  // fails) in the route's own query, which the worker log can attribute.
  await inIndex((index, sql) => {
    const priv = index as unknown as { ensureSchema(): void; ensureDerived(): void };
    const proto = Object.getPrototypeOf(index) as Record<string, unknown>;
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => logged.push(args.join(" "));
    try {
      const realCurrent = proto.schemaCurrent;
      proto.schemaCurrent = () => {
        throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
      };
      try {
        priv.ensureSchema();
      } finally {
        proto.schemaCurrent = realCurrent;
      }
      expect(logged.join("\n")).toContain("schema check failed");

      // A derived rebuild that cannot even read its version row (the overage
      // gate again) logs and serves on; once the world is back, the retry
      // stamps the version.
      sql.exec(`DELETE FROM schema_meta WHERE key = 'derived_version'`);
      sql.exec(`ALTER TABLE schema_meta RENAME TO schema_meta_hidden`);
      try {
        priv.ensureDerived();
      } finally {
        sql.exec(`ALTER TABLE schema_meta_hidden RENAME TO schema_meta`);
      }
      expect(logged.join("\n")).toContain("derived rebuild failed");
      expect(rows(sql, `SELECT value FROM schema_meta WHERE key = 'derived_version'`)).toEqual([]);
      priv.ensureDerived();
      expect(rows(sql, `SELECT value FROM schema_meta WHERE key = 'derived_version'`)).not.toEqual([]);
    } finally {
      console.error = realError;
    }
  });
});

test("the player filter reads the roster JSON directly", async () => {
  await inIndex((index) => {
    index.upsert(replay("r1"));
    index.gamesInsert([game("m1")]);
    // Prefix, case-insensitively, like the old name_lower range did.
    expect(index.list({ ...emptyFilter(), player: "upload" })).toHaveLength(1);
    expect(index.list({ ...emptyFilter(), player: "nobody" })).toEqual([]);
    // A LIKE wildcard in the needle is a literal, not a wildcard.
    expect(index.list({ ...emptyFilter(), player: "%" })).toEqual([]);
  });
});

test("sql accounting bills each row to the outermost public method", async () => {
  await inIndex((index) => {
    index.upsert(replay("s1"));
    index.list({ ...emptyFilter() }, 10, 0);

    const report = index.sqlStatsReport();
    expect(report.since).toBeGreaterThan(0);
    expect(report.elapsedSec).toBeGreaterThanOrEqual(0);
    const ops = Object.fromEntries(report.ops.map((o) => [o.op, o]));
    expect(ops.upsert.calls).toBe(1);
    expect(ops.upsert.rowsWritten).toBeGreaterThan(0);
    expect(ops.list.rowsRead).toBeGreaterThan(0);
    // A helper a method calls bills its caller — the endpoint's-eye view.
    expect(ops.indexSettings).toBeUndefined();
    // The constructor's own steps are visible too.
    expect(ops.ensureSchema).toBeDefined();

    // Asking is free: the report itself writes nothing.
    const written = index.sqlStatsReport().totals.rowsWritten;
    expect(index.sqlStatsReport().totals.rowsWritten).toBe(written);
  });
});

test("attribution holds over real RPC, not only direct calls", async () => {
  // The first accounting version shadowed methods with instance properties:
  // the deployed runtime refused those RPC calls outright ("The RPC receiver
  // does not implement the method") while the local one silently bypassed
  // them — two failures no direct-call test can see. So this one talks to
  // the stub exactly like the worker does.
  const stub = env.REPLAY_INDEX.get(env.REPLAY_INDEX.idFromName("rpc-attribution"));
  await stub.list(emptyFilter(), 10, 0);
  const report = await stub.sqlStatsReport();
  const ops = Object.fromEntries(report.ops.map((o: { op: string }) => [o.op, o]));
  expect(ops.list?.calls).toBe(1);
  expect(ops["(outside any method)"], "every statement has a method to bill").toBeUndefined();
});
