// The read-only production wire (src/worker/readonly.ts): the local stand-ins
// for env.REPLAY_INDEX / env.BUCKET driven against the proxy's handler, which
// in turn drives a fake production object and bucket — so what is tested is
// that reads arrive intact and that NO write reaches production, whichever
// half is asked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { READ_METHODS, ReadOnlyError, handleReadOnly, readOnlyBucket, readOnlyIndex } from "../src/worker/readonly.ts";

interface Store {
  key: string;
  bytes: Uint8Array;
}

function setup() {
  const calls: string[] = [];
  const objects: Store[] = [
    { key: "replays/2026-10/abc.brp", bytes: new TextEncoder().encode("0123456789") },
    { key: "replays/2026-10/abc.insights9.json", bytes: new TextEncoder().encode('{"v":9}') },
  ];
  const meta = (o: Store) => ({
    key: o.key,
    version: "v1",
    size: o.bytes.length,
    etag: "e",
    httpEtag: '"e"',
    uploaded: new Date("2026-10-12T00:00:00Z"),
    httpMetadata: { contentType: "application/octet-stream", cacheControl: "public, max-age=1" },
    customMetadata: {},
  });
  const index: Record<string, unknown> = {
    list: (filter: unknown, limit: number) => {
      calls.push("list");
      return [{ id: "abc", filter, limit }];
    },
    mapNames: () => {
      calls.push("mapNames");
      return ["Supreme Isthmus"];
    },
    gameStartUnix: () => {
      calls.push("gameStartUnix");
      return undefined; // a method answering nothing must still answer
    },
    upsert: () => calls.push("upsert"),
    jobsOffer: () => calls.push("jobsOffer"),
  };
  const bucket = {
    async get(key: string, opts?: { range?: { offset: number; length?: number } }) {
      calls.push(`get ${key}`);
      const o = objects.find((x) => x.key === key);
      if (!o) return null;
      const r = opts?.range;
      const bytes = r ? o.bytes.slice(r.offset, r.length === undefined ? undefined : r.offset + r.length) : o.bytes;
      return { ...meta(o), range: r, body: new Response(bytes as unknown as BodyInit).body };
    },
    async head(key: string) {
      calls.push(`head ${key}`);
      const o = objects.find((x) => x.key === key);
      return o ? meta(o) : null;
    },
    async list(opts: { prefix?: string }) {
      calls.push(`list ${opts.prefix}`);
      return { objects: objects.filter((o) => o.key.startsWith(opts.prefix ?? "")).map(meta), truncated: false, delimitedPrefixes: [] };
    },
  };
  const target = { index, bucket: bucket as unknown as R2Bucket };
  const proxy = (req: Request) => handleReadOnly(req, target);
  return { calls, proxy, target };
}

const stubOf = (ns: DurableObjectNamespace) => ns.get(ns.idFromName("index")) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;

test("allowlisted index reads reach production with their arguments", async () => {
  const { calls, proxy } = setup();
  const stub = stubOf(readOnlyIndex(proxy));
  assert.deepEqual(await stub.list({ map: "x" }, 50), [{ id: "abc", filter: { map: "x" }, limit: 50 }]);
  assert.deepEqual(await stub.mapNames(), ["Supreme Isthmus"]);
  assert.equal(await stub.gameStartUnix("abc"), null);
  assert.deepEqual(calls, ["list", "mapNames", "gameStartUnix"]);
});

test("index writes are refused locally and never reach production", async () => {
  const { calls, proxy } = setup();
  const stub = stubOf(readOnlyIndex(proxy));
  await assert.rejects(stub.upsert({ id: "abc" }), ReadOnlyError);
  await assert.rejects(stub.jobsOffer("resim", "id"), ReadOnlyError);
  assert.deepEqual(calls, []);
});

test("the proxy refuses writes itself, whatever the local side does", async () => {
  const { calls, target } = setup();
  const call = (path: string, body: unknown, method = "POST") =>
    handleReadOnly(new Request("https://p" + path, { method, body: method === "POST" ? JSON.stringify(body) : undefined }), target);
  for (const m of ["upsert", "jobsOffer", "constructor", "__proto__", "toString", "teiserverCookies"]) {
    assert.equal((await call(`/index/${m}`, [])).status, 403, m);
  }
  assert.equal((await call("/r2/put", { key: "x" })).status, 403);
  assert.equal((await call("/r2/delete", { key: "x" })).status, 403);
  assert.equal((await call("/index/list", undefined, "GET")).status, 403);
  assert.equal((await call("/index/list", undefined, "PUT")).status, 403);
  assert.deepEqual(calls, []);
});

test("R2 reads come back as objects app.ts can serve", async () => {
  const { proxy } = setup();
  const bucket = readOnlyBucket(proxy);
  const whole = await bucket.get("replays/2026-10/abc.brp");
  assert.ok(whole);
  assert.equal(await whole.text(), "0123456789");
  assert.equal(whole.size, 10);
  assert.equal(whole.httpEtag, '"e"');
  assert.ok(whole.uploaded instanceof Date);
  const h = new Headers();
  whole.writeHttpMetadata(h);
  assert.equal(h.get("content-type"), "application/octet-stream");

  const part = await bucket.get("replays/2026-10/abc.brp", { range: { offset: 2, length: 3 } });
  assert.ok(part);
  assert.deepEqual(part.range, { offset: 2, length: 3 });
  assert.equal(await new Response(part.body).text(), "234");

  assert.equal(await bucket.get("replays/nope.brp"), null);
  assert.equal((await bucket.head("replays/2026-10/abc.brp"))?.size, 10);
  assert.equal(await bucket.head("replays/nope.brp"), null);
  const page = await bucket.list({ prefix: "replays/" });
  assert.deepEqual(page.objects.map((o) => o.key), ["replays/2026-10/abc.brp", "replays/2026-10/abc.insights9.json"]);
  assert.equal(page.truncated, false);
});

test("R2 writes are refused without reaching production", async () => {
  const { calls, proxy } = setup();
  const bucket = readOnlyBucket(proxy);
  await assert.rejects(bucket.put("streams/x", "data"), ReadOnlyError);
  await assert.rejects(bucket.delete("replays/2026-10/abc.brp"), ReadOnlyError);
  assert.deepEqual(calls, []);
});

test("every allowlisted name is a ReplayIndex method", () => {
  // The allowlist is names, checked against the class's source: a rename on
  // the DO must not leave a dead (or worse, a different) entry here.
  const src = readFileSync(new URL("../src/worker/replayindex.ts", import.meta.url), "utf8");
  for (const m of READ_METHODS) {
    assert.match(src, new RegExp(`\\n  ${m}\\(`), m);
  }
});
