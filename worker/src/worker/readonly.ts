// READ-ONLY PRODUCTION ACCESS for local development (`npm run dev:prod`).
//
// A local worker cannot bind production's Durable Object directly — a DO
// binding only ever reaches objects of a DEPLOYED script, and remote bindings
// do not cover DOs. Cloudflare's answer is a proxy: a small Worker deployed in
// the same account (src/prodproxy/index.ts, wrangler.prodproxy.jsonc) that
// binds the production DO (by script_name) and bucket, and that the local
// worker reaches through a REMOTE SERVICE BINDING. This file is both halves of
// the wire between them:
//
//   - handleReadOnly runs IN THE PROXY. It answers only reads: a ReplayIndex
//     method on READ_METHODS, or an R2 get/head/list. Everything else is a
//     403, so read-only is enforced on the production side and cannot be
//     undone by an edit to local code.
//   - readOnlyIndex / readOnlyBucket run LOCALLY. They stand in for
//     env.REPLAY_INDEX and env.BUCKET so the unchanged Hono app (app.ts) reads
//     production through the proxy. Their write methods throw ReadOnlyError
//     without calling out, which is only a courtesy: the proxy would refuse
//     them anyway.
//
// The wire is plain HTTP over the binding's fetch (JSON for calls, the raw
// object body for R2 reads) rather than Workers RPC, because what crosses it
// is exactly what the DO stub already returns to app.ts — JSON-shaped rows —
// and an R2 object, which is a body plus a handful of metadata fields.
//
// Kept free of workerd imports (like app.ts) so tests/readonly.test.ts drives
// both halves against each other in plain node.

/** The ReplayIndex methods the proxy will call: the ones that only READ.
 * Checked by name against replayindex.ts in tests/readonly.test.ts.
 *
 * Deliberately absent although they do not write: teiserverCookies (the
 * teiserver login session — a credential, not data), and lobbiesOpen /
 * gamesLavaPending (only the cron asks, and the cron does not run here).
 * Absent because they WRITE although they look like reads: jobsOffer (a
 * "resim" poll queues a game) and jobClaim, besides every upsert, insert and
 * job transition. A method added to ReplayIndex is refused until it is listed
 * here, which is the safe default. */
export const READ_METHODS: ReadonlySet<string> = new Set([
  "list",
  "mapNames",
  "gameStartUnix",
  "gamesPage",
  "gamesByIds",
  "gamesUnknown",
  "jobGet",
  "jobSamples",
  "queuePage",
  "sqlStatsReport",
]);

/** What a write against production raises locally. proddev.ts turns it into
 * a 403, so a refused write reads as "read-only", not as a server error. */
export class ReadOnlyError extends Error {
  constructor(what: string) {
    super(`read-only production mode: ${what} refused`);
    this.name = "ReadOnlyError";
  }
}

// ---- the proxy half ----------------------------------------------------------

/** The two things the proxy reads: the production ReplayIndex stub (only ever
 * indexed by an allowlisted name) and the production bucket. */
export interface ReadOnlyTarget {
  index: Record<string, unknown>;
  bucket: Pick<R2Bucket, "get" | "head" | "list">;
}

/** An R2 object's metadata as it crosses the wire (the body travels as the
 * response body). `uploaded` is an ISO string; everything else is JSON as is. */
interface WireObject {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: string;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  range?: R2Range;
  storageClass?: string;
}

const OBJECT_HEADER = "x-r2-object";

const wireObject = (o: R2Object): WireObject => ({
  key: o.key,
  version: o.version,
  size: o.size,
  etag: o.etag,
  httpEtag: o.httpEtag,
  uploaded: o.uploaded instanceof Date ? o.uploaded.toISOString() : String(o.uploaded),
  httpMetadata: o.httpMetadata,
  customMetadata: o.customMetadata,
  range: o.range,
  storageClass: o.storageClass,
});

const refuse = (what: string) => Response.json({ error: `read-only: ${what}` }, { status: 403 });

/** handleReadOnly answers one request from the local worker. POST only, every
 * route a read:
 *   POST /index/<method>  body: the argument array -> {result}
 *   POST /r2/get          body: {key, range?}      -> the object's body, metadata in x-r2-object; 404 when absent
 *   POST /r2/head         body: {key}              -> {object} (null when absent)
 *   POST /r2/list         body: {prefix?, cursor?, limit?, delimiter?} -> the listing
 * Anything else is a 403 (a method off the list) or a 404 (no such route). */
export async function handleReadOnly(req: Request, target: ReadOnlyTarget): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method !== "POST") return refuse(`${req.method} ${path}`);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  if (path.startsWith("/index/")) {
    const method = path.slice("/index/".length);
    if (!READ_METHODS.has(method)) return refuse(`ReplayIndex.${method}`);
    if (!Array.isArray(body)) return Response.json({ error: "body must be the argument array" }, { status: 400 });
    const fn = target.index[method];
    if (typeof fn !== "function") return Response.json({ error: `no method ${method}` }, { status: 404 });
    const result = await (fn as (...a: unknown[]) => unknown).apply(target.index, body);
    return Response.json({ result: result ?? null });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  switch (path) {
    case "/r2/get": {
      if (typeof b.key !== "string") return Response.json({ error: "key required" }, { status: 400 });
      const range = rangeOf(b.range);
      const obj = await target.bucket.get(b.key, range ? { range } : undefined);
      if (obj === null) return new Response(null, { status: 404 });
      return new Response(obj.body, { headers: { [OBJECT_HEADER]: JSON.stringify(wireObject(obj)) } });
    }
    case "/r2/head": {
      if (typeof b.key !== "string") return Response.json({ error: "key required" }, { status: 400 });
      const obj = await target.bucket.head(b.key);
      return Response.json({ object: obj === null ? null : wireObject(obj) });
    }
    case "/r2/list": {
      const opts: R2ListOptions = {};
      if (typeof b.prefix === "string") opts.prefix = b.prefix;
      if (typeof b.cursor === "string") opts.cursor = b.cursor;
      if (typeof b.delimiter === "string") opts.delimiter = b.delimiter;
      if (typeof b.limit === "number") opts.limit = b.limit;
      const page = await target.bucket.list(opts);
      return Response.json({
        objects: page.objects.map(wireObject),
        truncated: page.truncated,
        cursor: page.truncated ? page.cursor : undefined,
        delimitedPrefixes: page.delimitedPrefixes,
      });
    }
  }
  return refuse(path);
}

/** rangeOf keeps only the R2Range shapes app.ts asks for ({offset, length?}
 * or {suffix}); anything else is no range, i.e. the whole object. */
function rangeOf(v: unknown): R2Range | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.suffix === "number") return { suffix: r.suffix };
  if (typeof r.offset === "number") {
    return typeof r.length === "number" ? { offset: r.offset, length: r.length } : { offset: r.offset };
  }
  return undefined;
}

// ---- the local half ----------------------------------------------------------

/** How the local half reaches the proxy: the remote service binding's fetch. */
export type ProxyFetch = (req: Request) => Promise<Response>;

const PROXY_ORIGIN = "https://prod-readonly";

async function post(proxy: ProxyFetch, path: string, body: unknown): Promise<Response> {
  return proxy(
    new Request(PROXY_ORIGIN + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function failure(res: Response, what: string): Promise<Error> {
  const text = await res.text().catch(() => "");
  if (res.status === 403) return new ReadOnlyError(what);
  return new Error(`production proxy: ${what} -> ${res.status} ${text.slice(0, 300)}`);
}

/** readOnlyIndex stands in for env.REPLAY_INDEX. app.ts only ever does
 * `get(idFromName("index"))` and calls methods on the stub, so that is all
 * this implements: an allowlisted method is forwarded to the proxy, anything
 * else throws ReadOnlyError on the spot. */
export function readOnlyIndex(proxy: ProxyFetch): DurableObjectNamespace {
  const stub = new Proxy(
    {},
    {
      get(_t, prop) {
        // Not thenable: `await stub` must not mistake it for a promise.
        if (typeof prop !== "string" || prop === "then") return undefined;
        return async (...args: unknown[]) => {
          if (!READ_METHODS.has(prop)) throw new ReadOnlyError(`ReplayIndex.${prop}`);
          const res = await post(proxy, `/index/${prop}`, args);
          if (!res.ok) throw await failure(res, `ReplayIndex.${prop}`);
          return ((await res.json()) as { result: unknown }).result;
        };
      },
    },
  );
  const ns = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: () => stub,
  };
  return ns as unknown as DurableObjectNamespace;
}

/** readObject rebuilds enough of an R2Object / R2ObjectBody for app.ts:
 * the metadata fields, writeHttpMetadata, and — for a get — the body and its
 * readers. */
function readObject(w: WireObject, body?: ReadableStream | null): R2ObjectBody {
  const o: Record<string, unknown> = {
    ...w,
    uploaded: new Date(w.uploaded),
    checksums: { toJSON: () => ({}) },
    writeHttpMetadata(h: Headers) {
      const m = w.httpMetadata ?? {};
      if (m.contentType) h.set("content-type", m.contentType);
      if (m.contentLanguage) h.set("content-language", m.contentLanguage);
      if (m.contentDisposition) h.set("content-disposition", m.contentDisposition);
      if (m.contentEncoding) h.set("content-encoding", m.contentEncoding);
      if (m.cacheControl) h.set("cache-control", m.cacheControl);
      if (m.cacheExpiry) h.set("expires", new Date(m.cacheExpiry).toUTCString());
    },
  };
  if (body !== undefined) {
    const res = new Response(body);
    Object.assign(o, {
      body: res.body,
      get bodyUsed() {
        return res.bodyUsed;
      },
      arrayBuffer: () => res.arrayBuffer(),
      text: () => res.text(),
      json: () => res.json(),
      blob: () => res.blob(),
      bytes: async () => new Uint8Array(await res.arrayBuffer()),
    });
  }
  return o as unknown as R2ObjectBody;
}

/** readOnlyBucket stands in for env.BUCKET: get/head/list go to the proxy,
 * every write throws ReadOnlyError without leaving the machine. */
export function readOnlyBucket(proxy: ProxyFetch): R2Bucket {
  const write = (what: string) => async () => {
    throw new ReadOnlyError(`R2 ${what}`);
  };
  const bucket = {
    async get(key: string, options?: R2GetOptions) {
      const range = options?.range instanceof Headers ? undefined : options?.range;
      const res = await post(proxy, "/r2/get", { key, range });
      if (res.status === 404) return null;
      if (!res.ok) throw await failure(res, `R2 get ${key}`);
      const meta = res.headers.get(OBJECT_HEADER);
      if (meta === null) throw new Error(`production proxy: R2 get ${key} carried no object metadata`);
      return readObject(JSON.parse(meta) as WireObject, res.body);
    },
    async head(key: string) {
      const res = await post(proxy, "/r2/head", { key });
      if (!res.ok) throw await failure(res, `R2 head ${key}`);
      const { object } = (await res.json()) as { object: WireObject | null };
      return object === null ? null : readObject(object);
    },
    async list(options?: R2ListOptions) {
      const res = await post(proxy, "/r2/list", {
        prefix: options?.prefix,
        cursor: options?.cursor,
        limit: options?.limit,
        delimiter: options?.delimiter,
      });
      if (!res.ok) throw await failure(res, "R2 list");
      const page = (await res.json()) as {
        objects: WireObject[];
        truncated: boolean;
        cursor?: string;
        delimitedPrefixes: string[];
      };
      return { ...page, objects: page.objects.map((w) => readObject(w)) };
    },
    put: write("put"),
    delete: write("delete"),
    createMultipartUpload: write("multipart upload"),
    resumeMultipartUpload: () => {
      throw new ReadOnlyError("R2 multipart upload");
    },
  };
  return bucket as unknown as R2Bucket;
}
