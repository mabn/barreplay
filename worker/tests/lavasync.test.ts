// Drives the lava sync (src/worker/lavasync.ts) against fakes for all three of
// its ports: lavabalance (an injected fetch, in production the service
// binding's), the BAR API (an injected fetch), and the index (the two RPC
// methods it uses). What matters here: the queue is the games barreplay has
// not offered yet, they go out oldest-STARTED first as verbatim details, they
// are marked only once lavabalance has answered — and a batch it refuses
// wholesale does not come back, which is the failure this design was written
// for.
import assert from "node:assert/strict";
import test from "node:test";

import { MAX_LAVA_BATCH, syncLava } from "../src/worker/lavasync";
import type { LavaCandidate } from "../src/worker/lavasync";
import type { LobbyDetails } from "../src/worker/teiserver";

/** A fake lavabalance: records POSTed bodies and answers each with an
 * UploadResult under `verdict` — "rated" by default, "rejected" for the runs
 * that matter most, since a reject is what used to stall the queue. */
function fakeLava(verdict: "rated" | "rejected" = "rated") {
  const posted: unknown[][] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/api/games") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as unknown[];
      posted.push(body);
      const ids = body.map((d) => (d as { id: string }).id);
      const empty = { rated: [], ignored: [], skipped: [], duplicate: [], rejected: [] };
      return new Response(JSON.stringify({ ...empty, [verdict]: ids, lastSeq: 1, players: 16 }));
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { impl, posted };
}

/** A fake BAR API detail fetch: `detail-<id>` marker payloads, with named
 * failures. Records the ids asked for. */
function fakeBar(failing: Set<string> = new Set()) {
  const asked: string[] = [];
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    const id = String(input).slice(String(input).lastIndexOf("/") + 1);
    asked.push(id);
    if (failing.has(id)) return new Response("down", { status: 502 });
    return new Response(JSON.stringify({ id, marker: `detail-${id}` }));
  }) as typeof fetch;
  return { impl, asked };
}

/** The index as the sync sees it: a pending queue that shrinks as games are
 * marked, which is the behaviour under test — the real one is SQL over
 * games.lava_offered_unix (tests/do/replayindex.test.ts). */
function fakeIndex(rows: (Partial<LavaCandidate> & { id: string; startUnix: number })[]) {
  const offered = new Set<string>();
  const limits: number[] = [];
  return {
    offered,
    limits,
    gamesLavaPending(limit: number): LavaCandidate[] {
      limits.push(limit);
      return rows
        .filter((r) => !offered.has(r.id))
        .sort((a, b) => a.startUnix - b.startUnix || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((r) => ({ endUnix: r.startUnix + 600, lobbyName: null, lobbyDetails: null, ...r }));
    },
    lavaMarkOffered(ids: string[]): number {
      for (const id of ids) offered.add(id);
      return ids.length;
    },
  };
}

// 2026-09-04T10:00:00Z, in unix seconds — the fixtures hang off this moment.
const T0 = Math.floor(Date.parse("2026-09-04T10:00:00.000Z") / 1000);

test("submits the pending queue oldest-started first, as verbatim details", async () => {
  const lava = fakeLava();
  const bar = fakeBar();
  const index = fakeIndex([
    { id: "b", startUnix: T0 + 900 },
    { id: "a", startUnix: T0 + 300 },
  ]);

  const r = await syncLava(index, lava.impl, bar.impl);

  assert.deepEqual(r, {
    candidates: 2, submitted: 2, more: false,
    rated: 2, ignored: 0, skipped: 0, duplicate: 0, rejected: 0,
  });
  // One POST, start order, verbatim BAR payloads (the marker survives).
  assert.equal(lava.posted.length, 1);
  assert.deepEqual(lava.posted[0].map((d) => (d as { id: string }).id), ["a", "b"]);
  assert.equal((lava.posted[0][0] as { marker: string }).marker, "detail-a");
  // Both are out of the queue, so the next run has nothing to do.
  assert.deepEqual([...index.offered].sort(), ["a", "b"]);
});

test("a batch lavabalance rejects wholesale does not come back", async () => {
  // THE REGRESSION. MAX_LAVA_BATCH unstorable games sit in front of one real
  // lava game; lavabalance rejects every one of them and therefore stores
  // none. The old sync re-derived its queue from lavabalance's newest STORED
  // game, so the rejects stayed in front of the mark and the run repeated,
  // verbatim, hourly, for three days. Now the second run reaches the game.
  const rows = [
    ...Array.from({ length: MAX_LAVA_BATCH }, (_, i) => ({ id: `junk${i}`, startUnix: T0 + i })),
    { id: "real", startUnix: T0 + MAX_LAVA_BATCH },
  ];
  const index = fakeIndex(rows);

  const first = await syncLava(index, fakeLava("rejected").impl, fakeBar().impl);
  assert.deepEqual([first.submitted, first.rejected, first.more], [MAX_LAVA_BATCH, MAX_LAVA_BATCH, true]);

  const lava = fakeLava();
  const second = await syncLava(index, lava.impl, fakeBar().impl);

  assert.deepEqual([second.candidates, second.submitted, second.more], [1, 1, false]);
  assert.deepEqual(lava.posted[0].map((d) => (d as { id: string }).id), ["real"]);
});

test("a matched game's lobby info rides the submission; an unmatched one stays verbatim", async () => {
  const lava = fakeLava();
  const details: LobbyDetails = {
    locked: false,
    passworded: false,
    memberCount: 20,
    spectatorCount: 4,
    players: [{ name: "Adzek", team: 0, party: "7", rating: 27.25, bonus: 0, faction: "Random" }],
  };
  const index = fakeIndex([
    { id: "named", startUnix: T0, lobbyName: "Lava 8v8", lobbyDetails: details },
    { id: "plain", startUnix: T0 + 100 },
  ]);

  const r = await syncLava(index, lava.impl, fakeBar().impl);

  assert.equal(r.submitted, 2);
  const [named, plain] = lava.posted[0] as Record<string, unknown>[];
  // The BAR payload survives untouched (the marker), with the lobby fields on top.
  assert.equal(named.marker, "detail-named");
  assert.equal(named.lobbyName, "Lava 8v8");
  assert.deepEqual(named.lobbyDetails, details);
  // No matched lobby: the plain verbatim detail, no extra keys.
  assert.deepEqual(Object.keys(plain).sort(), ["id", "marker"]);
});

test("a failed detail fetch submits the rest and leaves that one pending", async () => {
  const lava = fakeLava();
  const bar = fakeBar(new Set(["bad"]));
  const index = fakeIndex([
    { id: "bad", startUnix: T0 },
    { id: "good", startUnix: T0 + 100 },
  ]);

  const r = await syncLava(index, lava.impl, bar.impl);

  assert.equal(r.candidates, 2);
  assert.equal(r.submitted, 1);
  assert.deepEqual(lava.posted[0].map((d) => (d as { id: string }).id), ["good"]);
  // Unmarked, so the next run offers it again — the retry for a BAR blip.
  assert.deepEqual([...index.offered], ["good"]);
});

test("no candidates costs no BAR fetch and no POST", async () => {
  const lava = fakeLava();
  const bar = fakeBar();

  const r = await syncLava(fakeIndex([]), lava.impl, bar.impl);

  assert.deepEqual([r.candidates, r.submitted, r.more], [0, 0, false]);
  assert.deepEqual(bar.asked, []);
  assert.equal(lava.posted.length, 0);
});

test("the batch is capped so one run's subrequests stay bounded", async () => {
  const lava = fakeLava();
  const rows = Array.from({ length: MAX_LAVA_BATCH + 10 }, (_, i) => ({ id: `g${i}`, startUnix: T0 + i }));
  const index = fakeIndex(rows);

  const r = await syncLava(index, lava.impl, fakeBar().impl);

  assert.equal(r.submitted, MAX_LAVA_BATCH);
  // One row past the cap is asked for, purely to report the backlog.
  assert.deepEqual(index.limits, [MAX_LAVA_BATCH + 1]);
  assert.equal(r.more, true);
});

test("lavabalance being unreachable throws, and marks nothing", async () => {
  const down = (async () => new Response("boom", { status: 503 })) as typeof fetch;
  const index = fakeIndex([{ id: "x", startUnix: T0 }]);

  await assert.rejects(() => syncLava(index, down, fakeBar().impl), /503/);

  // Nothing marked, so the next run re-offers the lot: a crashed run costs
  // nothing, which is the one property of the stateless design worth keeping.
  assert.deepEqual([...index.offered], []);
  const lava = fakeLava();
  await syncLava(index, lava.impl, fakeBar().impl);
  assert.deepEqual(lava.posted[0].map((d) => (d as { id: string }).id), ["x"]);
});
