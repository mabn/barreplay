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
