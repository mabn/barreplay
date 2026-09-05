// A Hono app that serves the replay data out of R2 and falls back to the
// static-asset SPA for everything else.
//
// There is no dynamic playback logic here. The viewer fetches plain files that
// `barreplay-static` (Go) precomputed and we synced into the R2 bucket:
//
//   /index.json                 the replay picker listing
//   /replays/<id>.brw           one capture's head (meta, teams, icons, chunk index)
//   /replays/<id>.resources     gzipped per-frame team economy
//   /replays/<id>.keys          every chunk's keyframe, one gzip stream — the viewer
//                               streams this first, so the whole timeline is
//                               scrubbable before any chunk arrives
//   /replays/<id>/c<n>          one frame chunk's DELTA frames (absent when the
//                               chunk is a single frame)
//
// These are served straight from R2 (with Range support kept for good measure).
// The SPA, unit icons (/icons/*) and rank icons (/ranks/*) are fixed static
// assets served by the ASSETS binding before the Worker even runs.

// The Hono app with every route. Split from index.ts (the wrangler entry
// point, which re-exports the ReplayIndex Durable Object class) so this file
// has no `cloudflare:workers` import anywhere in its module graph — the
// node-side tests (tsx --test) drive the real routes via app.request() with a
// fake Env.
import { Hono } from "hono";

import { encodeGamesCursor, parseGamesCursor } from "./games";
import { parseGameId } from "./gameid";
import { JOB_KINDS, parseJobErrorKind, parseJobProgress, parseJobStats } from "./jobs";
import type { JobKind } from "./jobs";
import { archiveSuffix, scanStreamPreamble } from "./preamble";
import { parseReplayFilter, parseViewRequest, playersFromApi, sanitizeEntry, settingsFlags } from "./replayentry";

/** Upload size cap: keeps a whole raw stream inside Worker memory. Real
 * streams are single-digit MB (~6.5x smaller than the text format), so this
 * is very generous — sized for the outliers, like a full-view capture of a
 * marathon game. Note Cloudflare's own request-body limit still applies in
 * front of the Worker and follows the ZONE's plan (100 MB on Free/Pro): on
 * such a zone the edge 413s anything past that before this cap is consulted. */
const MAX_UPLOAD = 150 << 20;

const app = new Hono<{ Bindings: Env }>();

// Without this, Hono's default handler answers an uncaught error with a bare
// "Internal Server Error" and the MESSAGE never reaches the logs: the
// observability event keeps only the async stack frames, which is useless for
// an error thrown inside the Durable Object (observed live — every DO route
// 500ing with no way to read why). Log the whole story on one line — method,
// path, message, stack — and keep the response the same generic 500 the
// default sent, so nothing internal leaks to the caller.
app.onError((err, c) => {
  console.error(`unhandled error on ${c.req.method} ${c.req.path}: ${err.message}\n${err.stack ?? ""}`);
  return c.text("Internal Server Error", 500);
});

app.get("/api/health", (c) => c.json({ status: "ok" }));

// What each Durable Object method has cost in SQLite rows since its instance
// started — the live counterpart of the rowcost test suite, for asking "which
// endpoint is spending the daily row budgets" of the running deployment
// instead of the code. Open like the other admin reads: counts leak nothing.
// The window is the instance's lifetime (`since`/`elapsedSec` in the reply);
// a deploy or eviction resets it.
app.get("/api/sqlstats", async (c) => c.json(await indexStub(c.env).sqlStatsReport()));

// authorized checks the shared-secret guard used by every write API the
// ingest daemon / pack talk to. When the REPLAY_PUT_TOKEN secret is not
// configured (local dev) the guard is open.
const authorized = (c: { env: Env; req: { header(name: string): string | undefined } }): boolean => {
  const token = c.env.REPLAY_PUT_TOKEN;
  return !token || c.req.header("authorization") === `Bearer ${token}`;
};

// The replay catalog lives in the ReplayIndex Durable Object (one SQLite
// table, single instance). GET lists every replay with its picker stats,
// most recent game first; PUT is an upsert called by `pack -upload` right
// after a replay's static files land in the bucket.
export const indexStub = (env: Env) => env.REPLAY_INDEX.get(env.REPLAY_INDEX.idFromName("index"));

// Query params narrow the listing (parseReplayFilter documents them); no
// params means the whole catalog, so an older front-end sees no change. The
// filtering is SQL, not a pass over the JSON, because the list is the one
// endpoint whose cost grows with the archive.
/** Most rows one listing will hand out. The page is 50; the front-end asks
 * for 51 so the extra row can say "there is more". */
const CATALOG_LIMIT_MAX = 200;

app.get("/api/replays", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const filter = parseReplayFilter(params);
  if (typeof filter === "string") return c.json({ error: filter }, 400);
  // ?limit=&offset= page the listing. Absent limit = the whole thing, which
  // is what bringest's catalog scan and any pre-paging front-end ask for.
  const num = (key: string): number => {
    const n = parseInt(params.get(key) ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const limit = Math.min(num("limit"), CATALOG_LIMIT_MAX);
  const list = await indexStub(c.env).list(filter, limit, num("offset"));
  return c.json(list, 200, { "cache-control": "no-cache" });
});

// The catalog's distinct map names, for the filter bar's combobox — the one
// filter whose choices cannot be hardcoded (the settings vocabulary is a
// constant, the ranges need no list, the player field is free text). Served
// from a maintained list behind a one-minute in-memory cache in the DO
// (ReplayIndex.mapNames), so it costs one row read a minute where the facets
// endpoint it replaces scanned the whole catalog per call. Doubles as the
// front-end's probe for "does this backend filter at all": the Go viz server
// 404s it and the filter bar stays hidden there.
app.get("/api/replays/maps", async (c) => {
  const maps = await indexStub(c.env).mapNames();
  return c.json({ maps }, 200, { "cache-control": "no-cache" });
});

// Writes are guarded by a shared secret when the REPLAY_PUT_TOKEN secret is
// configured on the Worker (`wrangler secret put REPLAY_PUT_TOKEN`); without
// it (local dev) the endpoint is open.
app.put("/api/replays/:id", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const entry = sanitizeEntry(c.req.param("id"), body);
  if (typeof entry === "string") return c.json({ error: entry }, 400);
  // The id the row's re-simulation would be queued under, if this publish
  // leaves the game one-sided (ReplayIndex.upsert decides; most publishes do
  // not, and an unused uuid costs nothing). Generated HERE, like every other
  // job id, so the Durable Object stays deterministic under test.
  await indexStub(c.env).upsert(entry, crypto.randomUUID());
  return c.json({ ok: true });
});

// Admin settings-refresh: re-derive one catalog row's settings badges AND
// players roster from the BAR API's stored demo metadata (its replay detail
// carries the demo's gameSettings verbatim plus the AllyTeams roster),
// without repacking or re-uploading the replay — useful when the badge
// distillation gains a new flag after a replay was published, or when the
// original upload ran demo-less. The endpoint is deliberately open: it can
// only write values derived from the public authoritative API for the row's
// own game id, so there is nothing to forge.
// Hand-mark whose point of view a replay was recorded from. Most rows carry no
// recorder provenance — their captures predate the GAME record's recorder
// fields — and nothing can derive it after the fact, so the viewer offers this
// as an explicit marking. Open like refresh-settings above: it writes only a
// three-valued label plus an ally id onto the row's own game, nothing forgeable.
app.post("/api/replays/:id/view", async (c) => {
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return c.json({ error: "invalid replay id" }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const parsed = parseViewRequest(body);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  const ok = await indexStub(c.env).setView(id, parsed.view, parsed.ally);
  if (!ok) return c.json({ error: "no catalog row for this replay" }, 404);
  return c.json({ ok: true, view: parsed.view, ally: parsed.ally });
});

app.post("/api/replays/:id/refresh-settings", async (c) => {
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return c.json({ error: "invalid replay id" }, 400);
  let detail: { gameSettings?: Record<string, unknown>; AllyTeams?: unknown };
  try {
    const r = await fetch(`https://api.bar-rts.com/replays/${encodeURIComponent(id)}`);
    if (r.status === 404) return c.json({ error: "the BAR API does not know this game" }, 404);
    if (!r.ok) return c.json({ error: `BAR API: ${r.status}` }, 502);
    detail = await r.json();
  } catch (e) {
    return c.json({ error: `fetching the BAR API: ${e}` }, 502);
  }
  if (typeof detail?.gameSettings !== "object" || detail.gameSettings === null) {
    return c.json({ error: "the BAR API reply carries no gameSettings" }, 502);
  }
  // The API serves modoption values as strings; coerce defensively.
  const mo: Record<string, string> = {};
  for (const [k, v] of Object.entries(detail.gameSettings)) mo[k] = String(v);
  const settings = settingsFlags(mo);
  const players = playersFromApi(detail.AllyTeams);
  const ok = await indexStub(c.env).refreshFromApi(id, settings, players);
  if (!ok) return c.json({ error: "no catalog row for this replay" }, 404);
  return c.json({ ok: true, settings, players });
});

// Drag&drop upload: the Worker does NOT transcode (the viewer's .brp wire is
// produced by the Go pipeline). It validates the stream's preamble, archives
// the raw bytes under streams/<gameId>/ — a prefix /index.json never lists and
// /replays/* never serves, and from which nothing is ever deleted — and
// records a pending job for the ingest daemon (cmd/bringest), which
// polls, transcodes, publishes the pieces under a fresh revision id, and
// reports back. The browser polls GET /api/jobs/<id> to follow along.
app.post("/api/upload", async (c) => {
  const declared = parseInt(c.req.header("content-length") ?? "", 10);
  if (declared > MAX_UPLOAD) return c.json({ error: `upload exceeds ${MAX_UPLOAD} bytes` }, 413);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.length > MAX_UPLOAD) return c.json({ error: `upload exceeds ${MAX_UPLOAD} bytes` }, 413);

  const p = scanStreamPreamble(body);
  if (typeof p === "string") return c.json({ error: p }, 400);

  // The key carries a hash of the BYTES, because nothing else in it is unique.
  // Two players on the same ally team uploading the same game — or one player
  // uploading a half-game capture and then the full one — agree on gameId and
  // on archiveSuffix, leaving only the timestamp to separate them. In Workers
  // Date.now() is clamped to the time of the last I/O and does not advance
  // during a request, so concurrent uploads genuinely collide: the second PUT
  // overwrote the first, and both jobs then pointed at one key holding one
  // player's bytes while the other's were silently gone.
  //
  // The timestamp stays first so the prefix still sorts oldest-first, which
  // means this is NOT full content addressing: re-uploading identical bytes
  // archives them again rather than deduplicating. That is the deliberate
  // trade — the hash is here to guarantee distinctness, not to collapse
  // duplicates, and a duplicate costs one object while a collision costs
  // somebody's capture.
  const digest = await crypto.subtle.digest("SHA-256", body as BufferSource);
  const hash = [...new Uint8Array(digest).slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const streamKey = `streams/${p.gameId}/${Date.now()}-${hash}-${archiveSuffix(p)}.brepstream`;
  await c.env.BUCKET.put(streamKey, body);

  const job = crypto.randomUUID();
  await indexStub(c.env).jobInsert(job, streamKey, p.gameId, "upload");
  return c.json({ job, gameId: p.gameId, streamKey });
});

// Queue a game NOBODY RECORDED for headless re-simulation, from a pasted
// replay link. This is the only way into the pipeline for a game with no
// .brepstream behind it: `bringest -resim` otherwise finds work by scanning
// the catalog for one-sided uploads, which by construction cannot see a game
// that was never uploaded at all.
//
// Open, like /view and /refresh-settings, because the browser holds no bearer
// token and the section it is reached from is admin-gated in the UI. What
// keeps it from being a way to burn somebody else's machine time is the
// checks: the id has to parse, the BAR API has to know the game (a re-sim
// cannot degrade past a missing demo the way an upload can — the demo IS the
// simulation input), the game must not already be published, and a second
// request for a game already queued returns the job that exists rather than
// making another.
app.post("/api/resim", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const link = (body as { link?: unknown })?.link;
  if (typeof link !== "string" || link.length > 2048) {
    return c.json({ error: "link must be a string" }, 400);
  }
  const gameId = parseGameId(link);
  if (!gameId) return c.json({ error: "no gameId in that link" }, 400);

  // Same handling as refresh-settings above: an id the BAR API does not know
  // has no demo to re-simulate, and there is no point queueing an hour of
  // engine time to discover that.
  try {
    const r = await fetch(`https://api.bar-rts.com/replays/${encodeURIComponent(gameId)}`);
    if (r.status === 404) return c.json({ error: "the BAR API does not know this game", gameId }, 404);
    if (!r.ok) return c.json({ error: `BAR API: ${r.status}`, gameId }, 502);
  } catch (e) {
    return c.json({ error: `fetching the BAR API: ${e}`, gameId }, 502);
  }

  const res = await indexStub(c.env).resimEnqueue(crypto.randomUUID(), gameId);
  if (res.status === "in-catalog") {
    return c.json({ error: "this game is already published", gameId, status: res.status }, 409);
  }
  if (res.status === "disabled") {
    return c.json(
      { error: "this game's job has been disabled; re-enable it on the queue page", gameId, status: res.status },
      409,
    );
  }
  return c.json({ job: res.job?.id, gameId, status: res.status });
});

// Job status for the browser that created it — a dropped stream or a pasted
// re-sim link: pending -> processing -> done|error. Open, so like /api/queue
// it answers with a subset of the row rather than the row: the archive key is
// the one field of a job that is not public.
app.get("/api/jobs/:id", async (c) => {
  const job = await indexStub(c.env).jobGet(c.req.param("id"));
  if (!job) return c.json({ error: "unknown job" }, 404);
  const { id, gameId, kind, state, error, errorKind, stats, progress, disabled, createdUnix, updatedUnix } = job;
  return c.json(
    { id, gameId, kind, state, error, errorKind, stats, progress, disabled, createdUnix, updatedUnix },
    200,
    {
      "cache-control": "no-cache",
    },
  );
});

// One job's healthcheck HISTORY: the series behind the queue page's charts,
// fetched only when a row is expanded rather than riding every queue read (a
// page of 25 rows would otherwise carry thousands of points nobody asked for).
// Open, like the per-job status and the queue itself, and for the same reason:
// it reports on public replays and can change nothing.
//
// An unknown job is an empty series, not a 404 — a job that never healthchecked
// (an upload, or anything from a daemon older than the beat) is indistinguishable
// from one that does not exist, and the view says the same thing about both.
app.get("/api/jobs/:id/samples", async (c) => {
  const samples = await indexStub(c.env).jobSamples(c.req.param("id"));
  return c.json({ samples }, 200, { "cache-control": "no-cache" });
});

// The queue as the landing page's "Queue" section shows it: unfinished jobs
// first, then what recently finished. Open, like the per-job status the
// uploading browser already polls, and for the same reason — it reports on
// public replays and can change nothing. The archive KEY is deliberately not
// in the reply: it is the one field of a job row that is not public (the
// route serving those bytes is bearer-guarded), and the view has no use for
// it.
// Paged, because the table only grows and the view shows a handful at a time:
// ?offset= and ?limit= (capped), with `total` and `active` counted over the
// whole table so the pager and the menu's in-flight count are true on any page.
const QUEUE_LIMIT_MAX = 100;
const QUEUE_LIMIT_DEFAULT = 25;

app.get("/api/queue", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const num = (name: string, fallback: number): number | string => {
    const raw = params.get(name);
    if (raw === null || raw === "") return fallback;
    if (!/^\d+$/.test(raw)) return `${name} must be a non-negative integer`;
    return parseInt(raw, 10);
  };
  const limit = num("limit", QUEUE_LIMIT_DEFAULT);
  if (typeof limit === "string") return c.json({ error: limit }, 400);
  const offset = num("offset", 0);
  if (typeof offset === "string") return c.json({ error: offset }, 400);

  const page = await indexStub(c.env).queuePage(Math.min(Math.max(limit, 1), QUEUE_LIMIT_MAX), offset);
  return c.json(
    {
      jobs: page.jobs.map(
        ({ id, gameId, kind, state, error, errorKind, stats, progress, disabled, game, createdUnix, updatedUnix }) => ({
          id,
          gameId,
          kind,
          state,
          error,
          errorKind,
          stats,
          progress,
          disabled,
          // What the game IS, joined on by the DO — the jobs table itself knows
          // only an id, and a queue of bare ids says nothing about what the
          // pipeline is actually spending its hour on.
          game,
          createdUnix,
          updatedUnix,
        }),
      ),
      total: page.total,
      active: page.active,
      offset,
    },
    200,
    { "cache-control": "no-cache" },
  );
});

// The games MIRROR as the landing page's "Games" section shows it: what BAR
// published, latest-ended first, each row saying whether this site has a
// replay of it and what its last ingest job did. Open, like the catalog: it
// reports on public games and can change nothing.
//
// CURSOR-paged: ?limit= (capped) and ?after=<cursor>, where the cursor is the
// `next` of the previous reply (null on the last page) — never an offset,
// which would read every row before the page and shift under a list that
// gains a game a minute (see ReplayIndex.gamesPage). No total, no page count:
// counting the mirror means reading a table that grows by ~2000 rows a day.
const GAMES_LIMIT_MAX = 100;
const GAMES_LIMIT_DEFAULT = 20;

app.get("/api/games", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const rawLimit = params.get("limit");
  let limit = GAMES_LIMIT_DEFAULT;
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit)) return c.json({ error: "limit must be a non-negative integer" }, 400);
    limit = Math.min(Math.max(parseInt(rawLimit, 10), 1), GAMES_LIMIT_MAX);
  }
  const rawAfter = params.get("after");
  let after = null;
  if (rawAfter !== null && rawAfter !== "") {
    after = parseGamesCursor(rawAfter);
    if (after === null) return c.json({ error: "after is not a cursor this listing issued" }, 400);
  }

  const page = await indexStub(c.env).gamesPage(limit, after);
  return c.json(
    { games: page.games, next: page.next === null ? null : encodeGamesCursor(page.next) },
    200,
    { "cache-control": "no-cache" },
  );
});

// Queue a re-sim for a game the OPEN door refuses: one that is already in the
// catalog.
//
// That refusal is right for a person pasting a link — the game is published,
// there is something to watch — but it is not right for the two cases where a
// published game still wants re-simulating: an upload that only ever saw one
// side (the publish announces those itself, ReplayIndex.upsert -> jobAnnounce,
// which is this route's own DO method), and a re-sim that FAILED, whose job row
// is the record of the attempt and whose game the paste box will now refuse
// forever. This is the door for the second one. It was the daemon's, back when
// it searched the catalog for the first.
//
// GUARDED, unlike /api/resim: this is the one door into the job table with no
// refusals behind it, and the refusals are what keep the open one from being a
// way to spend somebody else's hour of engine time. Only "resim" — an upload
// job is bytes somebody sent, and there is no stream to invent for one nobody
// uploaded.
app.post("/api/jobs", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const b = body as { gameId?: unknown; kind?: unknown };
  // Through the same parser a pasted link goes through, which for a bare id is
  // a shape check and a lowercasing — the daemon read this out of the catalog,
  // but the route cannot tell that from any other caller with the token.
  const gameId = typeof b.gameId === "string" ? parseGameId(b.gameId) : null;
  if (!gameId) return c.json({ error: "gameId must be a BAR game id" }, 400);
  if (b.kind !== undefined && b.kind !== "resim") {
    return c.json({ error: "only resim jobs can be announced" }, 400);
  }
  const res = await indexStub(c.env).jobAnnounce(crypto.randomUUID(), gameId, "resim");
  return c.json({ job: res.job?.id, gameId, status: res.status });
});

// The ingest daemon's work queue: pending jobs of ONE kind (plus stalled
// "processing" ones), oldest first. Guarded like every other write-side API.
//
// ?kind= defaults to "upload", and that default is load-bearing: a plain
// bringest needs no engine and asks without the param, so anything else would
// hand a deployed daemon a re-sim it cannot run. The daemon and the worker
// deploy independently, so the Go side skips a job of the wrong kind too
// rather than trusting this filter.
//
// A re-sim poll that finds nothing pending does not come back empty: it
// queues the newest mirrored game nothing has published yet and returns THAT
// (ReplayIndex.jobsOffer, which is where the rules are). So this GET can
// write — the id it would need is generated here, like the other two job
// creators, rather than inside the Durable Object.
app.get("/api/jobs", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const kind = new URL(c.req.url).searchParams.get("kind") ?? "upload";
  if (!JOB_KINDS.includes(kind as JobKind)) {
    return c.json({ error: `kind must be one of ${JOB_KINDS.join(", ")}` }, 400);
  }
  const jobs = await indexStub(c.env).jobsOffer(kind as JobKind, crypto.randomUUID());
  return c.json(jobs, 200, { "cache-control": "no-cache" });
});

// Daemon state transitions: claim (processing + claim:true), heartbeat
// (processing), and completion (done/error).
//
// A claim is a separate thing from a plain "processing" report because it can
// FAIL: it transitions only from pending (or a stale processing), so two
// daemons in the same poll round cannot both run the same job. It is opt-in
// via the flag rather than being how "processing" always behaves, because the
// upload daemon treats a failed transition as a job error — it would take the
// job from whoever legitimately holds it and mark it failed. A long-running
// job re-reports "processing" without the flag as a healthcheck, which keeps
// updated_unix fresh so the stale-job rule does not offer live work away — and
// carries the run's live `progress` (JobProgress), which is what the queue page
// shows instead of an hour of undifferentiated "processing".
app.post("/api/jobs/:id", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const b = body as {
    state?: unknown;
    error?: unknown;
    claim?: unknown;
    kind?: unknown;
    stats?: unknown;
    progress?: unknown;
    errorKind?: unknown;
  };
  if (b.state !== "processing" && b.state !== "done" && b.state !== "error") {
    return c.json({ error: "state must be processing, done or error" }, 400);
  }
  if (b.claim === true) {
    if (b.state !== "processing") return c.json({ error: "claim is only valid with state=processing" }, 400);
    const kind = b.kind === undefined ? "upload" : b.kind;
    if (!JOB_KINDS.includes(kind as JobKind)) {
      return c.json({ error: `kind must be one of ${JOB_KINDS.join(", ")}` }, 400);
    }
    const took = await indexStub(c.env).jobClaim(c.req.param("id"), kind as JobKind);
    if (!took) return c.json({ error: "job already claimed" }, 409);
    return c.json({ ok: true });
  }
  const detail = typeof b.error === "string" ? b.error.slice(0, 2000) : null;
  // Rejected stats are dropped, not a 400: they are a record of work that has
  // already happened, and refusing the report over them would lose the state
  // transition too.
  const stats = parseJobStats(b.stats);
  // Same handling for the same reason: a healthcheck's reading is a snapshot of
  // work already under way, and a state transition is worth more than it.
  const progress = parseJobProgress(b.progress);
  // Dropped rather than 400'd, like the stats and the progress: a daemon newer
  // than this worker must still be able to report that its job failed.
  const errorKind = parseJobErrorKind(b.errorKind);
  const ok = await indexStub(c.env).jobUpdate(c.req.param("id"), b.state, detail, stats, progress, errorKind);
  if (!ok) return c.json({ error: "unknown job" }, 404);
  return c.json({ ok: true });
});

// Hold a job back, or let it go again: the queue page's per-row switch.
//
// Disabling does NOT reach out and stop an engine that is already running —
// nothing here can, the daemon is on somebody else's machine behind NAT. It
// stops the job being handed out (or handed out AGAIN, which for a re-sim of a
// mirrored game is the thing worth preventing: the backfill's "no job row at
// all" rule means a disabled row keeps its game out of the auto-queue for
// good), and it resets a "processing" row to pending, since leaving it claimed
// would only mean waiting out the stale window before it was re-offered.
//
// Open, like the other two maintenance routes the admin UI drives
// (/refresh-settings and /view): the browser has no bearer token, and the
// Queue section that shows the control is itself only reachable with
// ?admin=true. Guarding it would mean the button could not exist.
app.post("/api/jobs/:id/disabled", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const disabled = (body as { disabled?: unknown }).disabled;
  if (typeof disabled !== "boolean") return c.json({ error: "disabled must be a boolean" }, 400);
  const ok = await indexStub(c.env).jobSetDisabled(c.req.param("id"), disabled);
  if (!ok) return c.json({ error: "unknown job" }, 404);
  return c.json({ ok: true, disabled });
});

// Archived raw streams for the ingest daemon (which speaks only HTTP to the
// worker — no S3 credentials needed on the read side). Guarded: the archive
// is not public, unlike the published replay pieces.
app.get("/api/streams/:gameId/:file", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const key = `streams/${c.req.param("gameId")}/${c.req.param("file")}`;
  return serveR2(c.env.BUCKET, key, c.req.raw, false);
});

// The replay listing is built live from the bucket (list the replays/ prefix), so
// uploading a single replay's files makes it appear with no index.json to maintain.
app.get("/index.json", (c) => handleIndex(c.env.BUCKET));
app.on(["GET", "HEAD"], "/replays/*", (c) => {
  const key = c.req.path.slice(1); // strip leading "/"
  return serveR2(c.env.BUCKET, key, c.req.raw, true);
});

// Trusted piece writes: PUT the exact key the viewer will GET. This is how
// `pack -upload local` and the ingest daemon's local mode seed the dev
// simulator's bucket quickly (it is otherwise only writable via `wrangler r2
// object put` — one ~1s node startup per object, serially); it works against
// a deployed worker too when the bearer secret authorizes it. The publisher
// remains responsible for the .brw-last ordering (the listing barrier).
app.put("/replays/*", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const key = c.req.path.slice(1);
  if (!/^replays\/[A-Za-z0-9_\-.]+(\/[A-Za-z0-9_\-.]+)*$/.test(key) || key.includes("..")) {
    return c.json({ error: "invalid key" }, 400);
  }
  const declared = parseInt(c.req.header("content-length") ?? "", 10);
  if (declared > MAX_UPLOAD) return c.json({ error: `object exceeds ${MAX_UPLOAD} bytes` }, 413);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.length > MAX_UPLOAD) return c.json({ error: `object exceeds ${MAX_UPLOAD} bytes` }, 413);
  // Store the HTTP metadata rather than relying on serveR2 to add it: the
  // bucket is also read through its OWN hostname (cdn-bar.fogofwar.dev), where
  // R2 replies with exactly what is stored and no Worker gets to fix it up.
  // Derived from the key, not from the request headers, so every transport
  // (S3, wrangler, this route) leaves the bucket in the same state.
  const meta = objectHTTPMeta(key);
  await c.env.BUCKET.put(key, body, {
    httpMetadata: { contentType: meta.contentType, cacheControl: meta.cacheControl },
  });
  return c.json({ ok: true });
});

// The SPA entry is routed through the Worker (assets.run_worker_first in
// wrangler.jsonc) so it is served no-cache: its subresource URLs carry a
// content hash (/app.js?v=…, stamped by the Vite asset-rev plugin), so a
// revalidated index.html is all a UI deploy needs to reach every browser —
// the hashed js/css URLs change and get refetched automatically.
const serveEntry = async (c: { env: Env; req: { raw: Request } }) => {
  const r = await c.env.ASSETS.fetch(c.req.raw);
  const h = new Headers(r.headers);
  h.set("cache-control", "no-cache");
  return new Response(r.body, { status: r.status, headers: h });
};
app.get("/", serveEntry);
app.get("/index.html", serveEntry);

// The widget-install guide (public/setup.html), linked from the landing page's
// dropzone. The asset layer resolves the extensionless /setup to setup.html on
// its own; this route exists only to serve it no-cache, like the SPA entry
// above, so an edit to the guide reaches everyone on a plain reload.
//
// It must NOT rewrite the path to /setup.html. The asset layer's default HTML
// handling (auto-trailing-slash) answers a .html URL with a 307 to the
// extensionless form — which comes straight back here, so the rewrite made
// /setup an infinite redirect loop while every local test still passed.
app.get("/setup", async (c) => {
  const r = await c.env.ASSETS.fetch(c.req.raw);
  const h = new Headers(r.headers);
  h.set("cache-control", "no-cache");
  return new Response(r.body, { status: r.status, headers: h });
});

// Non-R2, non-API requests reach the Worker only when no static asset matched.
// Hand them to the SPA fallback.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

// handleIndex builds the replay picker listing by scanning the bucket's replays/
// prefix — one entry per replay (a <id>.brw exists), with size = the sum of that
// replay's objects (head + resources + chunks). No index.json object is needed, so
// a single-replay upload is self-sufficient.
const REPLAY_PREFIX = "replays/";

async function handleIndex(bucket: R2Bucket): Promise<Response> {
  const sizes = new Map<string, number>();
  const replays = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: REPLAY_PREFIX, cursor, limit: 1000 });
    for (const o of page.objects) {
      const rest = o.key.slice(REPLAY_PREFIX.length);
      const slash = rest.indexOf("/");
      let id: string;
      if (slash >= 0) {
        id = rest.slice(0, slash); // replays/<id>/c<n>
      } else if (rest.endsWith(".brw")) {
        id = rest.slice(0, -".brw".length);
        replays.add(id); // the marker file for a valid replay
      } else if (rest.endsWith(".resources")) {
        id = rest.slice(0, -".resources".length);
      } else if (rest.endsWith(".keys")) {
        id = rest.slice(0, -".keys".length);
      } else {
        id = rest;
      }
      sizes.set(id, (sizes.get(id) ?? 0) + o.size);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const list = [...replays]
    .sort()
    .map((id) => ({ file: id, gameId: id, size: sizes.get(id) ?? 0 }));
  return Response.json(list, { headers: { "cache-control": "no-cache" } });
}

// serveR2 streams an object out of the bucket, honoring a byte Range request
// (used by the viewer's keyframe skim). `immutable` marks per-replay files that
// never change once written; index.json is revalidated instead.
async function serveR2(bucket: R2Bucket, key: string, req: Request, immutable: boolean): Promise<Response> {
  const rangeHeader = req.headers.get("range");
  const parsed = parseRange(rangeHeader);
  const obj = await bucket.get(key, parsed ? { range: parsed } : undefined);
  if (!obj) return new Response("not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers); // content-type/-encoding stored at upload time
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  // Recomputed rather than trusted from storage, so objects uploaded before
  // upload-time metadata existed still serve correctly on this hostname.
  // `immutable` distinguishes the published pieces from the guarded stream
  // archive, which is re-read by the ingest daemon and must revalidate.
  const meta = objectHTTPMeta(key);
  headers.set("cache-control", immutable ? meta.cacheControl : "no-cache");
  headers.set("content-type", meta.contentType);

  const body = "body" in obj ? obj.body : null;
  if (req.method === "HEAD") {
    headers.set("content-length", String(obj.size));
    return new Response(null, { headers });
  }
  // A satisfiable Range yields 206 with Content-Range; otherwise the full object.
  if (parsed && obj.range) {
    const start = "offset" in obj.range && obj.range.offset !== undefined ? obj.range.offset : 0;
    const length =
      "length" in obj.range && obj.range.length !== undefined ? obj.range.length : obj.size - start;
    headers.set("content-range", `bytes ${start}-${start + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(body, { headers });
}

// parseRange handles the single "bytes=start-[end]" form the viewer sends for the
// keyframe skim. Anything else (multi-range, suffix ranges) → no range (full body).
function parseRange(header: string | null): R2Range | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const start = parseInt(m[1], 10);
  if (m[2] === "") return { offset: start };
  const end = parseInt(m[2], 10);
  if (end < start) return undefined;
  return { offset: start, length: end - start + 1 };
}

// objectHTTPMeta derives an object's Content-Type and Cache-Control from its
// key. It is applied in TWO places, which is why it is one function: stored on
// the object at upload time (the PUT route above), and set on the response
// when this Worker serves the object on its own hostname.
//
// Storing it matters because the bucket is ALSO published directly at
// cdn-bar.fogofwar.dev, where R2 answers from stored metadata alone — a cache
// hit there never reaches R2 and so costs no Class B operation, but only if
// the object actually carries a Cache-Control the edge will honour.
//
// Must stay in lockstep with objectHTTPMeta in internal/packer/r2.go and
// worker/tools/r2put.ts.
export function objectHTTPMeta(key: string): { contentType: string; cacheControl: string } {
  // .resources and index.json are plain JSON (the platform applies transport
  // compression itself); .brw, .keys and chunk files are opaque binary the
  // viewer gunzips internally, so they stay application/octet-stream with no
  // content-encoding — labelling them gzip would make the browser inflate them
  // and hand the decoder already-decompressed bytes.
  const contentType =
    key.endsWith(".resources") || key.endsWith(".json")
      ? "application/json"
      : "application/octet-stream";
  // Per-replay pieces are published under a content-addressed revision and
  // never rewritten, so they are safely immutable; a listing revalidates.
  const cacheControl =
    key === "index.json" || key.endsWith("/index.json")
      ? "no-cache"
      : "public, max-age=31536000, immutable";
  return { contentType, cacheControl };
}
