// Drives the lava sync (src/worker/lavasync.ts) against fakes for all three
// of its ports: lavabalance (an injected fetch, in production the service
// binding's), the BAR API (an injected fetch), and the index (the one RPC
// method it uses). What matters here: the watermark is derived from
// lavabalance's own newest stored game, candidates at/after it are submitted
// oldest-ended first as verbatim details, and every failure mode leaves the
// next run able to catch up.
import assert from "node:assert/strict";
import test from "node:test";

import { MAX_LAVA_BATCH, syncLava } from "../src/worker/lavasync";
import type { LavaCandidate } from "../src/worker/lavasync";
import type { LobbyDetails } from "../src/worker/teiserver";

/** One lavabalance WireGame, shaped like its GET /api/games rows. */
function lavaGame(id: string, startISO: string, durationMs: number) {
  return { id, startTime: startISO, durationMs, map: "Supreme Isthmus", winnerTeam: 0, ignored: false, teams: [[], []] };
}

/** A fake lavabalance: serves `newest` on the listing, records POSTed bodies,
 * answers each with an UploadResult rating everything. */
function fakeLava(newest: ReturnType<typeof lavaGame> | null) {
  const posted: unknown[][] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/api/games?limit=1")) {
      return new Response(JSON.stringify({ games: newest ? [newest] : [], next: null }));
    }
    if (url.endsWith("/api/games") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as unknown[];
      posted.push(body);
      const ids = body.map((d) => (d as { id: string }).id);
      return new Response(JSON.stringify({
        rated: ids, ignored: [], skipped: [], duplicate: [], rejected: [], lastSeq: 1, players: 16,
      }));
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

function fakeIndex(rows: (Partial<LavaCandidate> & { id: string; endUnix: number })[]) {
  const queries: { endUnix: number; limit: number }[] = [];
  return {
    queries,
    gamesModdedEndedAfter(endUnix: number, limit: number): LavaCandidate[] {
      queries.push({ endUnix, limit });
      return rows
        .filter((r) => r.endUnix >= endUnix)
        .slice(0, limit)
        .map((r) => ({ lobbyName: null, lobbyDetails: null, ...r }));
    },
  };
}

// 2026-09-04T10:00:00Z, in unix seconds — the fixtures hang off this moment.
const T0 = Math.floor(Date.parse("2026-09-04T10:00:00.000Z") / 1000);
const iso = (unix: number) => new Date(unix * 1000).toISOString();

test("submits everything at/after the watermark, oldest-ended first, as verbatim details", async () => {
  // lavabalance's newest stored game ended at T0 (started 30 min before).
  const lava = fakeLava(lavaGame("stored", iso(T0 - 1800), 1800_000));
  const bar = fakeBar();
  const index = fakeIndex([
    { id: "old", endUnix: T0 - 600 },  // before the mark: not offered
    { id: "b", endUnix: T0 + 900 },
    { id: "a", endUnix: T0 + 300 },
  ]);

  const r = await syncLava(index, lava.impl, bar.impl);

  assert.equal(index.queries[0].endUnix, T0, "watermark = start + duration of the newest stored game");
  assert.deepEqual(r, {
    watermarkEnd: T0, candidates: 2, submitted: 2,
    rated: 2, ignored: 0, skipped: 0, duplicate: 0, rejected: 0,
  });
  // One POST, finish order, verbatim BAR payloads (the marker survives).
  assert.equal(lava.posted.length, 1);
  assert.deepEqual(lava.posted[0].map((d) => (d as { id: string }).id), ["a", "b"]);
  assert.equal((lava.posted[0][0] as { marker: string }).marker, "detail-a");
});

test("an empty lavabalance fold means everything modded qualifies", async () => {
  const lava = fakeLava(null);
  const index = fakeIndex([{ id: "x", endUnix: 100 }]);

  const r = await syncLava(index, lava.impl, fakeBar().impl);

  assert.equal(r.watermarkEnd, 0);
  assert.equal(r.submitted, 1);
});

test("the watermark game itself is excluded; an equal-ended sibling is not", async () => {
  const lava = fakeLava(lavaGame("stored", iso(T0 - 1800), 1800_000));
  // The stored game reappears in the mirror with the same end; a different
  // game that ended the same second must still be offered (>=, not >).
  const index = fakeIndex([
    { id: "stored", endUnix: T0 },
    { id: "sibling", endUnix: T0 },
  ]);

  const r = await syncLava(index, lava.impl, fakeBar().impl);

  assert.equal(r.candidates, 1);
  assert.deepEqual(lava.posted[0].map((d) => (d as { id: string }).id), ["sibling"]);
});

test("a matched game's lobby info rides the submission; an unmatched one stays verbatim", async () => {
  const lava = fakeLava(null);
  const details: LobbyDetails = {
    locked: false,
    passworded: false,
    memberCount: 20,
    spectatorCount: 4,
    players: [{ name: "Adzek", team: 0, party: "7", rating: 27.25, bonus: 0, faction: "Random" }],
  };
  const index = fakeIndex([
    { id: "named", endUnix: 100, lobbyName: "Lava 8v8", lobbyDetails: details },
    { id: "plain", endUnix: 200 },
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

test("a failed detail fetch skips that game and submits the rest", async () => {
  const lava = fakeLava(null);
  const bar = fakeBar(new Set(["bad"]));
  const index = fakeIndex([
    { id: "bad", endUnix: 100 },
    { id: "good", endUnix: 200 },
  ]);

  const r = await syncLava(index, lava.impl, bar.impl);

  assert.equal(r.candidates, 2);
  assert.equal(r.submitted, 1);
  assert.deepEqual(lava.posted[0].map((d) => (d as { id: string }).id), ["good"]);
});

test("no candidates costs no BAR fetch and no POST", async () => {
  const lava = fakeLava(lavaGame("stored", iso(T0 - 1800), 1800_000));
  const bar = fakeBar();

  const r = await syncLava(fakeIndex([]), lava.impl, bar.impl);

  assert.deepEqual([r.candidates, r.submitted], [0, 0]);
  assert.deepEqual(bar.asked, []);
  assert.equal(lava.posted.length, 0);
});

test("the batch is capped so one run's subrequests stay bounded", async () => {
  const lava = fakeLava(null);
  const rows = Array.from({ length: MAX_LAVA_BATCH + 10 }, (_, i) => ({ id: `g${i}`, endUnix: 100 + i }));

  const r = await syncLava(fakeIndex(rows), lava.impl, fakeBar().impl);

  assert.equal(r.submitted, MAX_LAVA_BATCH);
});

test("lavabalance being unreachable throws — the caller's retry story", async () => {
  const down = (async () => new Response("boom", { status: 503 })) as typeof fetch;
  await assert.rejects(() => syncLava(fakeIndex([]), down, fakeBar().impl), /503/);

  // Reachable listing, failing upload: also a throw, nothing half-recorded.
  const lava = fakeLava(null);
  const failPost = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return new Response("boom", { status: 503 });
    return lava.impl(input, init);
  }) as typeof fetch;
  await assert.rejects(
    () => syncLava(fakeIndex([{ id: "x", endUnix: 1 }]), failPost, fakeBar().impl),
    /503/,
  );
});
