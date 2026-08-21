// Drives the games mirror (src/worker/games.ts) against a fake BAR API and a
// fake index. Like the upload-route tests, the Durable Object's SQL is out of
// node's reach, so the index is an in-memory stand-in for the two RPC methods
// the sync uses; what is exercised here is everything else — which URLs are
// called, which games earn a detail fetch, and what a row ends up holding.
import assert from "node:assert/strict";
import test from "node:test";

import { GAMES_QUERY, gameFromApi, gameSizeSpec, syncGames } from "../src/worker/games";
import type { GameEntry } from "../src/worker/games";

const LIST_URL = `https://api.bar-rts.com/replays?${GAMES_QUERY}`;

// One /replays/<id> detail reply, shaped like the real API's.
function detail(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    startTime: "2026-08-21T21:38:50.000Z",
    durationMs: 586700,
    engineVersion: "2026.07.04",
    gameVersion: "Beyond All Reason test-31027-900131b",
    preset: "duel",
    Map: { scriptName: "Isidis crack 1.1", fileName: "isidis_crack_1.1", width: 14, height: 14 },
    gameSettings: { zombies: "disabled", ranked_game: "1", startmetal: "1000" },
    AllyTeams: [
      { allyTeamId: 0, winningTeam: false, Players: [{ name: "nonsemantic", skill: "[24.5]" }], AIs: [] },
      { allyTeamId: 1, winningTeam: true, Players: [{ name: "TehHardStuck", skill: "[25.1]" }], AIs: [] },
    ],
    ...over,
  };
}

/** A fetch stand-in serving a page of ids plus each game's detail. Records
 * every URL it was asked for, which is how the "only new games cost a fetch"
 * claims below are checked. */
function fakeFetch(ids: string[], details: Record<string, unknown | Error> = {}) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url === LIST_URL) {
      return new Response(JSON.stringify({ totalResults: -1, page: 1, limit: 24, data: ids.map((id) => ({ id })) }));
    }
    const id = url.slice(url.lastIndexOf("/") + 1);
    const d = id in details ? details[id] : detail(id);
    if (d instanceof Error) return new Response("nope", { status: 502 });
    return new Response(JSON.stringify(d));
  }) as typeof fetch;
  return { impl, calls };
}

class FakeIndex {
  rows = new Map<string, GameEntry>();
  gamesUnknown(ids: string[]): string[] {
    return ids.filter((id) => !this.rows.has(id));
  }
  gamesInsert(games: GameEntry[]): number {
    for (const g of games) this.rows.set(g.id, g);
    return games.length;
  }
}

test("syncGames reads page 1 with the agreed query and records every new game", async () => {
  const index = new FakeIndex();
  const { impl, calls } = fakeFetch(["a1", "b2", "c3"]);

  const r = await syncGames(index, impl);

  assert.equal(calls[0], LIST_URL);
  assert.match(calls[0], /[?&]page=1&limit=24&hasBots=false&endedNormally=true$/);
  assert.deepEqual(r, { scanned: 3, fresh: 3, added: 3, failed: 0 });
  assert.deepEqual([...index.rows.keys()].sort(), ["a1", "b2", "c3"]);
});

test("syncGames spends a detail fetch only on games it does not have", async () => {
  const index = new FakeIndex();
  await syncGames(index, fakeFetch(["a1", "b2"]).impl);

  // Second pass: one new game among two it already knows.
  const { impl, calls } = fakeFetch(["c3", "a1", "b2"]);
  const r = await syncGames(index, impl);

  assert.deepEqual(r, { scanned: 3, fresh: 1, added: 1, failed: 0 });
  assert.deepEqual(calls, [LIST_URL, "https://api.bar-rts.com/replays/c3"]);
});

test("syncGames touches the API once when the whole page is already mirrored", async () => {
  const index = new FakeIndex();
  await syncGames(index, fakeFetch(["a1"]).impl);
  const { impl, calls } = fakeFetch(["a1"]);

  const r = await syncGames(index, impl);

  assert.deepEqual(r, { scanned: 1, fresh: 0, added: 0, failed: 0 });
  assert.deepEqual(calls, [LIST_URL], "a known page must cost exactly the listing");
});

test("syncGames records the games whose detail loaded and retries the rest next run", async () => {
  const index = new FakeIndex();
  const { impl } = fakeFetch(["a1", "b2", "c3"], { b2: new Error("502") });

  const r = await syncGames(index, impl);

  assert.deepEqual(r, { scanned: 3, fresh: 3, added: 2, failed: 1 });
  assert.deepEqual([...index.rows.keys()].sort(), ["a1", "c3"]);
  // Not recorded means still unknown, so the next pass offers it again.
  assert.deepEqual(index.gamesUnknown(["a1", "b2", "c3"]), ["b2"]);
});

test("syncGames writes oldest first, so an interrupted run drops the newest", async () => {
  let inserted: string[] = [];
  const spy = {
    gamesUnknown: (ids: string[]) => ids,
    gamesInsert: (games: GameEntry[]) => {
      inserted = games.map((g) => g.id);
      return games.length;
    },
  };
  const { impl } = fakeFetch(["new", "mid", "old"], {
    new: detail("new", { startTime: "2026-08-21T22:00:00.000Z" }),
    mid: detail("mid", { startTime: "2026-08-21T21:00:00.000Z" }),
    old: detail("old", { startTime: "2026-08-21T20:00:00.000Z" }),
  });

  await syncGames(spy, impl);

  assert.deepEqual(inserted, ["old", "mid", "new"]);
});

test("syncGames ignores junk rows and duplicate ids on the page", async () => {
  const index = new FakeIndex();
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url === LIST_URL) {
      return new Response(
        JSON.stringify({ data: [{ id: "a1" }, { id: "a1" }, { id: 42 }, {}, null, { id: "bad/id" }] }),
      );
    }
    return new Response(JSON.stringify(detail("a1")));
  }) as typeof fetch;

  const r = await syncGames(index, impl);

  assert.deepEqual(r, { scanned: 1, fresh: 1, added: 1, failed: 0 });
  assert.deepEqual(calls, [LIST_URL, "https://api.bar-rts.com/replays/a1"]);
});

test("syncGames is a no-op on an empty or malformed page", async () => {
  const index = new FakeIndex();
  for (const body of ['{"data":[]}', "{}", '{"data":"nope"}']) {
    const impl = (async () => new Response(body)) as typeof fetch;
    assert.deepEqual(await syncGames(index, impl), { scanned: 0, fresh: 0, added: 0, failed: 0 });
  }
});

test("syncGames throws when the listing itself fails", async () => {
  const impl = (async () => new Response("down", { status: 503 })) as typeof fetch;
  await assert.rejects(() => syncGames(new FakeIndex(), impl), /503/);
});

test("gameFromApi maps a detail reply onto the mirror row", () => {
  const g = gameFromApi("6ac5886a", detail("6ac5886a"));

  assert.equal(g.id, "6ac5886a");
  assert.equal(g.startUnix, Math.floor(Date.parse("2026-08-21T21:38:50.000Z") / 1000));
  assert.equal(g.durationSec, 587);
  assert.equal(g.map, "Isidis crack 1.1");
  assert.equal(g.mapFile, "isidis_crack_1.1");
  assert.equal(g.gameSize, "1v1");
  assert.equal(g.preset, "duel");
  assert.equal(g.playerCount, 2);
  assert.equal(g.engineVersion, "2026.07.04");
  assert.equal(g.gameVersion, "Beyond All Reason test-31027-900131b");
  // The roster and the badges come from the same two functions the admin
  // refresh route uses, so a mirrored game and a refreshed catalog row read
  // identically.
  assert.deepEqual(g.players, [
    { ally: 0, count: 1, players: [{ name: "nonsemantic", os: 24.5 }] },
    { ally: 1, count: 1, players: [{ name: "TehHardStuck", os: 25.1 }] },
  ]);
  assert.deepEqual(g.settings, { ranked: true });
});

test("gameFromApi survives a reply that says almost nothing", () => {
  const g = gameFromApi("x", { id: "x" });
  assert.deepEqual(g, {
    id: "x",
    startUnix: null,
    durationSec: null,
    map: null,
    mapFile: null,
    gameSize: null,
    preset: null,
    playerCount: null,
    players: null,
    settings: null,
    engineVersion: null,
    gameVersion: null,
  });
  // Not an object at all — a proxy error page, an empty body.
  assert.equal(gameFromApi("x", "nope").id, "x");
  assert.equal(gameFromApi("x", null).startUnix, null);
});

test("gameFromApi keeps a preset value it has never seen", () => {
  assert.equal(gameFromApi("x", { preset: "brawl" }).preset, "brawl");
  assert.equal(gameFromApi("x", { preset: "" }).preset, null);
});

test("gameSizeSpec orders allies largest first", () => {
  const ally = (n: number, count: number) => ({
    ally: n,
    count,
    players: Array.from({ length: count }, (_, i) => ({ name: `p${n}_${i}` })),
  });
  assert.equal(gameSizeSpec([ally(0, 8), ally(1, 8)]), "8v8");
  assert.equal(gameSizeSpec([ally(0, 1), ally(1, 5), ally(2, 3)]), "5v3v1");
  assert.equal(gameSizeSpec(null), null);
  assert.equal(gameSizeSpec([]), null);
  // A capped roster still counts its whole ally: `count` is the truth, the
  // players array is a slice of it.
  assert.equal(gameSizeSpec([{ ally: 0, count: 25, players: [{ name: "a" }] }]), "25");
});
