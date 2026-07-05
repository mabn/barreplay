// Worker entry point: a Hono app that serves the replay data out of R2 and falls
// back to the static-asset SPA for everything else.
//
// There is no dynamic playback logic here. The viewer fetches plain files that
// `barreplay-static` (Go) precomputed and we synced into the R2 bucket:
//
//   /index.json                 the replay picker listing
//   /replays/<id>.brw           one capture's head (meta, teams, icons, chunk index)
//   /replays/<id>.resources     gzipped per-frame team economy
//   /replays/<id>/c<n>          one frame chunk; a Range bytes=0-(keyLen-1) is the skim
//
// These are served straight from R2 with Range support (the keyframe-skim path
// needs it). The SPA, unit icons (/icons/*) and rank icons (/ranks/*) are fixed
// static assets served by the ASSETS binding before the Worker even runs.

import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));

// R2-backed paths. Everything else falls through to static assets.
app.get("/index.json", (c) => serveR2(c.env.BUCKET, "index.json", c.req.raw, false));
app.on(["GET", "HEAD"], "/replays/*", (c) => {
  const key = c.req.path.slice(1); // strip leading "/"
  return serveR2(c.env.BUCKET, key, c.req.raw, true);
});

// Non-R2, non-API requests reach the Worker only when no static asset matched.
// Hand them to the SPA fallback.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

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
  headers.set(
    "cache-control",
    immutable ? "public, max-age=31536000, immutable" : "no-cache",
  );
  setContentType(headers, key);

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

// setContentType fixes the few types the viewer relies on. .resources and
// index.json are plain JSON (the platform applies transport compression itself);
// .brw and chunk files are opaque binary the viewer gunzips internally, so they
// stay application/octet-stream with no content-encoding.
function setContentType(headers: Headers, key: string): void {
  if (key.endsWith(".resources") || key.endsWith(".json")) {
    headers.set("content-type", "application/json");
  } else {
    // .brw head, or replays/<id>/c<n> — a raw gzip chunk stream the viewer
    // gunzips itself. Must not be served with Content-Encoding.
    headers.set("content-type", "application/octet-stream");
  }
}
