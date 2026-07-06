// Worker entry point: a Hono app that serves raw .brp captures out of R2 with
// Range support, and falls back to the static-asset SPA for everything else.
//
// There is no playback logic here and no per-replay packing. Each replay is a
// single .brp object in the bucket (key "<id>.brp"). The browser reads it
// directly: it Range-reads the small meta block at the front to build the head,
// then Range-reads each frame chunk on demand. The Worker only needs to:
//
//   GET /index.json              -> list the bucket's *.brp (the replay picker)
//   GET /replays/<id>.brp        -> stream bucket key "<id>.brp" with Range
//
// The SPA, unit icons (/icons/*), rank icons (/ranks/*) and the icon table
// (/icontypes.json) are fixed static assets served by the ASSETS binding.

import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));

// The replay listing is built live from the bucket, so uploading a single .brp
// makes it appear with nothing else to maintain.
app.get("/index.json", (c) => handleIndex(c.env.BUCKET));

// /replays/<id>.brp maps to bucket key "<id>.brp". Range is required — the
// browser reads meta + chunks as byte ranges of this one object.
app.on(["GET", "HEAD"], "/replays/*", (c) => {
  const key = c.req.path.slice("/replays/".length);
  return serveR2(c.env.BUCKET, key, c.req.raw);
});

// Non-R2, non-API requests reach the Worker only when no static asset matched.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

// handleIndex lists the bucket's top-level *.brp objects, one entry per replay
// ({file, gameId, size}); id is the filename without the .brp extension.
async function handleIndex(bucket: R2Bucket): Promise<Response> {
  const list: { file: string; gameId: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    for (const o of page.objects) {
      if (o.key.includes("/") || !o.key.endsWith(".brp")) continue;
      const id = o.key.slice(0, -".brp".length);
      list.push({ file: id, gameId: id, size: o.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  list.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return Response.json(list, { headers: { "cache-control": "no-cache" } });
}

// serveR2 streams an object out of the bucket, honoring a byte Range request
// (the browser's meta + chunk reads). A .brp never changes once uploaded, so it
// is cached immutably.
async function serveR2(bucket: R2Bucket, key: string, req: Request): Promise<Response> {
  const parsed = parseRange(req.headers.get("range"));
  const obj = await bucket.get(key, parsed ? { range: parsed } : undefined);
  if (!obj) return new Response("not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("content-type", "application/octet-stream");

  const body = "body" in obj ? obj.body : null;
  if (req.method === "HEAD") {
    headers.set("content-length", String(obj.size));
    return new Response(null, { headers });
  }
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

// parseRange handles the single "bytes=start-[end]" form the browser sends.
// Anything else (multi-range, suffix range) -> full body.
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
