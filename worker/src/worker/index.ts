// Worker entry point: a Hono app that serves the replay data out of R2 and falls
// back to the static-asset SPA for everything else.
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

import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));

// The replay listing is built live from the bucket (list the replays/ prefix), so
// uploading a single replay's files makes it appear with no index.json to maintain.
app.get("/index.json", (c) => handleIndex(c.env.BUCKET));
app.on(["GET", "HEAD"], "/replays/*", (c) => {
  const key = c.req.path.slice(1); // strip leading "/"
  return serveR2(c.env.BUCKET, key, c.req.raw, true);
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
// .brw, .keys and chunk files are opaque binary the viewer gunzips internally,
// so they stay application/octet-stream with no content-encoding.
function setContentType(headers: Headers, key: string): void {
  if (key.endsWith(".resources") || key.endsWith(".json")) {
    headers.set("content-type", "application/json");
  } else {
    // .brw head, .keys, or replays/<id>/c<n> — a raw gzip stream the viewer
    // gunzips itself. Must not be served with Content-Encoding.
    headers.set("content-type", "application/octet-stream");
  }
}
