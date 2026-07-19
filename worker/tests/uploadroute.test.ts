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

  async put(key: string, value: Uint8Array): Promise<void> {
    this.objects.set(key, value);
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
  assert.match(body.streamKey, new RegExp(`^streams/${GAME_ID}/\\d+-a0\\.brepstream$`));

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
