// Drives the real Hono routes (src/worker/app.ts) through app.request() with
// an in-memory Env: the drag&drop upload endpoint (archive + job insert, and
// that rejects write nothing), the job-status API the browser polls, and the
// bearer-guarded daemon queue. The Durable Object's SQL lives out of reach of
// node, so a faithful in-memory stand-in implements its RPC surface.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import app from "../src/worker/app";
import { MAX_JOB_PROGRESS_BYTES, MAX_JOB_STATS_BYTES } from "../src/worker/jobs";
import type {
  IngestJob,
  JobErrorKind,
  JobKind,
  JobProgress,
  JobSample,
  JobStats,
  QueueJob,
} from "../src/worker/jobs";
import type { ReplayEntry } from "../src/worker/replayentry";
import type { GameListRow, GamesCursor } from "../src/worker/games";

const FIXTURE = new URL("../../internal/capture/testdata/harness.brepstream", import.meta.url);
const GAME_ID = "feed5eed00000000000000000000beef";

// In-memory stand-in for the ReplayIndex Durable Object's RPC surface.
class FakeIndex {
  entries = new Map<string, ReplayEntry>();
  jobs = new Map<string, IngestJob>();

  /** The id the route offers for the game's re-simulation, if the publish
   * turns out to leave it one-sided. The real DO decides whether to use it;
   * what is worth pinning HERE is that the route hands one over at all —
   * dropping it would silently stop every one-sided upload from queueing its
   * full view, with nothing failing. */
  resimJobIds: (string | undefined)[] = [];

  upsert(e: ReplayEntry, resimJobId?: string): void {
    this.entries.set(e.id, e);
    this.resimJobIds.push(resimJobId);
  }
  list(): ReplayEntry[] {
    return [...this.entries.values()];
  }
  refreshFromApi(
    id: string,
    settings: Record<string, boolean | string> | null,
    players: ReplayEntry["players"],
  ): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    e.settings = settings;
    if (players !== null) e.players = players; // COALESCE in the real DO
    return true;
  }
  setView(id: string, view: "full" | "ally" | "unknown", ally: number | null): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    e.view = view;
    e.uploaderAlly = view === "ally" ? ally : null;
    return true;
  }
  jobInsert(id: string, streamKey: string, gameId: string, kind: JobKind = "upload"): void {
    this.jobs.set(id, {
      id,
      streamKey,
      gameId,
      kind,
      state: "pending",
      error: null,
      errorKind: null,
      stats: null,
      progress: null,
      disabled: false,
      createdUnix: 0,
      updatedUnix: 0,
    });
  }
  // Both refusals plus the insert, in one call, exactly as the real DO does
  // them — it is single-threaded, which is what makes them atomic there.
  resimEnqueue(id: string, gameId: string): { status: string; job: IngestJob | null } {
    if (this.entries.has(gameId)) return { status: "in-catalog", job: null };
    return this.jobAnnounce(id, gameId, "resim");
  }
  // The same thing WITHOUT the catalog refusal: work the daemon found for
  // itself, every candidate of which is in the catalog by definition.
  jobAnnounce(id: string, gameId: string, kind: JobKind): { status: string; job: IngestJob | null } {
    const active = [...this.jobs.values()].find(
      (j) => j.gameId === gameId && j.kind === kind && (j.state === "pending" || j.state === "processing"),
    );
    if (active) return { status: active.disabled ? "disabled" : "duplicate", job: active };
    this.jobInsert(id, "", gameId, kind);
    return { status: "queued", job: this.jobs.get(id) ?? null };
  }
  jobGet(id: string): IngestJob | null {
    return this.jobs.get(id) ?? null;
  }
  jobsPending(kind: JobKind): IngestJob[] {
    return [...this.jobs.values()].filter((j) => j.kind === kind && j.state === "pending" && !j.disabled);
  }
  jobSetDisabled(id: string, disabled: boolean): boolean {
    const j = this.jobs.get(id);
    if (!j) return false;
    j.disabled = disabled;
    // Reset a claimed job: disabling cannot stop a daemon, so the row must not
    // be left looking claimed. The real DO does this in the UPDATE's CASE.
    if (disabled && j.state === "processing") j.state = "pending";
    if (disabled) j.progress = null;
    return true;
  }
  // What the route actually calls. The mirror backfill behind it is SQL over
  // three tables and is tested against the real Durable Object (tests/do);
  // here the job is only to hand back the pending work.
  jobsOffer(kind: JobKind): IngestJob[] {
    return this.jobsPending(kind);
  }
  jobClaim(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.disabled || j.state !== "pending") return false; // stale-processing needs a clock; not modelled
    j.state = "processing";
    j.error = null;
    j.progress = null; // a claim starts fresh; the previous holder's reading is not ours
    return true;
  }
  /** The games mirror. The real DO joins the catalog and the jobs table per
   * row and seeks by cursor (tested against real SQL in tests/do); here the
   * rows are handed back as stored, resumed after the cursor's id, which is
   * enough to prove the route pages, caps and refuses a junk cursor. */
  games: GameListRow[] = [];
  // The two mirror-write methods the backfill route drives (real SQL tested in
  // tests/do); here an in-memory stand-in: unknown = not already stored.
  mirror = new Map<string, unknown>();
  gamesUnknown(ids: string[]): string[] {
    return ids.filter((id) => !this.mirror.has(id));
  }
  gamesInsert(rows: { id: string }[]): number {
    for (const r of rows) this.mirror.set(r.id, r);
    return rows.length;
  }
  lastIdsQuery: string[] | null = null;
  gamesByIds(ids: string[]): GameListRow[] {
    this.lastIdsQuery = ids;
    const byId = new Map(this.games.map((g) => [g.id, g] as const));
    const out: GameListRow[] = [];
    for (const id of ids) {
      const g = byId.get(id);
      if (g !== undefined) out.push(g);
    }
    return out;
  }
  lastGamesQuery: { limit: number; after: GamesCursor | null } | null = null;
  gamesPage(limit: number, after: GamesCursor | null): { games: GameListRow[]; next: GamesCursor | null } {
    this.lastGamesQuery = { limit, after };
    const from = after === null ? 0 : this.games.findIndex((g) => g.id === after.id) + 1;
    const games = this.games.slice(from, from + limit);
    const last = games[games.length - 1];
    const next = from + limit < this.games.length && last ? { endUnix: last.startUnix, id: last.id } : null;
    return { games, next };
  }
  lastQueueQuery: { limit: number; offset: number } | null = null;
  queuePage(limit: number, offset: number): { jobs: QueueJob[]; total: number; active: number } {
    this.lastQueueQuery = { limit, offset };
    const rank = (j: IngestJob) => (j.state === "pending" || j.state === "processing") && !j.disabled ? 0 : 1;
    const all = [...this.jobs.values()].sort((a, b) => rank(a) - rank(b));
    // The real DO joins this off the catalog and the games mirror; here the
    // catalog stand-in is the only source, which is enough to prove the route
    // passes it through (the join itself is tested against real SQL).
    const withGame = (j: IngestJob): QueueJob => {
      const e = this.entries.get(j.gameId);
      return {
        ...j,
        game: e ? { durationSec: e.durationSec ?? null, gameSize: e.gameSize ?? null } : null,
      };
    };
    return {
      jobs: all.slice(offset, offset + limit).map(withGame),
      total: all.length,
      active: all.filter((j) => rank(j) === 0).length,
    };
  }
  jobUpdate(
    id: string,
    state: "processing" | "done" | "error",
    error: string | null,
    stats: JobStats | null = null,
    progress: JobProgress | null = null,
    errorKind: JobErrorKind | null = null,
  ): boolean {
    const j = this.jobs.get(id);
    if (!j) return false;
    j.state = state;
    j.error = error;
    j.errorKind = errorKind; // follows the message, never COALESCEd
    if (stats !== null) j.stats = stats; // COALESCE in the real DO
    // Kept while the job runs, cleared when it stops — the real DO does this in
    // the UPDATE's CASE expression.
    j.progress = state === "processing" ? (progress ?? j.progress) : null;
    // ...and kept as history either way. The real thing coerces each field and
    // caps the series (tests/do covers both); here it only has to accumulate.
    if (state === "processing" && progress !== null) {
      const s = this.samples.get(id) ?? [];
      s.push({
        atUnix: s.length,
        state: (progress.state as string) ?? null,
        frame: progress.frame ?? null,
        percent: progress.percent ?? null,
        etaSec: progress.etaSec ?? null,
        rssBytes: progress.rssBytes ?? null,
        swapBytes: progress.swapBytes ?? null,
        cpuPct: progress.cpuPct ?? null,
      });
      this.samples.set(id, s);
    }
    return true;
  }
  samples = new Map<string, JobSample[]>();
  jobSamples(id: string): JobSample[] {
    return this.samples.get(id) ?? [];
  }
}

// Just enough R2Bucket for the routes under test (put + the listing's list).
class FakeBucket {
  objects = new Map<string, Uint8Array>();
  // The HTTP metadata stored alongside each object. It is not incidental: the
  // bucket is also published at its own hostname, where R2 replies with
  // exactly this and no Worker gets to fix it up.
  meta = new Map<string, { contentType?: string; cacheControl?: string }>();

  async put(
    key: string,
    value: Uint8Array,
    opts?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
  ): Promise<void> {
    this.objects.set(key, value);
    this.meta.set(key, opts?.httpMetadata ?? {});
  }
  async list(): Promise<{ objects: { key: string; size: number }[]; truncated: boolean }> {
    return {
      objects: [...this.objects.entries()].map(([key, v]) => ({ key, size: v.length })),
      truncated: false,
    };
  }
  async get(key: string): Promise<unknown> {
    const v = this.objects.get(key);
    if (!v) return null;
    return { size: v.length, httpEtag: '"test"', writeHttpMetadata: () => {}, body: v, range: undefined };
  }
}

// ADMIN_OPEN, the local-dev switch: the admin routes (queue, resim, view,
// refresh-settings, the hold-back switch, samples, sqlstats) are behind a
// Cloudflare Access identity otherwise, and their tests below are about what
// the routes DO. The gate itself is tested on its own, with an env that
// leaves this out.
function makeEnv(token?: string, extra: Partial<Env> = { ADMIN_OPEN: "true" }): { env: Env; index: FakeIndex; bucket: FakeBucket } {
  const index = new FakeIndex();
  const bucket = new FakeBucket();
  const env = {
    ...extra,
    REPLAY_PUT_TOKEN: token,
    BUCKET: bucket,
    REPLAY_INDEX: { idFromName: () => ({}), get: () => index },
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  } as unknown as Env;
  return { env, index, bucket };
}

const fixture = () => new Uint8Array(readFileSync(FIXTURE));

// Route responses are ad-hoc JSON shapes; the assertions below are the contract.
const asJson = (r: Response): Promise<any> => r.json() as Promise<any>;

test("upload archives the stream and records a pending job", async () => {
  const { env, index, bucket } = makeEnv();
  const res = await app.request("/api/upload", { method: "POST", body: fixture() }, env);
  assert.equal(res.status, 200);
  const body = await asJson(res);
  assert.equal(body.gameId, GAME_ID);
  assert.match(body.streamKey, new RegExp(`^streams/${GAME_ID}/\\d+-[0-9a-f]{8}-a0\\.brepstream$`));

  const archived = bucket.objects.get(body.streamKey);
  assert.ok(archived, "raw stream archived");
  assert.deepEqual(archived, fixture());

  const job = index.jobs.get(body.job);
  assert.ok(job, "job row inserted");
  assert.equal(job.state, "pending");
  assert.equal(job.streamKey, body.streamKey);
  assert.equal(job.gameId, GAME_ID);

  // The archive prefix must stay invisible to the replay listing.
  const idx = await app.request("/index.json", {}, env);
  assert.deepEqual(await asJson(idx), []);
});

test("rejected uploads write nothing", async () => {
  const { env, index, bucket } = makeEnv();

  const bad = await app.request("/api/upload", { method: "POST", body: "not a stream" }, env);
  assert.equal(bad.status, 400);
  assert.match((await asJson(bad)).error, /not a \.brepstream/);

  const noGid = await app.request(
    "/api/upload",
    { method: "POST", body: "BREPSTREAM 1\nBRSNAP READY\n" },
    env,
  );
  assert.equal(noGid.status, 400);

  const huge = await app.request(
    "/api/upload",
    { method: "POST", body: "x", headers: { "content-length": String(151 << 20) } },
    env,
  );
  assert.equal(huge.status, 413);

  assert.equal(bucket.objects.size, 0);
  assert.equal(index.jobs.size, 0);
});

test("browser job polling: status by id, 404 for unknown", async () => {
  const { env } = makeEnv();
  const up = await app.request("/api/upload", { method: "POST", body: fixture() }, env);
  const { job } = await asJson(up);

  const res = await app.request(`/api/jobs/${job}`, {}, env);
  assert.equal(res.status, 200);
  const j = await asJson(res);
  assert.equal(j.state, "pending");
  assert.equal(j.gameId, GAME_ID);

  const missing = await app.request("/api/jobs/nope", {}, env);
  assert.equal(missing.status, 404);
});

test("daemon queue and transitions are bearer-guarded when a token is set", async () => {
  const { env } = makeEnv("s3cret");
  const auth = { authorization: "Bearer s3cret" };
  const up = await app.request("/api/upload", { method: "POST", body: fixture() }, env);
  assert.equal(up.status, 200, "upload itself is open");
  const { job } = await asJson(up);

  assert.equal((await app.request("/api/jobs", {}, env)).status, 401);
  const queue = await app.request("/api/jobs", { headers: auth }, env);
  assert.equal(queue.status, 200);
  assert.deepEqual((await asJson(queue)).map((j: IngestJob) => j.id), [job]);

  assert.equal(
    (await app.request(`/api/jobs/${job}`, { method: "POST", body: JSON.stringify({ state: "processing" }) }, env))
      .status,
    401,
  );
  const claim = await app.request(
    `/api/jobs/${job}`,
    { method: "POST", headers: auth, body: JSON.stringify({ state: "processing" }) },
    env,
  );
  assert.equal(claim.status, 200);
  assert.equal((await asJson(await app.request(`/api/jobs/${job}`, {}, env))).state, "processing");

  const done = await app.request(
    `/api/jobs/${job}`,
    { method: "POST", headers: auth, body: JSON.stringify({ state: "done" }) },
    env,
  );
  assert.equal(done.status, 200);

  const bogus = await app.request(
    `/api/jobs/${job}`,
    { method: "POST", headers: auth, body: JSON.stringify({ state: "sideways" }) },
    env,
  );
  assert.equal(bogus.status, 400);
  const unknown = await app.request(
    "/api/jobs/nope",
    { method: "POST", headers: auth, body: JSON.stringify({ state: "done" }) },
    env,
  );
  assert.equal(unknown.status, 404);
});

// The landing page's Queue section: open (it reports on public replays), and
// it must not hand out the archive key — those bytes are behind the guarded
// /api/streams route.
test("GET /api/queue lists jobs for the viewer without the archive key", async () => {
  const { env } = makeEnv("s3cret");
  const up = await app.request("/api/upload", { method: "POST", body: fixture() }, env);
  const { job, streamKey } = await asJson(up);

  const res = await app.request("/api/queue", {}, env);
  assert.equal(res.status, 200, "open even though a token is configured");
  const page = await asJson(res);
  assert.deepEqual(page, {
    jobs: [
      {
        id: job,
        gameId: GAME_ID,
        kind: "upload",
        state: "pending",
        error: null,
        errorKind: null,
        stats: null,
        progress: null,
        disabled: false,
        // Neither the catalog nor the mirror knows this id in the fake, which
        // is what a private-lobby upload looks like.
        game: null,
        createdUnix: 0,
        updatedUnix: 0,
      },
    ],
    total: 1,
    active: 1,
    offset: 0,
  });
  assert.ok(!JSON.stringify(page).includes(streamKey), "archive key stays out of the reply");

  await app.request(
    `/api/jobs/${job}`,
    { method: "POST", headers: { authorization: "Bearer s3cret" }, body: JSON.stringify({ state: "error", error: "demo not found" }) },
    env,
  );
  const after = await asJson(await app.request("/api/queue", {}, env));
  assert.equal(after.jobs[0].state, "error");
  assert.equal(after.jobs[0].error, "demo not found");
  assert.equal(after.active, 0, "a finished job is no longer in flight");
});

// Paging: the page is a window, but total/active describe the WHOLE table —
// that is what lets a 5-row page state how much it is paging through.
test("GET /api/games pages the mirror by cursor, and counts nothing", async () => {
  const { env, index } = makeEnv();
  for (let i = 0; i < 7; i++) {
    index.games.push({
      id: `game-${i}`, startUnix: 1000 * (7 - i), durationSec: 600, map: "Map", mapFile: "map",
      gameSize: "1v1", preset: "duel", playerCount: 2, players: null, settings: null,
      engineVersion: "e", gameVersion: "v", syncedUnix: 1, lobbyName: null, lobbyDetails: null,
      published: i === 0, jobState: i === 1 ? "pending" : null,
    });
  }

  const first = await asJson(await app.request("/api/games?limit=5", {}, env));
  assert.equal(first.games.length, 5);
  assert.deepEqual(Object.keys(first).sort(), ["games", "next"], "no total, no page count, no offset");
  assert.equal(first.games[0].published, true);
  assert.equal(first.games[1].jobState, "pending");
  assert.equal(typeof first.next, "string", "a page with more behind it hands out the cursor of the next one");
  assert.deepEqual(index.lastGamesQuery, { limit: 5, after: null });

  const second = await asJson(await app.request(`/api/games?limit=5&after=${encodeURIComponent(first.next)}`, {}, env));
  assert.equal(second.games.length, 2, "the tail page holds what is left");
  assert.equal(second.next, null, "the last page has no next");
  // The route decoded the wire cursor into the DO's key, not a string.
  assert.deepEqual(index.lastGamesQuery, { limit: 5, after: { endUnix: 3000, id: "game-4" } });
  const ids = new Set([...first.games, ...second.games].map((g: GameListRow) => g.id));
  assert.equal(ids.size, 7, "the two pages together are the whole mirror, no repeats");

  // The cap keeps a hand-written limit from asking for the whole mirror, and
  // an omitted limit still bounds the read.
  assert.equal((await app.request("/api/games?limit=1000", {}, env)).status, 200);
  assert.equal(index.lastGamesQuery?.limit, 100);
  await app.request("/api/games", {}, env);
  assert.deepEqual(index.lastGamesQuery, { limit: 20, after: null });
  // Junk is refused up front, never handed to the query.
  assert.equal((await app.request("/api/games?limit=abc", {}, env)).status, 400);
  assert.equal((await app.request("/api/games?after=not-a-cursor", {}, env)).status, 400);
  assert.equal((await app.request("/api/games?after=12:'%3B--", {}, env)).status, 400);
  // A cursor into the undated tail (blank end) is a valid one.
  assert.equal((await app.request("/api/games?after=:game-9", {}, env)).status, 200);
  assert.deepEqual(index.lastGamesQuery?.after, { endUnix: null, id: "game-9" });
});

// Fetch-by-ids: ?id= answers the named games instead of a listing page.
test("GET /api/games?id= fetches the named games, holding ids to shape and count", async () => {
  const { env, index } = makeEnv();
  for (let i = 0; i < 3; i++) {
    index.games.push({
      id: `game-${i}`, startUnix: 1000 * (3 - i), durationSec: 600, map: "Map", mapFile: "map",
      gameSize: "1v1", preset: "duel", playerCount: 2, players: null, settings: null,
      engineVersion: "e", gameVersion: "v", syncedUnix: 1, lobbyName: null, lobbyDetails: null,
      published: false, jobState: null,
    });
  }

  // Asked order, unknown ids simply absent, and the same reply shape as a
  // listing page — with nothing to page (next is null, not a cursor).
  const got = await asJson(await app.request("/api/games?id=game-2,nope,%20game-0", {}, env));
  assert.deepEqual(Object.keys(got).sort(), ["games", "next"]);
  assert.deepEqual(got.games.map((g: GameListRow) => g.id), ["game-2", "game-0"]);
  assert.equal(got.next, null);
  // The route trimmed, deduped and passed the ids through.
  await app.request("/api/games?id=game-1,game-1,,game-0", {}, env);
  assert.deepEqual(index.lastIdsQuery, ["game-1", "game-0"]);
  // limit/after are ignored beside id: a lookup has nothing to page.
  index.lastGamesQuery = null;
  await app.request("/api/games?id=game-1&limit=2&after=1000:game-9", {}, env);
  assert.equal(index.lastGamesQuery, null, "an id request never reaches the pager");

  // Junk is refused up front, never handed to the query.
  assert.equal((await app.request("/api/games?id=,%20,", {}, env)).status, 400);
  assert.equal((await app.request("/api/games?id=game'%3B--", {}, env)).status, 400);
  // Up to 100 ids per request; 101 is a malformed request, not a bigger read.
  const many = Array.from({ length: 100 }, (_, i) => `id-${i}`);
  assert.equal((await app.request(`/api/games?id=${many.join(",")}`, {}, env)).status, 200);
  assert.equal((await app.request(`/api/games?id=${[...many, "id-100"].join(",")}`, {}, env)).status, 400);
});

test("GET /api/queue pages with ?offset= and ?limit=", async () => {
  const { env, index } = makeEnv();
  for (let i = 0; i < 7; i++) {
    index.jobInsert(`job-${i}`, `streams/g${i}/x.brepstream`, `game-${i}`);
    if (i < 4) index.jobUpdate(`job-${i}`, "done", null); // 4 finished, 3 pending
  }

  const first = await asJson(await app.request("/api/queue?limit=5&offset=0", {}, env));
  assert.equal(first.jobs.length, 5);
  assert.equal(first.total, 7);
  assert.equal(first.active, 3);
  assert.deepEqual(first.jobs.slice(0, 3).map((j: IngestJob) => j.state), ["pending", "pending", "pending"]);

  const second = await asJson(await app.request("/api/queue?limit=5&offset=5", {}, env));
  assert.equal(second.jobs.length, 2, "the tail page holds what is left");
  assert.equal(second.offset, 5);
  assert.equal(second.total, 7, "counts stay whole-table, not per page");
  const ids = new Set([...first.jobs, ...second.jobs].map((j: IngestJob) => j.id));
  assert.equal(ids.size, 7, "the two pages together are the whole table, no repeats");

  const past = await asJson(await app.request("/api/queue?limit=5&offset=99", {}, env));
  assert.deepEqual(past.jobs, [], "an offset past the end is empty, not an error");
  assert.equal(past.total, 7);

  // The cap keeps a hand-written limit from asking for the whole table, and
  // an omitted limit still bounds the read.
  assert.equal((await app.request("/api/queue?limit=1000", {}, env)).status, 200);
  assert.equal(index.lastQueueQuery?.limit, 100);
  await app.request("/api/queue", {}, env);
  assert.deepEqual(index.lastQueueQuery, { limit: 25, offset: 0 });

  for (const bad of ["limit=-1", "limit=abc", "offset=1.5"]) {
    const res = await app.request(`/api/queue?${bad}`, {}, env);
    assert.equal(res.status, 400, bad);
  }
});

test("the daemon can download the archived stream, guarded", async () => {
  const { env } = makeEnv("s3cret");
  const up = await app.request("/api/upload", { method: "POST", body: fixture() }, env);
  const { streamKey } = await asJson(up);

  const path = `/api/${streamKey}`; // streams/<gameId>/<file> nests under /api/
  assert.equal((await app.request(path, {}, env)).status, 401);
  const res = await app.request(path, { headers: { authorization: "Bearer s3cret" } }, env);
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), fixture());

  const missing = await app.request(`/api/streams/${GAME_ID}/nope.brepstream`, { headers: { authorization: "Bearer s3cret" } }, env);
  assert.equal(missing.status, 404);
});

test("failed jobs carry their error to the poller", async () => {
  const { env } = makeEnv();
  const up = await app.request("/api/upload", { method: "POST", body: fixture() }, env);
  const { job } = await asJson(up);
  await app.request(
    `/api/jobs/${job}`,
    { method: "POST", body: JSON.stringify({ state: "error", error: "demo not found" }) },
    env,
  );
  const j = await asJson(await app.request(`/api/jobs/${job}`, {}, env));
  assert.equal(j.state, "error");
  assert.equal(j.error, "demo not found");
});

test("trusted piece writes: PUT /replays/<key> stores the object, guarded", async () => {
  const { env, bucket } = makeEnv("s3cret");
  const auth = { authorization: "Bearer s3cret" };
  const key = `replays/${GAME_ID}-1a2b3c4d/c0`;

  assert.equal((await app.request(`/${key}`, { method: "PUT", body: "bytes" }, env)).status, 401);
  const ok = await app.request(`/${key}`, { method: "PUT", headers: auth, body: "bytes" }, env);
  assert.equal(ok.status, 200);
  assert.deepEqual(bucket.objects.get(key), new TextEncoder().encode("bytes"));

  // Key hygiene: bad shapes are rejected by the route, and a traversal is
  // normalized away by the URL layer before routing (it never reaches the
  // bucket either way).
  for (const bad of ["replays//x", "replays/a b"]) {
    const res = await app.request(`/${bad}`, { method: "PUT", headers: auth, body: "x" }, env);
    assert.equal(res.status, 400, bad);
  }
  const before = bucket.objects.size;
  await app.request("/replays/../streams/x", { method: "PUT", headers: auth, body: "x" }, env);
  assert.equal(bucket.objects.size, before, "traversal must not write");
  assert.ok(!bucket.objects.has("streams/x"));

  const huge = await app.request(`/${key}`, {
    method: "PUT",
    headers: { ...auth, "content-length": String(151 << 20) },
    body: "x",
  }, env);
  assert.equal(huge.status, 413);

  // Open without a configured token (local dev), like the other write APIs.
  const { env: openEnv, bucket: openBucket } = makeEnv();
  assert.equal((await app.request(`/${key}`, { method: "PUT", body: "b" }, openEnv)).status, 200);
  assert.ok(openBucket.objects.has(key));
});

test("PUT /api/replays carries rid into the catalog", async () => {
  const { env, index } = makeEnv();
  const res = await app.request(
    `/api/replays/${GAME_ID}`,
    { method: "PUT", body: JSON.stringify({ rid: `${GAME_ID}-1a2b3c4d`, durationSec: 60 }) },
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(index.entries.get(GAME_ID)?.rid, `${GAME_ID}-1a2b3c4d`);
  // ...and an id for the re-sim the publish may want to queue.
  assert.match(index.resimJobIds[0] ?? "", /^[0-9a-f-]{36}$/);
});

// The admin settings-refresh re-derives one row's badges AND players roster
// from the BAR API's stored demo metadata (no repack/re-upload). The API
// call is stubbed out.
test("POST /api/replays/:id/refresh-settings updates the row from the BAR API", async (t) => {
  const { env, index } = makeEnv();
  await app.request(
    `/api/replays/${GAME_ID}`,
    { method: "PUT", body: JSON.stringify({ durationSec: 60, settings: { ranked: true } }) },
    env,
  );

  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  let fetched = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched = String(input);
    if (fetched.includes("unknown0000")) return new Response("not found", { status: 404 });
    return Response.json({
      gameSettings: { ranked_game: "0", zombies: "nightmare", ruins: "enabled" },
      AllyTeams: [
        {
          allyTeamId: 1,
          Players: [{ name: "solo", skill: "[20.00]" }],
          AIs: [{ shortName: "BARb", name: "BARb(1)" }],
        },
        {
          allyTeamId: 0,
          Players: [{ name: "low", skill: "[12.50]" }, { name: "high", skill: "[30.00]" }],
          AIs: [],
        },
      ],
    });
  }) as typeof fetch;

  const res = await app.request(`/api/replays/${GAME_ID}/refresh-settings`, { method: "POST" }, env);
  assert.equal(res.status, 200);
  const body = await asJson(res);
  assert.deepEqual(body.settings, { unranked: true, zombies: "nightmare", ruins: true });
  assert.equal(fetched, `https://api.bar-rts.com/replays/${GAME_ID}`);
  const row = index.entries.get(GAME_ID);
  assert.deepEqual(row?.settings, { unranked: true, zombies: "nightmare", ruins: true });
  // Allies ascending, humans best-OS-first, AI slots after, counts included.
  assert.deepEqual(row?.players, [
    { ally: 0, count: 2, players: [{ name: "high", os: 30 }, { name: "low", os: 12.5 }] },
    { ally: 1, count: 2, players: [{ name: "solo", os: 20 }, { name: "BARb" }] },
  ]);
  assert.deepEqual(body.players, row?.players);

  // A game the BAR API doesn't know, and a game with no catalog row: 404.
  const unknownApi = await app.request(`/api/replays/unknown0000/refresh-settings`, { method: "POST" }, env);
  assert.equal(unknownApi.status, 404);
  globalThis.fetch = (async () => Response.json({ gameSettings: {} })) as typeof fetch;
  const noRow = await app.request(`/api/replays/norow11111/refresh-settings`, { method: "POST" }, env);
  assert.equal(noRow.status, 404);
});

// ---- re-sim requests -------------------------------------------------------
// POST /api/resim is the pipeline's other door: a game NOBODY uploaded, queued
// from a pasted link. Every refusal below exists because the work behind an
// accepted request is the better part of an hour of somebody's engine time.

const RESIM_ID = "836d486a5480a9e830be54db7d2c7be9";

// Stub the BAR API lookup the route makes before it accepts anything, the same
// way the refresh-settings test does. `known` is the set of ids it recognizes.
function stubBarApi(t: { after(fn: () => void): void }, known: Set<string>): { urls: string[] } {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return [...known].some((id) => url.endsWith(id))
      ? Response.json({ id: "x", fileName: "x.sdfz" })
      : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { urls };
}

test("POST /api/resim queues a re-sim from a pasted replay link", async (t) => {
  const { env, index } = makeEnv();
  const { urls } = stubBarApi(t, new Set([RESIM_ID]));

  const res = await app.request(
    "/api/resim",
    { method: "POST", body: JSON.stringify({ link: `https://gex.honu.pw/match/${RESIM_ID}` }) },
    env,
  );
  assert.equal(res.status, 200);
  const body = await asJson(res);
  assert.equal(body.gameId, RESIM_ID);
  assert.equal(body.status, "queued");
  assert.deepEqual(urls, [`https://api.bar-rts.com/replays/${RESIM_ID}`]);

  const job = index.jobs.get(body.job);
  assert.equal(job?.kind, "resim");
  assert.equal(job?.state, "pending");
  assert.equal(job?.streamKey, "", "a re-sim has no archived stream behind it");
});

test("POST /api/resim refuses what it cannot or should not run", async (t) => {
  const { env, index } = makeEnv();
  stubBarApi(t, new Set([RESIM_ID]));

  // Not a link to anything.
  const junk = await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: "yesterday's 8v8" }) }, env);
  assert.equal(junk.status, 400);

  // A well-formed id the BAR API has never heard of: there is no demo to
  // re-simulate, and a re-sim cannot degrade past that the way an upload can.
  const unknown = "0000000000000000000000000000dead";
  const miss = await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: unknown }) }, env);
  assert.equal(miss.status, 404);

  // Already published: re-simulating would mostly repeat a capture that exists.
  await app.request(`/api/replays/${RESIM_ID}`, { method: "PUT", body: JSON.stringify({ durationSec: 60 }) }, env);
  const dup = await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env);
  assert.equal(dup.status, 409);
  assert.equal((await asJson(dup)).gameId, RESIM_ID);

  assert.equal(index.jobs.size, 0, "no refusal may leave a job behind");
});

test("POST /api/resim is idempotent: the same link twice is one job", async (t) => {
  const { env, index } = makeEnv();
  stubBarApi(t, new Set([RESIM_ID]));

  const first = await asJson(
    await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env),
  );
  const again = await asJson(
    await app.request(
      "/api/resim",
      { method: "POST", body: JSON.stringify({ link: `https://bar-rts.com/replays/${RESIM_ID}` }) },
      env,
    ),
  );
  assert.equal(again.status, "duplicate");
  assert.equal(again.job, first.job, "the caller follows the request already in flight");
  assert.equal(index.jobs.size, 1);
});

// The compatibility hinge. A deployed bringest asks without ?kind= and must
// never be handed a re-sim: it has no engine, no BAR data dir, and no stream
// to download.
test("GET /api/jobs serves one kind, defaulting to upload", async (t) => {
  const { env, index } = makeEnv();
  stubBarApi(t, new Set([RESIM_ID]));
  await app.request("/api/upload", { method: "POST", body: fixture() }, env);
  const resim = await asJson(
    await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env),
  );

  const byDefault = await asJson(await app.request("/api/jobs", {}, env));
  assert.deepEqual(byDefault.map((j: IngestJob) => j.gameId), [GAME_ID]);

  const uploads = await asJson(await app.request("/api/jobs?kind=upload", {}, env));
  assert.deepEqual(uploads.map((j: IngestJob) => j.gameId), [GAME_ID]);

  const resims = await asJson(await app.request("/api/jobs?kind=resim", {}, env));
  assert.deepEqual(resims.map((j: IngestJob) => j.id), [resim.job]);

  assert.equal((await app.request("/api/jobs?kind=nonsense", {}, env)).status, 400);
  assert.equal(index.jobs.size, 2);
});

// Claiming can fail, which is the point of it: two daemons polling the same
// round must not both run an hour of engine work. A plain "processing" report
// (the heartbeat) keeps succeeding, since the holder sends it repeatedly.
test("a job can only be claimed once, but heartbeats keep working", async (t) => {
  const { env } = makeEnv();
  stubBarApi(t, new Set([RESIM_ID]));
  const { job } = await asJson(
    await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env),
  );
  const post = (body: unknown) =>
    app.request(`/api/jobs/${job}`, { method: "POST", body: JSON.stringify(body) }, env);

  assert.equal((await post({ state: "processing", claim: true, kind: "resim" })).status, 200);
  assert.equal((await post({ state: "processing", claim: true, kind: "resim" })).status, 409, "a second daemon is told no");
  assert.equal((await post({ state: "processing" })).status, 200, "the holder's heartbeat");
  assert.equal((await post({ state: "done", claim: true })).status, 400, "claim only makes sense with processing");
  assert.equal((await post({ state: "done" })).status, 200);
});

// The daemon's processing record rides the terminal report and comes back out
// on both job views. It is what the queue page shows: the duration in the
// table, everything else on click.
test("a job's processing stats round-trip through the report", async (t) => {
  const { env } = makeEnv();
  stubBarApi(t, new Set([RESIM_ID]));
  const { job } = await asJson(
    await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env),
  );
  const stats = {
    tookSec: 2483,
    resimSec: 2431,
    loadSec: 41,
    simSec: 2390,
    frames: 100170,
    speedUp: 1.4,
    engineVersion: "2026.07.04",
    infolog: { bytes: 50331648, lastFrame: 100170, desyncs: 0, warnings: 118 },
    sizeReport: "sections:\n  M   1234\n",
  };
  const post = (body: unknown) =>
    app.request(`/api/jobs/${job}`, { method: "POST", body: JSON.stringify(body) }, env);

  // A heartbeat carries none, and must not erase what is stored.
  assert.equal((await post({ state: "processing", stats })).status, 200);
  assert.equal((await post({ state: "processing" })).status, 200);
  assert.equal((await post({ state: "done" })).status, 200);

  const polled = await asJson(await app.request(`/api/jobs/${job}`, {}, env));
  assert.deepEqual(polled.stats, stats, "the poll sees it");
  const page = await asJson(await app.request("/api/queue", {}, env));
  assert.deepEqual(page.jobs[0].stats, stats, "and so does the queue page");
});

// Stats that cannot be stored are dropped, never a 400: they describe work
// that already happened, and refusing the report would lose the state
// transition with them.
test("unusable stats are dropped without losing the report", async (t) => {
  const { env } = makeEnv();
  stubBarApi(t, new Set([RESIM_ID]));
  const { job } = await asJson(
    await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env),
  );
  const post = (body: unknown) =>
    app.request(`/api/jobs/${job}`, { method: "POST", body: JSON.stringify(body) }, env);

  for (const bad of ["a string", 42, [1, 2], { sizeReport: "x".repeat(MAX_JOB_STATS_BYTES + 1) }]) {
    assert.equal((await post({ state: "error", error: "boom", stats: bad })).status, 200);
  }
  const polled = await asJson(await app.request(`/api/jobs/${job}`, {}, env));
  assert.equal(polled.state, "error");
  assert.equal(polled.error, "boom", "the transition survived every one of them");
  assert.equal(polled.stats, null);
});

// Uploaded pieces must carry their own Content-Type and Cache-Control. The
// bucket is served BOTH through this Worker and directly at its own hostname
// (cdn-bar.fogofwar.dev), and on the direct path R2 replies with the stored
// metadata alone. A piece stored without Cache-Control is not held by
// Cloudflare's cache, so every read of it becomes a billed R2 GetObject —
// which is the whole reason for serving the bucket directly.
test("PUT /replays/<key> stores cache-control and content-type on the object", async () => {
  const { env, bucket } = makeEnv();
  const rid = `${GAME_ID}-1a2b3c4d`;
  const immutable = "public, max-age=31536000, immutable";

  const cases: [key: string, contentType: string, cacheControl: string][] = [
    [`replays/${rid}/c0`, "application/octet-stream", immutable],
    [`replays/${rid}.brw`, "application/octet-stream", immutable],
    [`replays/${rid}.keys`, "application/octet-stream", immutable],
    // .resources is real JSON the browser parses...
    [`replays/${rid}.resources`, "application/json", immutable],
    // ...while a listing changes on every publish, so it only revalidates.
    ["replays/index.json", "application/json", "no-cache"],
  ];

  for (const [key, contentType, cacheControl] of cases) {
    const res = await app.request(`/${key}`, { method: "PUT", body: "bytes" }, env);
    assert.equal(res.status, 200, key);
    assert.deepEqual(bucket.meta.get(key), { contentType, cacheControl }, key);
  }
});

// The same derivation is applied when this Worker serves the object on its own
// hostname, so objects uploaded before upload-time metadata existed still get
// correct headers without a re-upload.
test("GET /replays/<key> sets the same content-type and cache-control", async () => {
  const { env, bucket } = makeEnv();
  const rid = `${GAME_ID}-1a2b3c4d`;
  await bucket.put(`replays/${rid}.resources`, new TextEncoder().encode("{}"));
  await bucket.put(`replays/${rid}/c0`, new TextEncoder().encode("bytes"));

  const res = await app.request(`/replays/${rid}.resources`, {}, env);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const chunk = await app.request(`/replays/${rid}/c0`, {}, env);
  assert.equal(chunk.headers.get("content-type"), "application/octet-stream");
  // Never Content-Encoding: the viewer gunzips these itself.
  assert.equal(chunk.headers.get("content-encoding"), null);
});

// Two captures of the SAME game from the SAME side must not collide. gameId
// and archiveSuffix are equal for both, and Date.now() in Workers is clamped
// to the last I/O — it does not advance during a request — so the timestamp
// alone does not separate them. Before the key carried a content hash the
// second PUT overwrote the first, and both jobs pointed at one key holding
// only one player's bytes.
//
// This is the real shape of it: two players on one ally team uploading the
// same game, or one player uploading a half-game capture and later the full
// one (a longer stream with an identical preamble).
test("uploads of the same game from the same side get distinct keys", async () => {
  const { env, bucket, index } = makeEnv();

  const full = fixture();
  const halfway = full.slice(0, Math.floor(full.length * 0.6)); // a shorter capture, same preamble

  const a = await asJson(await app.request("/api/upload", { method: "POST", body: full }, env));
  const b = await asJson(await app.request("/api/upload", { method: "POST", body: halfway }, env));

  assert.equal(a.gameId, b.gameId, "same game");
  assert.notEqual(a.streamKey, b.streamKey, "different bytes must not share a key");
  assert.equal(bucket.objects.size, 2, "both uploads survive");
  assert.deepEqual(bucket.objects.get(a.streamKey), full);
  assert.deepEqual(bucket.objects.get(b.streamKey), halfway);

  // Each upload gets its own job, pointing at its own bytes.
  assert.notEqual(a.job, b.job);
  assert.equal(index.jobs.get(a.job)!.streamKey, a.streamKey);
  assert.equal(index.jobs.get(b.job)!.streamKey, b.streamKey);

  // The hash is what actually separates them: the two keys differ in that
  // component, not merely in their timestamps.
  const hashOf = (key: string) => /-([0-9a-f]{8})-/.exec(key)![1];
  assert.notEqual(hashOf(a.streamKey), hashOf(b.streamKey));

  // Re-uploading identical bytes archives them again under a fresh timestamp
  // rather than deduplicating — the key is timestamped first so the prefix
  // still sorts oldest-first. Harmless: the hash component is unchanged, so
  // nothing is ever overwritten and no capture is lost.
  const again = await asJson(await app.request("/api/upload", { method: "POST", body: full }, env));
  assert.equal(hashOf(again.streamKey), hashOf(a.streamKey), "same bytes, same hash component");
  assert.deepEqual(bucket.objects.get(again.streamKey), full);
});

// The favicons are served by the ASSET LAYER, not by these routes: wrangler.jsonc
// excludes them from run_worker_first so public/_headers can set their
// cache-control. That makes their presence on disk the thing worth guarding —
// if either file goes missing, the request falls to the catch-all, where the
// single-page-application handling answers it with index.html: a 200 carrying
// the whole HTML document, labelled text/html, as the tab icon. That is what
// /favicon.ico actually did before the file existed.
test("both favicon files exist for the asset layer to serve", () => {
  for (const [name, magic] of [["favicon.svg", "<svg"], ["favicon.ico", "\x00\x00\x01\x00"]] as const) {
    const b = readFileSync(new URL(`../public/${name}`, import.meta.url));
    assert.ok(b.length > 100, `${name} is suspiciously small (${b.length} bytes)`);
    assert.equal(b.subarray(0, magic.length).toString("binary"), magic, `${name} magic`);
  }

  // index.html must reference both, or the fallback ships dead.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /href="\/favicon\.svg"/);
  assert.match(html, /href="\/favicon\.ico"/);
});

// The viewer's canonical replay URL is a PATH under the same prefix as the
// data pieces: /replays/<id> (no extension) is the SPA page, while every
// piece carries an extension (<id>.brw/.keys/.resources) or a second segment
// (<id>/c<n>). The dot is the whole dispatch — a page id and a bucket key
// cannot collide on it.
test("/replays/<id> serves the SPA page; pieces with extensions stay on the bucket", async () => {
  const { env, bucket } = makeEnv();
  await bucket.put("replays/aaaa.brw", new Uint8Array([1, 2, 3]));
  await bucket.put("replays/aaaa/c0", new Uint8Array([9]));
  const asked: string[] = [];
  (env as unknown as { ASSETS: { fetch(r: Request): Promise<Response> } }).ASSETS = {
    async fetch(r: Request) {
      asked.push(new URL(r.url).pathname);
      return new Response("<!DOCTYPE html>", { headers: { "content-type": "text/html" } });
    },
  };

  // A bare id — a revisioned one included — is the page: the SPA entry,
  // revalidated like "/", and never a bucket lookup.
  for (const path of ["/replays/aaaa", "/replays/f8e5816a04505f9c2b5b69a6a458b696-9942e3d8"]) {
    const page = await app.request(path, {}, env);
    assert.equal(page.status, 200, path);
    assert.equal(page.headers.get("cache-control"), "no-cache", path);
    assert.match(await page.text(), /DOCTYPE html/, path);
  }
  assert.deepEqual(asked, ["/replays/aaaa", "/replays/f8e5816a04505f9c2b5b69a6a458b696-9942e3d8"]);

  // A key with an extension is a data piece and still comes from the bucket…
  const brw = await app.request("/replays/aaaa.brw", {}, env);
  assert.equal(brw.status, 200);
  assert.deepEqual(new Uint8Array(await brw.arrayBuffer()), new Uint8Array([1, 2, 3]));
  // …and so does a chunk (two segments never match the page route).
  const chunk = await app.request("/replays/aaaa/c0", {}, env);
  assert.equal(chunk.status, 200);
  assert.equal(asked.length, 2, "no data piece reached the asset layer");

  // The landing page's sections are paths too, served exactly like "/".
  for (const path of ["/queue", "/games", "/sqlstats"]) {
    const r = await app.request(path, {}, env);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("cache-control"), "no-cache", path);
  }
});

// The widget-install guide. The route hands the request to the asset layer
// UNCHANGED: it resolves /setup to setup.html itself, and its default HTML
// handling (auto-trailing-slash) answers a /setup.html URL with a 307 back to
// /setup. Rewriting the path therefore fed that redirect into this same route
// — an infinite loop in production that no local test could see, because the
// fake ASSETS below happily answers whatever path it is handed.
test("/setup serves the guide page without rewriting the path", async () => {
  const { env } = makeEnv();
  const asked: string[] = [];
  (env as unknown as { ASSETS: { fetch(r: Request): Promise<Response> } }).ASSETS = {
    async fetch(r: Request) {
      const path = new URL(r.url).pathname;
      asked.push(path);
      // Stand in for auto-trailing-slash: the .html form is a redirect, never
      // a page, so a route that asks for it can only ever return the bounce.
      if (path.endsWith(".html") && path !== "/index.html") {
        return new Response(null, { status: 307, headers: { location: path.slice(0, -".html".length) } });
      }
      return new Response("<!DOCTYPE html>", { headers: { "content-type": "text/html" } });
    },
  };

  const res = await app.request("/setup", {}, env);
  assert.deepEqual(asked, ["/setup"], "the asset layer resolves the extensionless path itself");
  assert.equal(res.status, 200, "a 3xx here is the redirect loop");
  // Like the SPA entry: revalidated, so a guide edit reaches everyone on reload.
  assert.equal(res.headers.get("cache-control"), "no-cache");
});

// The three halves of the install flow must agree: the landing page links to
// the guide, the guide offers the widget at a URL, and tools/sync-assets.mjs
// is what puts that file in public/ (it is gitignored — the source of truth is
// assets/lua/replay_uploader.lua, so nothing here can be checked by presence).
test("the setup guide is wired to the banner and to the widget", () => {
  const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  assert.match(at("../index.html"), /href="\/setup"/, "the dropzone banner links to the guide");

  const guide = at("../public/setup.html");
  assert.match(guide, /href="\/replay_uploader\.lua" download/, "the guide offers the widget");
  assert.match(guide, /LuaUI\\Widgets\\replay_uploader\.lua/, "the guide names the install path");

  assert.match(at("../tools/sync-assets.mjs"), /"replay_uploader\.lua"/, "the sync copies the widget");
  // The widget must reach the browser from the ASSET LAYER: routed through the
  // Worker, public/_headers (its only cache-control) is silently ignored.
  assert.match(at("../wrangler.jsonc"), /"!\/replay_uploader\.lua"/, "excluded from run_worker_first");
  assert.match(at("../public/_headers"), /^\/replay_uploader\.lua$/m, "and has a cache rule");
  assert.ok(
    readFileSync(new URL("../../assets/lua/replay_uploader.lua", import.meta.url), "utf8").includes(
      'name    = "Replay uploader"',
    ),
    "the widget's F11 name is the one the guide tells players to look for",
  );
  assert.match(guide, /Replay uploader/);
});

// A running job's live self-report: it rides the healthcheck, comes back out on
// both job views, survives a beat that carries none, and is CLEARED the moment
// the job stops running — a finished row still saying "simulating, 43%" would
// be worse than saying nothing.
test("a running job's progress round-trips and is cleared when it ends", async (t) => {
  const { env } = makeEnv();
  stubBarApi(t, new Set([RESIM_ID]));
  const { job } = await asJson(
    await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env),
  );
  const progress = {
    state: "simulating",
    frame: 43000,
    totalFrames: 100170,
    percent: 42.9,
    etaSec: 840,
    simFps: 68.2,
    rssBytes: 3221225472,
    cpuPct: 612.5,
  };
  const post = (body: unknown) =>
    app.request(`/api/jobs/${job}`, { method: "POST", body: JSON.stringify(body) }, env);

  assert.equal((await post({ state: "processing", claim: true, kind: "resim" })).status, 200);
  assert.equal((await post({ state: "processing", progress })).status, 200);

  const polled = await asJson(await app.request(`/api/jobs/${job}`, {}, env));
  assert.deepEqual(polled.progress, progress, "the poll sees it");
  const page = await asJson(await app.request("/api/queue", {}, env));
  assert.deepEqual(page.jobs[0].progress, progress, "and so does the queue page");

  // A beat with no reading keeps the last one — an older daemon simply sends
  // less, and blanking on silence would make the page flicker.
  assert.equal((await post({ state: "processing" })).status, 200);
  assert.deepEqual((await asJson(await app.request(`/api/jobs/${job}`, {}, env))).progress, progress);

  assert.equal((await post({ state: "done" })).status, 200);
  const done = await asJson(await app.request(`/api/jobs/${job}`, {}, env));
  assert.equal(done.progress, null, "progress describes work in flight, and there is none now");
});

// Same rule as the stats: a reading that cannot be stored is dropped, never a
// 400 — the state transition it rides is worth more than it.
test("unusable progress is dropped without losing the healthcheck", async (t) => {
  const { env } = makeEnv();
  stubBarApi(t, new Set([RESIM_ID]));
  const { job } = await asJson(
    await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env),
  );
  const post = (body: unknown) =>
    app.request(`/api/jobs/${job}`, { method: "POST", body: JSON.stringify(body) }, env);

  for (const bad of ["simulating", 42, ["simulating"], { state: "x".repeat(MAX_JOB_PROGRESS_BYTES + 1) }]) {
    assert.equal((await post({ state: "processing", progress: bad })).status, 200);
  }
  const polled = await asJson(await app.request(`/api/jobs/${job}`, {}, env));
  assert.equal(polled.state, "processing", "the transition still landed");
  assert.equal(polled.progress, null);
});

// The healthcheck HISTORY behind the queue page's charts. It is its own route
// because it is fetched per expanded row, not with every queue read — a page of
// 25 rows would otherwise carry thousands of points nobody looked at.
test("a job's healthcheck history is served on its own route", async (t) => {
  const { env, index } = makeEnv();
  stubBarApi(t, new Set([RESIM_ID]));
  const { job } = await asJson(
    await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env),
  );
  const post = (body: unknown) =>
    app.request(`/api/jobs/${job}`, { method: "POST", body: JSON.stringify(body) }, env);

  for (const p of [
    { state: "loading" },
    { state: "simulating", percent: 12, rssBytes: 2e9, swapBytes: 0, cpuPct: 480 },
    { state: "simulating", percent: 43, rssBytes: 3e9, swapBytes: 0, cpuPct: 610 },
  ]) {
    assert.equal((await post({ state: "processing", progress: p })).status, 200);
  }

  const { samples } = await asJson(await app.request(`/api/jobs/${job}/samples`, {}, env));
  assert.equal(samples.length, 3, 'every beat is a point');
  assert.deepEqual(samples[2], {
    atUnix: 2, state: "simulating", percent: 43, frame: null, etaSec: null,
    // Reported even at zero: "the engine is not swapping" is the reassurance,
    // and it must not read the same as a daemon too old to measure it.
    rssBytes: 3e9, swapBytes: 0, cpuPct: 610,
  });

  // The series survives the job: the curve of a run that died is the whole
  // reason to keep it, and the live progress is gone by then.
  assert.equal((await post({ state: "error", error: "engine died" })).status, 200);
  assert.equal((await asJson(await app.request(`/api/jobs/${job}`, {}, env))).progress, null);
  assert.equal((await asJson(await app.request(`/api/jobs/${job}/samples`, {}, env))).samples.length, 3);

  // A job that never beat — an upload, or an older daemon — is an empty series
  // rather than a 404: the view says the same thing about both.
  index.jobInsert("plain", "streams/x", "gid");
  assert.deepEqual((await asJson(await app.request("/api/jobs/plain/samples", {}, env))).samples, []);
  assert.deepEqual((await asJson(await app.request("/api/jobs/nope/samples", {}, env))).samples, []);
});

// The daemon's catalog scan re-simulates games whose only upload is one-sided.
// Every one of those is already IN the catalog, so /api/resim refuses them all
// — right for a person pasting a link, wrong for work that is already running.
// Announcing is the door for it, and it is guarded because it is the one path
// into the job table with no refusals behind it.
test("a daemon can announce work it found itself, which /api/resim would refuse", async (t) => {
  const { env, index } = makeEnv("s3cret");
  const auth = { Authorization: "Bearer s3cret" };
  const post = (body: unknown, headers = auth) =>
    app.request("/api/jobs", { method: "POST", headers, body: JSON.stringify(body) }, env);

  // The game is published, one-sided: exactly a scan candidate.
  index.upsert({ id: RESIM_ID, uploaderAlly: 1 } as ReplayEntry);
  stubBarApi(t, new Set([RESIM_ID]));
  assert.equal(
    (await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env)).status,
    409,
    "the open door refuses it as published",
  );

  assert.equal((await post({ gameId: RESIM_ID }, {} as never)).status, 401, "and this one needs the token");

  const first = await asJson(await post({ gameId: RESIM_ID }));
  assert.equal(first.status, "queued");
  assert.ok(first.job, "with a row to report onto");
  assert.equal(index.jobGet(first.job)?.kind, "resim");

  // Two daemons scanning the same catalog get the same row, so only one of
  // them can claim it — the other does not spend an hour on the same game.
  const second = await asJson(await post({ gameId: RESIM_ID }));
  assert.equal(second.status, "duplicate");
  assert.equal(second.job, first.job);

  // A finished job does not block a fresh one: re-announcing is how a scan
  // retries a game whose link nobody can paste.
  index.jobUpdate(first.job, "error", "desynced");
  assert.equal((await asJson(await post({ gameId: RESIM_ID }))).status, "queued");

  // Rejections: only a real game id, and only the kind that has no stream.
  assert.equal((await post({ gameId: "not-a-game" })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ gameId: RESIM_ID, kind: "upload" })).status, 400);
});

// The queue page's per-row switch. Disabling cannot reach out and stop an
// engine on somebody else's machine, so what it does is stop the job being
// HANDED OUT and reset a claimed row that would otherwise just be re-offered
// once its stale window expired.
test("a job can be held back from the queue page, and let go again", async (t) => {
  const { env, index } = makeEnv();
  stubBarApi(t, new Set([RESIM_ID]));
  const { job } = await asJson(
    await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env),
  );
  const flip = (disabled: unknown, id = job) =>
    app.request(`/api/jobs/${id}/disabled`, { method: "POST", body: JSON.stringify({ disabled }) }, env);

  assert.equal((await asJson(await flip(true))).disabled, true);
  assert.equal(index.jobGet(job)?.disabled, true);
  assert.deepEqual(index.jobsPending("resim"), [], "and nothing is offered it");
  assert.equal(index.jobClaim(job), false, "nor can a daemon that knows the id take it");

  // It rides both open job reads, so the row can say so.
  assert.equal((await asJson(await app.request(`/api/jobs/${job}`, {}, env))).disabled, true);
  assert.equal((await asJson(await app.request("/api/queue", {}, env))).jobs[0].disabled, true);

  // A held-back job still BLOCKS a new one for the same game — walking around
  // it with a fresh row is exactly what "will not be picked up" rules out —
  // and the paste box is told why rather than "already queued".
  const again = await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env);
  assert.equal(again.status, 409);
  assert.equal((await asJson(again)).status, "disabled");

  assert.equal((await asJson(await flip(false))).disabled, false);
  assert.equal(index.jobsPending("resim").length, 1, "and it is work again");

  assert.equal((await flip("yes")).status, 400);
  assert.equal((await flip(true, "nope")).status, 404);
});

// A queue of bare game ids cannot answer the first question anyone has about a
// re-sim that will run for an hour — is this an 8v8 worth the machine time, or
// a three-minute duel? The jobs table knows only an id, so the worker joins the
// game's own facts onto each row.
test("queue rows carry the game's size and duration", async (t) => {
  const { env, index } = makeEnv();
  stubBarApi(t, new Set([RESIM_ID]));
  index.upsert({ id: RESIM_ID, durationSec: 2417, gameSize: "8v8" } as ReplayEntry);
  index.jobInsert("known", "", RESIM_ID, "resim");
  // A game neither the catalog nor the mirror has heard of: a drag&drop upload
  // from a private lobby. The row still lists, it just has nothing to say.
  index.jobInsert("stranger", "streams/x", "ffffffffffffffffffffffffffffffff");

  const page = await asJson(await app.request("/api/queue", {}, env));
  const byId = Object.fromEntries(page.jobs.map((j: { id: string }) => [j.id, j]));
  assert.deepEqual(byId.known.game, { durationSec: 2417, gameSize: "8v8" });
  assert.equal(byId.stranger.game, null);
});

// A queue full of red rows should say which failures are the MACHINE's fault
// rather than the game's, without anyone parsing a sentence. The daemon
// classifies what it can and the worker carries it, from a closed set — the
// page renders each kind specifically, so an unknown one has nothing to render.
test("a failure carries its kind, from a closed set", async (t) => {
  const { env } = makeEnv();
  stubBarApi(t, new Set([RESIM_ID]));
  const { job } = await asJson(
    await app.request("/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }, env),
  );
  const post = (body: unknown) =>
    app.request(`/api/jobs/${job}`, { method: "POST", body: JSON.stringify(body) }, env);
  const read = async () => await asJson(await app.request(`/api/jobs/${job}`, {}, env));

  assert.equal((await post({ state: "error", error: "host ran out of memory", errorKind: "oom" })).status, 200);
  let j = await read();
  assert.equal(j.errorKind, "oom");
  assert.equal((await asJson(await app.request("/api/queue", {}, env))).jobs[0].errorKind, "oom");

  // A kind this worker does not know is DROPPED, never a 400: a daemon newer
  // than the worker must still be able to report that its job failed.
  assert.equal((await post({ state: "error", error: "something new", errorKind: "meteor" })).status, 200);
  j = await read();
  assert.equal(j.error, "something new", "the failure still landed");
  assert.equal(j.errorKind, null);

  // It follows the message rather than sticking: a job that goes on to succeed
  // is not still classified by how it failed last time.
  assert.equal((await post({ state: "error", error: "oom again", errorKind: "oom" })).status, 200);
  assert.equal((await read()).errorKind, "oom");
  assert.equal((await post({ state: "done" })).status, 200);
  j = await read();
  assert.equal(j.error, null);
  assert.equal(j.errorKind, null, "a cleared message clears its classification");
});

test("an uncaught route error answers 500 and logs the message", async () => {
  // The one live diagnostic for a Durable Object that fails on every call:
  // Hono's default handler answered with a bare "Internal Server Error" and
  // the log event kept only the stack FRAMES, so an outage's cause was
  // unreadable. The onError hook must put the message itself in the log.
  const { env } = makeEnv();
  (env as unknown as { REPLAY_INDEX: unknown }).REPLAY_INDEX = {
    idFromName: () => ({}),
    get: () => ({
      list: () => {
        throw new Error("Exceeded allowed rows read");
      },
    }),
  };

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    const res = await app.request("/api/replays", {}, env);
    assert.equal(res.status, 500);
    assert.equal(await res.text(), "Internal Server Error", "the body stays generic — nothing internal leaks");
  } finally {
    console.error = realError;
  }
  const line = logged.join("\n");
  assert.match(line, /Exceeded allowed rows read/, "the error's own message is in the log");
  assert.match(line, /GET \/api\/replays/, "so is the request that hit it");
});

test("the maps route serves the DO's maintained list", async () => {
  const { env, index } = makeEnv();
  (index as unknown as { mapNames: () => string[] }).mapNames = () => ["All That Glitters v2", "Great Divide V1"];
  const res = await app.request("/api/replays/maps", {}, env);
  assert.equal(res.status, 200);
  assert.deepEqual(await asJson(res), { maps: ["All That Glitters v2", "Great Divide V1"] });
  // Open and no-cache, like the listing it accompanies: the front-end probes
  // it on every list view, and staleness is the DO cache's business.
  assert.equal(res.headers.get("cache-control"), "no-cache");
});

test("the sqlstats route serves the DO's tally as-is", async () => {
  const { env, index } = makeEnv();
  const report = { since: 123, elapsedSec: 45, ops: [], totals: { rowsRead: 0, rowsWritten: 0 } };
  (index as unknown as { sqlStatsReport: () => unknown }).sqlStatsReport = () => report;
  const res = await app.request("/api/sqlstats", {}, env);
  assert.equal(res.status, 200);
  assert.deepEqual(await asJson(res), report);
});

// The games-mirror backfill route: a guarded write door for games the cron's
// 2h window can't reach. It maps verbatim BAR replay details, dedups against
// what the mirror has, and inserts the rest — making no outbound call itself.
const detailBody = (id: string) => ({
  id,
  startTime: "2026-09-04T10:00:00.000Z",
  durationMs: 3000000,
  Map: { scriptName: "Supreme Isthmus", fileName: "supreme_isthmus" },
  gameSettings: { ranked_game: "1" },
  AllyTeams: [
    { allyTeamId: 0, Players: [{ name: "a", skill: "[20]" }], AIs: [] },
    { allyTeamId: 1, Players: [{ name: "b", skill: "[21]" }], AIs: [] },
  ],
});

test("backfill inserts new mirror rows and dedups the rest", async () => {
  const { env, index } = makeEnv("tok");
  index.mirror.set("known1", {}); // already mirrored

  const res = await app.request(
    "/api/games/backfill",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify([detailBody("new1"), detailBody("new2"), detailBody("known1"), { id: 42 }, {}]),
    },
    env,
  );
  assert.equal(res.status, 200);
  // received counts the whole batch; fresh/inserted only the two new valid ids.
  assert.deepEqual(await asJson(res), { received: 5, fresh: 2, inserted: 2 });
  assert.ok(index.mirror.has("new1") && index.mirror.has("new2"));
  // The row went through gameFromApi: its fields are populated, not the raw detail.
  assert.equal((index.mirror.get("new1") as { map?: string }).map, "Supreme Isthmus");
});

test("backfill needs the write token and rejects junk bodies", async () => {
  const { env } = makeEnv("tok");
  const noAuth = await app.request(
    "/api/games/backfill",
    { method: "POST", headers: { "content-type": "application/json" }, body: "[]" },
    env,
  );
  assert.equal(noAuth.status, 401);

  const notArray = await app.request(
    "/api/games/backfill",
    { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: "{}" },
    env,
  );
  assert.equal(notArray.status, 400);

  // An open deployment (no token configured) accepts it, like the other writes.
  const { env: openEnv } = makeEnv();
  const open = await app.request(
    "/api/games/backfill",
    { method: "POST", headers: { "content-type": "application/json" }, body: "[]" },
    openEnv,
  );
  assert.equal(open.status, 200);
  assert.deepEqual(await asJson(open), { received: 0, fresh: 0, inserted: 0 });
});

// ---- the admin gate (Cloudflare Access) -------------------------------------
// The routes the admin UI drives answer 401 to anyone without an identity.
// Three identities count: ADMIN_OPEN (dev), the configured bearer token, and
// a verified Access JWT (tests/access.test.ts covers the verifier itself;
// here a token the test signs proves the route reads the cookie and the
// configuration). Unconfigured Access is closed, not open.
const ADMIN_ROUTES: [string, RequestInit][] = [
  ["/api/queue", {}],
  ["/api/sqlstats", {}],
  ["/api/jobs/x/samples", {}],
  ["/api/resim", { method: "POST", body: JSON.stringify({ link: RESIM_ID }) }],
  ["/api/replays/x/view", { method: "POST", body: JSON.stringify({ view: "full" }) }],
  ["/api/replays/x/refresh-settings", { method: "POST" }],
  ["/api/jobs/x/disabled", { method: "POST", body: JSON.stringify({ disabled: true }) }],
];

test("admin routes are closed without an identity, and closed when Access is not configured", async () => {
  const { env, index } = makeEnv(undefined, {});
  for (const [path, init] of ADMIN_ROUTES) {
    const res = await app.request(path, init, env);
    assert.equal(res.status, 401, `${init.method ?? "GET"} ${path}`);
    const body = await asJson(res);
    assert.equal(body.login, "/admin/login", "the reply says where the login is");
    assert.equal(body.configured, false, "and that this deployment has none");
  }
  assert.equal(index.jobs.size, 0, "nothing got queued");

  // Configured but no cookie: still 401, now saying sign in.
  const { env: cfg } = makeEnv(undefined, { ACCESS_TEAM_DOMAIN: "example", ACCESS_AUD: "a".repeat(64) });
  const res = await app.request("/api/queue", {}, cfg);
  assert.equal(res.status, 401);
  assert.equal((await asJson(res)).configured, true);
  const me = await app.request("/api/admin/me", {}, cfg);
  assert.equal(me.status, 401);

  // The open routes stay open: an uploader's poll, the catalog, the games.
  for (const path of ["/api/jobs/x", "/api/replays", "/api/games", "/api/health"]) {
    const r = await app.request(path, {}, cfg);
    assert.notEqual(r.status, 401, path);
  }
});

test("the daemons' bearer token is an admin identity — only when it is configured", async () => {
  const { env } = makeEnv("s3cret", {});
  const denied = await app.request("/api/queue", {}, env);
  assert.equal(denied.status, 401);
  const wrong = await app.request("/api/queue", { headers: { authorization: "Bearer nope" } }, env);
  assert.equal(wrong.status, 401);
  const ok = await app.request("/api/queue", { headers: { authorization: "Bearer s3cret" } }, env);
  assert.equal(ok.status, 200);
  const me = await asJson(await app.request("/api/admin/me", { headers: { authorization: "Bearer s3cret" } }, env));
  assert.deepEqual(me, { email: null, via: "token" });

  // No token configured: `authorized` is open for the daemon routes (a dev
  // bucket), but that openness must not leak into the admin gate.
  const { env: open } = makeEnv(undefined, {});
  assert.equal((await app.request("/api/queue", { headers: { authorization: "Bearer " } }, open)).status, 401);
});

test("a verified Access cookie is an admin identity", async (t) => {
  const TEAM = "example";
  const AUD = "c".repeat(64);
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const b64url = (v: Uint8Array | string) =>
    btoa(typeof v === "string" ? v : String.fromCharCode(...v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sign = async (claims: object) => {
    const h = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
    const p = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  };
  const orig = globalThis.fetch;
  const certs = `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === certs) return Response.json({ keys: [{ kid: "k1", kty: "RSA", n: jwk.n, e: jwk.e }] });
    return new Response("not stubbed: " + String(input), { status: 500 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = orig;
  });
  const now = Math.floor(Date.now() / 1000);
  const claims = (over: object = {}) => ({
    aud: [AUD], iss: `https://${TEAM}.cloudflareaccess.com`, sub: "u1", email: "me@example.org",
    exp: now + 600, iat: now - 1, ...over,
  });

  const { env } = makeEnv(undefined, { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
  const good = await sign(claims());
  const me = await app.request("/api/admin/me", { headers: { cookie: `CF_Authorization=${good}` } }, env);
  assert.equal(me.status, 200);
  assert.deepEqual(await asJson(me), { email: "me@example.org", via: "access" });
  assert.equal((await app.request("/api/queue", { headers: { cookie: `CF_Authorization=${good}` } }, env)).status, 200);
  // The header Access adds on the protected path works too.
  assert.equal((await app.request("/api/queue", { headers: { "cf-access-jwt-assertion": good } }, env)).status, 200);

  // Wrong application, expired, or signed by a key the team never published.
  const otherApp = await sign(claims({ aud: ["d".repeat(64)] }));
  assert.equal((await app.request("/api/queue", { headers: { cookie: `CF_Authorization=${otherApp}` } }, env)).status, 401);
  const expired = await sign(claims({ exp: now - 1 }));
  assert.equal((await app.request("/api/queue", { headers: { cookie: `CF_Authorization=${expired}` } }, env)).status, 401);
  const wrongTeam = makeEnv(undefined, { ACCESS_TEAM_DOMAIN: "someone-else", ACCESS_AUD: AUD }).env;
  assert.equal((await app.request("/api/queue", { headers: { cookie: `CF_Authorization=${good}` } }, wrongTeam)).status, 401,
    "a token for another team is refused before any key is fetched");
});

test("/admin/login sends the visitor back where they were going, on this site only", async () => {
  const { env } = makeEnv(undefined, {});
  // A non-loopback host with no assertion (the workers.dev hostname, say):
  // a plain on-site redirect, no token to forward.
  const at = (path: string, init: RequestInit = {}) => app.request(`https://replay.example${path}`, init, env);
  const plain = await at("/admin/login");
  assert.equal(plain.status, 302);
  assert.equal(plain.headers.get("location"), "/queue?admin=true");
  const next = await at("/admin/login?next=%2Freplays%2Fabc%3Fadmin%3Dtrue");
  assert.equal(next.headers.get("location"), "/replays/abc?admin=true");
  const evil = await at("/admin/login?next=https%3A%2F%2Fevil.example%2F");
  assert.equal(evil.headers.get("location"), "/queue?admin=true", "no open redirect");
  // A loopback callback named by the link, but no assertion to forward
  // (Access did not run): still the on-site redirect, never the callback.
  const cbNoTok = await at("/admin/login?next=" + encodeURIComponent("http://127.0.0.1:5173/admin/callback?next=%2Fqueue"));
  assert.equal(cbNoTok.headers.get("location"), "/queue?admin=true");
});

// The dev login: a `vite dev` server borrows the deployed site's Access
// login in three hops (app.ts has the picture). What matters: the token only
// ever travels to a loopback callback, and the callback only stores a token
// that verifies for this deployment.
test("dev login: a loopback server bounces to the deployed login asking for its callback", async () => {
  const { env } = makeEnv(undefined, {});
  const r = await app.request("http://127.0.0.1:5173/admin/login?next=%2Fqueue%3Fadmin%3Dtrue", {}, env);
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get("location")!);
  assert.equal(to.origin + to.pathname, "https://replay.fogofwar.dev/admin/login");
  assert.equal(to.searchParams.get("next"), "http://127.0.0.1:5173/admin/callback?next=%2Fqueue%3Fadmin%3Dtrue");

  // localhost and [::1] count; a loopback host that already carries the
  // assertion is not hop 1 (it is the deployed handler under test), and a
  // public host never bounces.
  const lh = await app.request("http://localhost:8787/admin/login", {}, env);
  assert.match(lh.headers.get("location")!, /^https:\/\/replay\.fogofwar\.dev\/admin\/login\?next=http%3A%2F%2Flocalhost%3A8787%2Fadmin%2Fcallback/);
  const pub = await app.request("https://replay.example/admin/login", {}, env);
  assert.equal(pub.headers.get("location"), "/queue?admin=true");
});

test("dev login: the deployed login forwards the Access token to a loopback callback and nowhere else", async () => {
  const { env } = makeEnv(undefined, {});
  const withTok = (next: string) =>
    app.request(`https://replay.example/admin/login?next=${encodeURIComponent(next)}`,
      { headers: { "cf-access-jwt-assertion": "the.access.token" } }, env);

  for (const cb of ["http://127.0.0.1:5173/admin/callback?next=%2Fqueue%3Fadmin%3Dtrue",
                    "http://localhost:8787/admin/callback",
                    "http://[::1]:5173/admin/callback"]) {
    const r = await withTok(cb);
    assert.equal(r.status, 302, cb);
    const to = new URL(r.headers.get("location")!);
    assert.equal(to.origin + to.pathname, new URL(cb).origin + "/admin/callback", cb);
    assert.equal(to.searchParams.get("token"), "the.access.token", cb);
  }
  // Not loopback, not the callback path, not http, or carrying a fragment or
  // credentials: the token goes nowhere, the visitor gets the on-site page.
  for (const bad of ["https://evil.example/admin/callback", "http://127.0.0.1.evil.example/admin/callback",
                     "http://127.0.0.1:5173/steal", "https://127.0.0.1:5173/admin/callback",
                     "http://127.0.0.1:5173/admin/callback#x", "http://u:p@127.0.0.1:5173/admin/callback",
                     "/queue?admin=true"]) {
    const r = await withTok(bad);
    assert.equal(r.headers.get("location"), "/queue?admin=true", bad);
    assert.ok(!r.headers.get("location")!.includes("the.access.token"), bad);
  }
  // With the assertion but an on-site next: the ordinary redirect.
  const onsite = await withTok("/replays/abc?admin=true");
  assert.equal(onsite.headers.get("location"), "/replays/abc?admin=true");
});

test("dev login: the callback stores a token that verifies, refuses one that does not, and logout clears it", async (t) => {
  // Its own team domain: app.ts holds ONE verifier for the isolate, whose
  // jose key-set cache (keyed by the certs URL, held for the cooldown) still
  // has the keypair an earlier test published for "example".
  const TEAM = "example-dev";
  const AUD = "e".repeat(64);
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const b64url = (v: Uint8Array | string) =>
    btoa(typeof v === "string" ? v : String.fromCharCode(...v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sign = async (claims: object) => {
    const h = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
    const p = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  };
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ kid: "k1", kty: "RSA", n: jwk.n, e: jwk.e }] });
    }
    return new Response("not stubbed", { status: 500 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = orig; });
  const now = Math.floor(Date.now() / 1000);
  const good = await sign({ aud: [AUD], iss: `https://${TEAM}.cloudflareaccess.com`, sub: "u1", email: "me@example.org", exp: now + 600, iat: now });
  const foreign = await sign({ aud: ["f".repeat(64)], iss: `https://${TEAM}.cloudflareaccess.com`, sub: "u1", exp: now + 600, iat: now });

  const { env } = makeEnv(undefined, { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
  const base = "http://127.0.0.1:5173";
  const cb = await app.request(`${base}/admin/callback?token=${good}&next=%2Fqueue%3Fadmin%3Dtrue`, {}, env);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/queue?admin=true");
  const cookie = cb.headers.get("set-cookie")!;
  assert.match(cookie, new RegExp(`^CF_Authorization=${good.replace(/[.+]/g, "\\$&")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+$`));
  assert.ok(!cookie.includes("Secure"), "plain http dev server: no Secure flag");
  const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1]);
  assert.ok(maxAge > 500 && maxAge <= 600, `cookie expires with the token: ${maxAge}`);

  // And that cookie is an admin identity from then on, with the real email.
  const me = await app.request(`${base}/api/admin/me`, { headers: { cookie: `CF_Authorization=${good}` } }, env);
  assert.equal(me.status, 200);
  assert.equal((await asJson(me)).email, "me@example.org");

  // A token for another application, or none: refused, no cookie set.
  const bad = await app.request(`${base}/admin/callback?token=${foreign}`, {}, env);
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("set-cookie"), null);
  assert.equal((await app.request(`${base}/admin/callback`, {}, env)).status, 400);
  // Unconfigured deployment: nothing to verify against, so nothing stored.
  const { env: open } = makeEnv(undefined, {});
  assert.equal((await app.request(`${base}/admin/callback?token=${good}`, {}, open)).status, 401);

  // Logout clears the cookie on this origin; Secure rides on https.
  const out = await app.request(`${base}/admin/logout`, {}, env);
  assert.equal(out.status, 302);
  assert.equal(out.headers.get("set-cookie"), "CF_Authorization=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  const outHttps = await app.request("https://replay.example/admin/logout", {}, env);
  assert.match(outHttps.headers.get("set-cookie")!, /; Secure; Max-Age=0$/);
});
