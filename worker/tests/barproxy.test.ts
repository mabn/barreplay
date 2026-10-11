// The BAR API proxy (app.ts barProxy): map records, terrain images and replay
// details from api.bar-rts.com, re-served with cache headers the upstream
// does not send. Upstream is a stubbed globalThis.fetch.
import assert from "node:assert/strict";
import test from "node:test";

import app from "../src/worker/app";

type Seen = { url: string; init?: RequestInit & { cf?: unknown } };

function stub(answer: (url: string) => Response): { seen: Seen[]; restore: () => void } {
  const real = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, init });
    return answer(url);
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

const env = {} as Env;

test("a map record is proxied with a long browser + edge cache and open CORS", async () => {
  const s = stub(() => new Response('{"fileName":"supreme_isthmus_v2.1","width":20,"height":20}', {
    headers: { "content-type": "application/json", vary: "Origin" },
  }));
  try {
    const r = await app.request("/api/bar/maps/supreme_isthmus_v2.1", {}, env);
    assert.equal(r.status, 200);
    assert.equal(s.seen[0].url, "https://api.bar-rts.com/maps/supreme_isthmus_v2.1");
    assert.deepEqual((s.seen[0].init?.cf as { cacheEverything: boolean }).cacheEverything, true);
    assert.match(r.headers.get("cache-control") ?? "", /^public, max-age=31536000, immutable$/);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("content-type"), "application/json");
    assert.equal(r.headers.get("vary"), null);
    assert.equal((await r.json()).width, 20);
  } finally { s.restore(); }
});

test("terrain images are proxied; a map name with spaces is re-escaped", async () => {
  const s = stub(() => new Response(new Uint8Array([0xff, 0xd8]), {
    headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=0", etag: 'W/"2bff"' },
  }));
  try {
    const r = await app.request("/api/bar/maps/Eye%20Of%20Horus_1.6/texture-mq.jpg", {}, env);
    assert.equal(r.status, 200);
    assert.equal(s.seen[0].url, "https://api.bar-rts.com/maps/Eye%20Of%20Horus_1.6/texture-mq.jpg");
    assert.equal(r.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(r.headers.get("etag"), 'W/"2bff"');
    const nm = await app.request("/api/bar/maps/x/texture-mq.jpg", { headers: { "if-none-match": 'W/"2bff"' } }, env);
    assert.equal(nm.status, 304);
    assert.equal(await nm.text(), "");
    const t = await app.request("/api/bar/maps/x/texture-thumb.jpg", {}, env);
    assert.equal(t.status, 200);
  } finally { s.restore(); }
});

test("a 404 stays a 404 (resolveMapFile's fallback) with only a short cache", async () => {
  const s = stub(() => new Response("not found", { status: 404 }));
  try {
    const r = await app.request("/api/bar/maps/frozen_ford_v2", {}, env);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("cache-control"), "public, max-age=300");
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  } finally { s.restore(); }
});

test("upstream errors are not cached", async () => {
  const s = stub(() => new Response("boom", { status: 502 }));
  try {
    const r = await app.request("/api/bar/replays/389aca6a1dd948c1a8da5d36eaf7bed3", {}, env);
    assert.equal(r.status, 502);
    assert.equal(s.seen[0].url, "https://api.bar-rts.com/replays/389aca6a1dd948c1a8da5d36eaf7bed3");
    assert.equal(r.headers.get("cache-control"), "no-store");
  } finally { s.restore(); }
});

test("only map pieces are proxied: other assets, slashes and bad ids never reach upstream", async () => {
  const s = stub(() => new Response("x"));
  try {
    assert.equal((await app.request("/api/bar/maps/x/metadata.json", {}, env)).status, 404);
    assert.equal((await app.request("/api/bar/maps/a%2F..%2Freplays", {}, env)).status, 400);
    assert.equal((await app.request("/api/bar/replays/not%20an%20id", {}, env)).status, 400);
    assert.equal(s.seen.length, 0);
  } finally { s.restore(); }
});
