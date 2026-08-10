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

import { archiveSuffix, scanStreamPreamble } from "./preamble";
import { sanitizeEntry } from "./replayentry";

/** Upload size cap: keeps a whole raw stream comfortably inside Worker memory
 * and under every plan's request-body limit. Real streams are single-digit MB
 * (~6.5x smaller than the text format), so this is generous. */
const MAX_UPLOAD = 64 << 20;

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));

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
const indexStub = (env: Env) => env.REPLAY_INDEX.get(env.REPLAY_INDEX.idFromName("index"));

app.get("/api/replays", async (c) => {
  const list = await indexStub(c.env).list();
  return c.json(list, 200, { "cache-control": "no-cache" });
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
  await indexStub(c.env).upsert(entry);
  return c.json({ ok: true });
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

  const streamKey = `streams/${p.gameId}/${Date.now()}-${archiveSuffix(p)}.brepstream`;
  await c.env.BUCKET.put(streamKey, body);

  const job = crypto.randomUUID();
  await indexStub(c.env).jobInsert(job, streamKey, p.gameId);
  return c.json({ job, gameId: p.gameId, streamKey });
});

// Job status for the uploading browser: pending -> processing -> done|error.
app.get("/api/jobs/:id", async (c) => {
  const job = await indexStub(c.env).jobGet(c.req.param("id"));
  if (!job) return c.json({ error: "unknown job" }, 404);
  return c.json(job, 200, { "cache-control": "no-cache" });
});

// The ingest daemon's work queue: pending jobs (plus stalled "processing"
// ones), oldest first. Guarded like every other write-side API.
app.get("/api/jobs", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json(await indexStub(c.env).jobsPending(), 200, { "cache-control": "no-cache" });
});

// Daemon state transitions: claim (processing) and completion (done/error).
app.post("/api/jobs/:id", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const b = body as { state?: unknown; error?: unknown };
  if (b.state !== "processing" && b.state !== "done" && b.state !== "error") {
    return c.json({ error: "state must be processing, done or error" }, 400);
  }
  const detail = typeof b.error === "string" ? b.error.slice(0, 2000) : null;
  const ok = await indexStub(c.env).jobUpdate(c.req.param("id"), b.state, detail);
  if (!ok) return c.json({ error: "unknown job" }, 404);
  return c.json({ ok: true });
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
  await c.env.BUCKET.put(key, body);
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
