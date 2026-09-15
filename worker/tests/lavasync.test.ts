// Drives the lava sync (src/worker/lavasync.ts) against fakes for all three of
// its ports: lavabalance (an injected fetch, in production the service
// binding's), the BAR API (an injected fetch), and the index (the two RPC
// methods it uses). What matters here: the queue is the games barreplay has not
// offered yet, they go out oldest-STARTED first as verbatim details, each batch
// is marked only once lavabalance has answered for it — and a RUN keeps going
// until the queue is empty, which is what turns a backlog from a night of
// trickling into a few seconds.
import assert from "node:assert/strict";
import test from "node:test";

import { MAX_LAVA_BATCH, MAX_LAVA_RUN, syncLava } from "../src/worker/lavasync";
import type { LavaCandidate } from "../src/worker/lavasync";
import type { LobbyDetails } from "../src/worker/teiserver";

/** A fake lavabalance: records POSTed bodies and answers each with an
 * UploadResult under `verdict` — "rated" by default, "rejected" for the runs
 * that matter most, since a reject is what used to stall the queue.
 * `failPost` makes the Nth POST (1-based) fail, for the partial-run case. */
function fakeLava(verdict: "rated" | "rejected" = "rated", failPost = 0) {
  const posted: unknown[][] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/api/games") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as unknown[];
      posted.push(body);
      if (posted.length === failPost) return new Response("boom", { status: 503 });
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
 * marked, which is the behaviour the loop rests on — the real one is SQL over
 * games.lava_offered_unix (tests/do/replayindex.test.ts). `stuck` makes marking
 * a no-op, the one case where that premise fails. */
function fakeIndex(
  rows: (Partial<LavaCandidate> & { id: string; startUnix: number })[],
  stuck = false,
) {
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
      if (stuck) return 0;
      for (const id of ids) offered.add(id);
      return ids.length;
    },
  };
}

// 2026-09-04T10:00:00Z, in unix seconds — the fixtures hang off this moment.
const T0 = Math.floor(Date.parse("2026-09-04T10:00:00.000Z") / 1000);

/** n queued games, started one second apart so their order is unambiguous. */
const queued = (n: number, prefix = "g") =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, startUnix: T0 + i }));

const idsOf = (body: unknown[]) => body.map((d) => (d as { id: string }).id);

test("submits the pending queue oldest-started first, as verbatim details", async () => {
  const lava = fakeLava();
  const bar = fakeBar();
  const index = fakeIndex([
    { id: "b", startUnix: T0 + 900 },
    { id: "a", startUnix: T0 + 300 },
  ]);

  const r = await syncLava(index, lava.impl, bar.impl);

  assert.deepEqual(r, {
    candidates: 2, submitted: 2, failed: 0, failure: null, batches: 1, more: false,
    rated: 2, ignored: 0, skipped: 0, duplicate: 0, rejected: 0,
  });
  // One POST, start order, verbatim BAR payloads (the marker survives).
  assert.equal(lava.posted.length, 1);
  assert.deepEqual(idsOf(lava.posted[0]), ["a", "b"]);
  assert.equal((lava.posted[0][0] as { marker: string }).marker, "detail-a");
  // Both are out of the queue, so the next run has nothing to do.
  assert.deepEqual([...index.offered].sort(), ["a", "b"]);
});

test("one run drains the whole queue, a batch at a time", async () => {
  // 45 games: the shape of a backlog. The single-batch version took 20 and
  // waited for the next cron tick, so a gap like the 2026-09-11 one arrived
  // over hours. Marking each batch before reading the next is what makes
  // carrying on inside one run both possible and safe.
  const lava = fakeLava();
  const index = fakeIndex(queued(45));

  const r = await syncLava(index, lava.impl, fakeBar().impl);

  assert.deepEqual([r.candidates, r.submitted, r.batches, r.more], [45, 45, 3, false]);
  assert.deepEqual(lava.posted.map((b) => b.length), [20, 20, 5]);
  assert.equal(index.offered.size, 45);
  // Start order holds ACROSS batches, not just inside one: lavabalance folds
  // forward from a (startTime, id) head and stores anything behind it unranked.
  const submitted = lava.posted.flatMap(idsOf);
  assert.deepEqual(submitted, queued(45).map((g) => g.id));
});

test("a batch lavabalance rejects wholesale does not hold up the one behind it", async () => {
  // THE REGRESSION. MAX_LAVA_BATCH unstorable games sit in front of one real
  // lava game; lavabalance rejects every one of them and therefore stores none.
  // The old sync re-derived its queue from lavabalance's newest STORED game, so
  // the rejects stayed in front of the mark and the run repeated, verbatim,
  // hourly, for three days. Now one run gets through them to the game behind.
  const lava = fakeLava("rejected");
  const index = fakeIndex([
    ...queued(MAX_LAVA_BATCH, "junk"),
    { id: "real", startUnix: T0 + MAX_LAVA_BATCH },
  ]);

  const r = await syncLava(index, lava.impl, fakeBar().impl);

  assert.deepEqual([r.candidates, r.batches, r.more], [MAX_LAVA_BATCH + 1, 2, false]);
  assert.equal(r.rejected, MAX_LAVA_BATCH + 1);
  assert.deepEqual(idsOf(lava.posted[1]), ["real"]);
  // Marked despite being rejected: classification is deterministic, so offering
  // them again could only produce the same answer.
  assert.equal(index.offered.size, MAX_LAVA_BATCH + 1);
});

test("a run stops at MAX_LAVA_RUN and says work is still waiting", async () => {
  // The ceiling is politeness to api.bar-rts.com and the cron's wall clock, NOT
  // a subrequest budget (10,000 per invocation on this plan). What is left rides
  // the next tick, which finds it because this run marked what it took.
  const lava = fakeLava();
  const bar = fakeBar();
  const index = fakeIndex(queued(MAX_LAVA_RUN + 50));

  const r = await syncLava(index, lava.impl, bar.impl);

  assert.deepEqual([r.candidates, r.submitted, r.more], [MAX_LAVA_RUN, MAX_LAVA_RUN, true]);
  assert.equal(r.batches, MAX_LAVA_RUN / MAX_LAVA_BATCH);
  assert.equal(bar.asked.length, MAX_LAVA_RUN, "one detail per game taken, and no more");
  assert.equal(index.offered.size, MAX_LAVA_RUN);
});

test("a queue that will not shrink stops the run instead of spinning it", async () => {
  // The loop's premise is that marking removes a batch from the pending query.
  // If that fails — here marking writes nothing — the same rows come back, and
  // without the guard the run would re-fetch them until the ceiling: 200 BAR
  // requests to make no progress at all.
  const lava = fakeLava();
  const bar = fakeBar();
  const index = fakeIndex(queued(45), true);

  const r = await syncLava(index, lava.impl, bar.impl);

  assert.deepEqual([r.candidates, r.batches, r.more], [MAX_LAVA_BATCH, 1, true]);
  assert.equal(bar.asked.length, MAX_LAVA_BATCH, "one wasted batch, not ten");
  assert.equal(lava.posted.length, 1);
});

test("a POST that fails mid-drain keeps the batches already marked", async () => {
  // What makes looping safe: progress is per batch, so a run that dies partway
  // still moved the queue. The throw reaches the cron, which logs it; the next
  // run picks up from the third batch.
  const lava = fakeLava("rated", 3);
  const index = fakeIndex(queued(60));

  await assert.rejects(() => syncLava(index, lava.impl, fakeBar().impl), /503/);

  assert.equal(lava.posted.length, 3, "it got as far as the third POST");
  assert.equal(index.offered.size, 2 * MAX_LAVA_BATCH, "the first two batches stay marked");
  for (const id of queued(2 * MAX_LAVA_BATCH).map((g) => g.id)) assert.ok(index.offered.has(id));
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

// lavabalance reads the per-player chevron (Player.rank) out of what this
// sync hands it, and the only reason it is there is that the BAR detail is
// forwarded VERBATIM. Nothing here picks fields, so this pins the property
// rather than the plumbing: a nested roster arrives byte-for-byte, chevrons
// and all, including a rank of 0 — a real level that must not be dropped as
// if it were an absent one.
test("the per-player chevron survives the forward, 0 included", async () => {
  const roster = {
    AllyTeams: [
      {
        allyTeamId: 0,
        Players: [
          { name: "veteran", userId: 1, skill: "[30.00]", rank: 5 },
          { name: "newcomer", userId: 2, skill: "[16.67]", rank: 0 },
          { name: "unstated", userId: 3, skill: "[20.00]", rank: null },
        ],
      },
    ],
  };
  const bar = (async () => new Response(JSON.stringify({ id: "g", ...roster }))) as typeof fetch;
  const lava = fakeLava();

  await syncLava(fakeIndex([{ id: "g", startUnix: T0 }]), lava.impl, bar);

  const posted = lava.posted[0][0] as typeof roster;
  assert.deepEqual(posted.AllyTeams, roster.AllyTeams);
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
  // Reported rather than swallowed: a detail that will not load is the kind of
  // quiet failure this design exists to make loud.
  assert.equal(r.failed, 1);
  assert.match(String(r.failure), /502/);
  assert.deepEqual(idsOf(lava.posted[0]), ["good"]);
  // Unmarked, so the next run offers it again — the retry for a BAR blip.
  assert.deepEqual([...index.offered], ["good"]);
});

test("a batch whose every detail fails ends the run rather than pressing on", async () => {
  // BAR having a bad minute is not a reason to walk the whole queue: nothing
  // can be marked, so the next pass would hit the no-progress guard anyway.
  const lava = fakeLava();
  const bar = fakeBar(new Set(queued(20).map((g) => g.id)));
  const index = fakeIndex(queued(45));

  const r = await syncLava(index, lava.impl, bar.impl);

  assert.deepEqual([r.candidates, r.submitted, r.batches, r.more], [20, 0, 0, true]);
  assert.equal(r.failed, 20);
  assert.match(String(r.failure), /502/);
  assert.equal(lava.posted.length, 0);
  assert.equal(index.offered.size, 0);
  assert.equal(bar.asked.length, 20, "it stopped after the one bad batch");
});

test("no candidates costs no BAR fetch and no POST", async () => {
  const lava = fakeLava();
  const bar = fakeBar();

  const r = await syncLava(fakeIndex([]), lava.impl, bar.impl);

  assert.deepEqual([r.candidates, r.submitted, r.batches, r.more], [0, 0, 0, false]);
  assert.deepEqual(bar.asked, []);
  assert.equal(lava.posted.length, 0);
});

test("one row past the batch is read, to tell a full batch from the last one", async () => {
  const index = fakeIndex(queued(3));

  await syncLava(index, fakeLava().impl, fakeBar().impl);

  // Asked for MAX_LAVA_BATCH + 1 and got 3, so the queue was done in one pass —
  // no second read spent being told it is empty.
  assert.deepEqual(index.limits, [MAX_LAVA_BATCH + 1]);
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
  assert.deepEqual(idsOf(lava.posted[0]), ["x"]);
});
