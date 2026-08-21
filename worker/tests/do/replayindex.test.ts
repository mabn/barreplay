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
import type { ReplayEntry } from "../../src/worker/replayentry";

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
