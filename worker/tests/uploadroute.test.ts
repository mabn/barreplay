// Drives the real Hono routes (src/worker/app.ts) through app.request() with
// an in-memory Env: the drag&drop upload endpoint (archive + job insert, and
// that rejects write nothing), the job-status API the browser polls, and the
// bearer-guarded daemon queue. The Durable Object's SQL lives out of reach of
// node, so a faithful in-memory stand-in implements its RPC surface.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import app from "../src/worker/app";
import type { ReplayEntry } from "../src/worker/replayentry";
import type { IngestJob } from "../src/worker/replayindex";

const FIXTURE = new URL("../../internal/capture/testdata/harness.brepstream", import.meta.url);
const GAME_ID = "feed5eed00000000000000000000beef";

// In-memory stand-in for the ReplayIndex Durable Object's RPC surface.
class FakeIndex {
  entries = new Map<string, ReplayEntry>();
  jobs = new Map<string, IngestJob>();

  upsert(e: ReplayEntry): void {
    this.entries.set(e.id, e);
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
  jobInsert(id: string, streamKey: string, gameId: string): void {
    this.jobs.set(id, { id, streamKey, gameId, state: "pending", error: null, createdUnix: 0, updatedUnix: 0 });
  }
  jobGet(id: string): IngestJob | null {
    return this.jobs.get(id) ?? null;
  }
  jobsPending(): IngestJob[] {
    return [...this.jobs.values()].filter((j) => j.state === "pending");
  }
  jobUpdate(id: string, state: "processing" | "done" | "error", error: string | null): boolean {
    const j = this.jobs.get(id);
    if (!j) return false;
    j.state = state;
    j.error = error;
    return true;
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

function makeEnv(token?: string): { env: Env; index: FakeIndex; bucket: FakeBucket } {
  const index = new FakeIndex();
  const bucket = new FakeBucket();
  const env = {
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
    { method: "POST", body: "x", headers: { "content-length": String(65 << 20) } },
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
    headers: { ...auth, "content-length": String(65 << 20) },
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

// The widget-install guide. /setup has no extension, so without an explicit
// route the asset layer's single-page-application handling answers it with the
// viewer's index.html — a 200 that looks fine and shows the wrong page.
test("/setup serves the guide page, not the SPA entry", async () => {
  const { env } = makeEnv();
  const asked: string[] = [];
  (env as unknown as { ASSETS: { fetch(r: Request): Promise<Response> } }).ASSETS = {
    async fetch(r: Request) {
      asked.push(new URL(r.url).pathname);
      return new Response("<!DOCTYPE html>", { headers: { "content-type": "text/html" } });
    },
  };

  const res = await app.request("/setup", {}, env);
  assert.equal(res.status, 200);
  assert.deepEqual(asked, ["/setup.html"], "the route rewrites to the real asset");
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
