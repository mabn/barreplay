// A Hono app that serves the replay data out of R2 and falls back to the
// static-asset SPA for everything else.
//
// There is no dynamic playback logic here. The viewer fetches plain files that
// the Go publisher (`pack`, the ingest daemon, `barreplay-static`) put in the
// R2 bucket:
//
//   /replays/<id>.brp           the capture itself — the whole published
//                               replay. The viewer Range-reads its head (meta,
//                               events, comms), then the keyframes section (the
//                               whole timeline is scrubbable before any chunk
//                               arrives), each chunk's DELTA frames, and the
//                               economy section
//
// Replays published before that were several objects: /replays/<id>.brw (a
// precomputed head), /replays/<id>.resources (the economy as JSON), and either
// the .brp or /replays/<id>.keys plus /replays/<id>/c<n> (one chunk's deltas);
// those objects stay and the viewer still reads them.
//
// These are served straight from R2, honouring Range.
// The SPA, unit icons (/icons/*) and rank icons (/ranks/*) are fixed static
// assets served by the ASSETS binding before the Worker even runs.

// The Hono app with every route. Split from index.ts (the wrangler entry
// point, which re-exports the ReplayIndex Durable Object class) so this file
// has no `cloudflare:workers` import anywhere in its module graph — the
// node-side tests (tsx --test) drive the real routes via app.request() with a
// fake Env.
import { Hono } from "hono";

import { AccessVerifier, accessCookie, accessToken, devCallbackNext, isLoopbackHost, loginNext } from "./access";
import { decodeJwt } from "jose";
import { GAME_ID_RE, encodeGamesCursor, gameFromApi, parseGamesCursor } from "./games";
import { parseGameId } from "./gameid";
import { DAEMON_KINDS, parseInstallId, parseJobErrorKind, parseJobProgress, parseJobStats } from "./jobs";
import type { JobKind } from "./jobs";
import { archiveSuffix, scanStreamPreamble } from "./preamble";
import { isBrp, scanBrpHead } from "./brphead";
import { isEmptyFilter, isReplayFolder, monthFolder, parseReplayFilter, parseViewRequest, playersFromApi, sanitizeEntry, settingsFlags } from "./replayentry";

/** Upload size cap: keeps a whole raw stream inside Worker memory. Real
 * streams are single-digit MB (~6.5x smaller than the text format), so this
 * is very generous — sized for the outliers, like a full-view capture of a
 * marathon game. Note Cloudflare's own request-body limit still applies in
 * front of the Worker and follows the ZONE's plan (100 MB on Free/Pro): on
 * such a zone the edge 413s anything past that before this cap is consulted. */
const MAX_UPLOAD = 150 << 20;

const app = new Hono<{ Bindings: Env; Variables: { admin: { email: string | null; via: string } } }>();

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

// ---- admin login (Cloudflare Access) ---------------------------------------
// The admin surface — queue, SQL stats, the re-sim paste box, the row refresh
// and POV controls, the job hold-back switch — is gated by an identity that
// Cloudflare Access issued, verified HERE on every request (src/worker/
// access.ts has the why). One verifier per isolate: it caches the team's
// signing keys.
const accessVerifier = new AccessVerifier();

/** Who is asking, when it is an admin. Three ways in, tried in order:
 * ADMIN_OPEN=true (local dev only — .dev.vars, never wrangler.jsonc); the
 * daemons' bearer token, when one is CONFIGURED and matches (an operator's
 * script drives the admin routes with the credential it already holds); and
 * a valid Access token for this application. Unconfigured Access is CLOSED:
 * a deploy that forgot the two vars locks the admin out, never opens the
 * door. Answers null for everyone else. */
async function adminIdentity(c: {
  env: Env;
  req: { header(name: string): string | undefined; raw: Request };
}): Promise<{ email: string | null; via: "open" | "token" | "access" } | null> {
  if (c.env.ADMIN_OPEN === "true") return { email: null, via: "open" };
  const token = c.env.REPLAY_PUT_TOKEN;
  if (token && c.req.header("authorization") === `Bearer ${token}`) return { email: null, via: "token" };
  const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud } = c.env;
  if (!teamDomain || !aud) return null;
  const jwt = accessToken(c.req.raw.headers);
  if (!jwt) return null;
  const id = await accessVerifier.verify(jwt, { teamDomain, aud });
  return id ? { email: id.email, via: "access" } : null;
}

/** requireAdmin answers 401 for a request with no admin identity, telling
 * the browser where the login is; on a pass it stores the identity for the
 * route. Mounted on the /api/admin/* prefix below — exactly the routes the
 * admin UI drives; the daemons' own routes keep their bearer guard. */
const requireAdmin = async (
  c: {
    env: Env;
    req: { header(name: string): string | undefined; raw: Request };
    json: (body: unknown, status: 401) => Response;
    set: (key: "admin", value: unknown) => void;
  },
  next: () => Promise<void>,
): Promise<Response | void> => {
  const who = await adminIdentity(c);
  if (!who) {
    const configured = Boolean(c.env.ACCESS_TEAM_DOMAIN && c.env.ACCESS_AUD);
    return c.json(
      {
        error: configured ? "admin sign-in required" : "admin login is not configured on this deployment",
        login: "/admin/login",
        configured,
      },
      401,
    );
  }
  c.set("admin", who);
  await next();
};
// Every admin route lives under /api/admin/, and the prefix is the gate: one
// middleware, registered before any route, so a route added here later is
// guarded by where it is rather than by remembering to say so.
app.use("/api/admin/*", (c, next) => requireAdmin(c, next));

app.get("/api/health", (c) => c.json({ status: "ok" }));

// Who am I, for the front-end: 200 with the identity when the request carries
// an admin credential, else the same 401 the admin routes answer. app.js asks
// this once at boot and shows the admin controls only on a 200 — being signed
// in IS admin mode, there is no URL flag. A 404 (a backend with no login and
// no admin routes, e.g. a plain static host) makes app.js show nothing.
app.get("/api/admin/me", (c) => {
  const who = c.get("admin");
  return c.json({ email: who.email, via: who.via }, 200, { "cache-control": "no-store" });
});

// The one path the Access application protects. Reaching this handler on the
// custom domain means Access already authenticated the visitor and set the
// CF_Authorization cookie for the hostname; all that is left is to send them
// back where they were going. Nothing here TRUSTS having been reached — on
// the workers.dev hostname no rule runs and this redirects unauthenticated
// visitors just the same, to a page whose admin calls then 401. loginNext
// keeps the destination on this site (an open redirect on the admin's login
// page would be a phishing tool).
//
// LOCAL DEVELOPMENT logs in for real through the deployed site, because
// Access can only ever set its cookie on the hostname it fronts, and a
// `vite dev` server on 127.0.0.1 is not one. Three hops:
//   1. the DEV server's /admin/login (a loopback host, no Access assertion
//      header) bounces the browser to PUBLIC_ORIGIN/admin/login with
//      next = its own http://127.0.0.1:<port>/admin/callback?next=<page>;
//   2. Access authenticates on the deployed site and this handler runs there
//      WITH the Cf-Access-Jwt-Assertion header — the token Access just
//      issued — and, because `next` is a loopback dev callback and nothing
//      else (devCallbackNext), redirects to it with the token attached;
//   3. the dev server's /admin/callback verifies that token exactly as every
//      admin route would, stores it as its own CF_Authorization cookie, and
//      sends the browser on to the page.
// Same application, same keys, same AUD — the local server is then an admin
// with the person's real identity and nothing pretended. The token travels
// only to a loopback address, which is this machine; a link that names any
// other host gets the plain on-site redirect.
/** The deployed site, where the Access application lives; a dev server
 * borrows its login. The custom domain in wrangler.jsonc. */
const PUBLIC_ORIGIN = "https://replay.fogofwar.dev";

app.get("/admin/login", (c) => {
  const url = new URL(c.req.url);
  const rawNext = url.searchParams.get("next");
  const assertion = c.req.header("cf-access-jwt-assertion");

  // Hop 1: a dev server with no Access in front of it sends the browser to
  // the deployed login, asking for the token back at its own callback.
  if (!assertion && isLoopbackHost(url.hostname)) {
    const cb = new URL(`${url.origin}/admin/callback`);
    cb.searchParams.set("next", loginNext(rawNext));
    const to = new URL(`${PUBLIC_ORIGIN}/admin/login`);
    to.searchParams.set("next", cb.href);
    return c.redirect(to.href, 302);
  }

  // Hop 2: on the deployed site, hand the token to a loopback dev callback.
  const dev = devCallbackNext(rawNext);
  if (dev && assertion) {
    dev.searchParams.set("token", assertion);
    return c.redirect(dev.href, 302);
  }

  return c.redirect(loginNext(rawNext), 302);
});

// Hop 3 (dev only in practice, but safe anywhere): take a token the deployed
// login forwarded, verify it like any admin request would, and store it as
// this origin's cookie. Nothing is trusted about the caller: a token that
// does not verify for THIS deployment's team + AUD is refused, so the route
// cannot be used to plant a foreign credential.
app.get("/admin/callback", async (c) => {
  const url = new URL(c.req.url);
  const token = url.searchParams.get("token");
  if (!token) return c.json({ error: "no token" }, 400);
  const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud } = c.env;
  if (!teamDomain || !aud) return c.json({ error: "admin login is not configured on this deployment" }, 401);
  const id = await accessVerifier.verify(token, { teamDomain, aud });
  if (!id) return c.json({ error: "the token did not verify" }, 401);
  let exp: number | undefined;
  try {
    exp = decodeJwt(token).exp;
  } catch {
    exp = undefined;
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: loginNext(url.searchParams.get("next")),
      "set-cookie": accessCookie(token, { secure: url.protocol === "https:", expUnix: exp }),
    },
  });
});

// Sign out of THIS origin: drop the cookie and go home. On the deployed site
// Access's own /cdn-cgi/access/logout also ends the Access session; this is
// the one that exists on a dev server too, so the header links here.
app.get("/admin/logout", (c) => {
  const url = new URL(c.req.url);
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": accessCookie("", { secure: url.protocol === "https:" }) },
  });
});

// What each Durable Object method has cost in SQLite rows since its instance
// started — the live counterpart of the rowcost test suite, for asking "which
// endpoint is spending the daily row budgets" of the running deployment
// instead of the code. Admin-only like the other maintenance reads (requireAdmin).
// The window is the instance's lifetime (`since`/`elapsedSec` in the reply);
// a deploy or eviction resets it.
app.get("/api/admin/sqlstats", async (c) => c.json(await indexStub(c.env).sqlStatsReport()));

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

// Query params narrow the listing (parseReplayFilter documents them). The
// filtering is SQL, not a pass over the JSON, because the list is the one
// endpoint whose cost grows with the archive.
/** Most rows one listing will hand out — the ceiling AND the default: an
 * absent, junk or oversized ?limit= all serve this many, never the whole
 * catalog. A client that wants more pages with ?offset= (a short page means
 * the last one). The page is 50; the front-end asks for 51 so the extra row
 * can say "there is more". The front-end's CATALOG_FETCH_LIMIT (app.js) is
 * its twin — the two must page alike. */
const CATALOG_LIMIT_MAX = 200;

app.get("/api/replays", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const filter = parseReplayFilter(params);
  if (typeof filter === "string") return c.json({ error: filter }, 400);
  const num = (key: string): number => {
    const n = parseInt(params.get(key) ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const limit = Math.min(num("limit") || CATALOG_LIMIT_MAX, CATALOG_LIMIT_MAX);
  const list = await indexStub(c.env).list(filter, limit, num("offset"));
  // Readable from any origin: the catalog is public, carries no credentials,
  // and other sites embed the game summary (src/summary/embed.ts), which
  // resolves a game's revision here before fetching its insights.
  return c.json(list, 200, { "cache-control": "no-cache", "access-control-allow-origin": "*" });
});

// The catalog's distinct map names, for the filter bar's combobox — the one
// filter whose choices cannot be hardcoded (the settings vocabulary is a
// constant, the ranges need no list, the player field is free text). Served
// from a maintained list behind a one-minute in-memory cache in the DO
// (ReplayIndex.mapNames), so it costs one row read a minute where the facets
// endpoint it replaces scanned the whole catalog per call. Doubles as the
// front-end's probe for "does this backend filter at all": a backend that
// 404s it (a plain static host) keeps the filter bar hidden.
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
// original upload ran demo-less. Admin-only (requireAdmin): it writes only
// values derived from the public authoritative API for the row's own game
// id, so there is nothing to forge — but a row everyone reads is still not
// anyone's to rewrite.
// Hand-mark whose point of view a replay was recorded from. Most rows carry no
// recorder provenance — their captures predate the GAME record's recorder
// fields — and nothing can derive it after the fact, so the viewer offers this
// as an explicit marking. Admin-only like refresh-settings above.
app.post("/api/admin/replays/:id/view", async (c) => {
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

app.post("/api/admin/replays/:id/refresh-settings", async (c) => {
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
// produced by the Go pipeline). It accepts a raw .brepstream or a capture
// already packed into a .brp — told apart by their first bytes, never by a
// file name — validates the stream's preamble or the .brp's meta, archives
// the raw bytes under streams/<gameId>/ — a prefix nothing lists and
// /replays/* never serves, and from which nothing is ever deleted — and
// records a pending job for the ingest daemon (cmd/bringest), which
// polls, transcodes, publishes the pieces under a fresh revision id, and
// reports back. The browser polls GET /api/jobs/<id> to follow along.
app.post("/api/upload", async (c) => {
  const declared = parseInt(c.req.header("content-length") ?? "", 10);
  if (declared > MAX_UPLOAD) return c.json({ error: `upload exceeds ${MAX_UPLOAD} bytes` }, 413);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.length > MAX_UPLOAD) return c.json({ error: `upload exceeds ${MAX_UPLOAD} bytes` }, 413);

  const brp = isBrp(body);
  const p = brp ? await scanBrpHead(body) : scanStreamPreamble(body);
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
  // Filed under the game's UTC start month, like the published replays. The
  // stream itself carries no start time, so it comes from the games mirror,
  // which knows every public game a minute after it ends; a game it does not
  // know (a private lobby, or one uploaded the moment it ended) is filed
  // under the month it was uploaded in.
  const started = await indexStub(c.env).gameStartUnix(p.gameId);
  const month = monthFolder(started ?? Math.floor(Date.now() / 1000));
  const streamKey = `streams/${month}/${p.gameId}/${Date.now()}-${hash}-${archiveSuffix(p)}${brp ? ".brp" : ".brepstream"}`;
  await c.env.BUCKET.put(streamKey, body);

  // FogOfWar.exe says who it is (?install=, ?app=<version>), so the upload of
  // a .brp it re-simulated is found with the rest of that install's jobs.
  // Optional and only shape-checked, like everything else on this open route.
  const installId = parseInstallId(c.req.query("install"));
  const appVersion = (c.req.query("app") ?? "").replace(/[^\w.+-]/g, "").slice(0, 40);
  const note = installId !== null ? `Uploaded by FogOfWar ${appVersion || "?"}` : null;
  const job = crypto.randomUUID();
  // ?appJob= names the app run this .brp came from: the upload is then shown
  // inside that run's queue row instead of as a second entry for the game.
  const appJob = c.req.query("appJob");
  const parentId = appJob && /^[0-9a-f-]{36}$/.test(appJob) ? appJob : null;
  await indexStub(c.env).jobInsert(job, streamKey, p.gameId, "upload", installId, note, parentId);
  return c.json({ job, gameId: p.gameId, streamKey });
});

// brpFormatVersion reads the container version byte of a published revision:
// "BRP1"/"BRW1" then one version byte, so a 5-byte Range read. Null when the
// revision has neither file or the bytes are not one of ours.
async function brpFormatVersion(bucket: R2Bucket, rid: string): Promise<number | null> {
  for (const ext of [".brp", ".brw"]) {
    try {
      const obj = await bucket.get(`replays/${rid}${ext}`, { range: { offset: 0, length: 5 } });
      if (!obj) continue;
      const b = new Uint8Array(await obj.arrayBuffer());
      const magic = String.fromCharCode(...b.subarray(0, 4));
      if (b.length === 5 && (magic === "BRP1" || magic === "BRW1")) return b[4];
    } catch {
      // best-effort: the note just omits the version
    }
  }
  return null;
}

// Queue a game NOBODY RECORDED for headless re-simulation, from a pasted
// replay link. This is the only way into the pipeline for a game with no
// .brepstream behind it: `bringest -resim` otherwise finds work by scanning
// the catalog for one-sided uploads, which by construction cannot see a game
// that was never uploaded at all.
//
// Admin-only (requireAdmin), like /view and /refresh-settings. It was open,
// on the theory that its refusals kept it cheap to expose; then a script fed
// it every ranked game within minutes of ending, 60 an hour, and an hour of
// engine time each is exactly what the refusals cannot price. The refusals
// stay, since they are still right: the id has to parse, the BAR API has to know the game (a re-sim
// cannot degrade past a missing demo the way an upload can — the demo IS the
// simulation input), a game already simulated (a full view published) is RECORDED as a disabled
// job with a note naming the .brp format version it was simulated at, and a second
// request for a game already queued returns the job that exists rather than
// making another.
app.post("/api/admin/resim", async (c) => {
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

  // force: queue it even when the game is published — the Games list's
  // admin Queue button, where an admin asks for THIS game (a one-sided
  // upload, a capture worth redoing). It is the announce door the bearer-
  // guarded POST /api/jobs opens, behind the same admin gate as this route;
  // it still dedupes on an active job and honours a disabled one.
  const force = (body as { force?: unknown }).force === true;
  const index = indexStub(c.env);
  const res = force ? await index.jobAnnounce(crypto.randomUUID(), gameId, "resim") : await index.resimEnqueue(crypto.randomUUID(), gameId);
  if (res.status === "in-catalog") {
    // Recorded rather than refused: the job is on the queue page, disabled,
    // saying why — enabling it is how an admin asks for the re-sim anyway.
    const version = res.rid ? await brpFormatVersion(c.env.BUCKET, res.rid) : null;
    const note = version === null ? "Already simulated" : `Already simulated at .brp format version ${version}`;
    if (res.job) await index.jobSetNote(res.job.id, note);
    return c.json({ job: res.job?.id ?? null, gameId, status: res.status, note });
  }
  if (res.status === "disabled") {
    return c.json(
      { error: "this game's job has been disabled; re-enable it on the queue page", gameId, status: res.status },
      409,
    );
  }
  return c.json({ job: res.job?.id, gameId, status: res.status });
});

// The PUBLIC re-sim request: the viewer's "not simulated yet" page, shown when
// a /replays/<gameId> link names a game nobody has published, offers a button
// that lands here. OPEN, unlike /api/admin/resim, which a script once fed
// every ranked game; what keeps this one cheap is ReplayIndex.resimRequest's
// cap on how many public requests may WAIT at once (PUBLIC_RESIM_MAX_PENDING)
// — a flood fills it and is refused past it, and an admin sees each one on
// the queue page by its note, where it can be disabled. The other refusals
// are the admin route's: the id must parse, and the BAR API must know the
// game (the demo IS the simulation input). A game already queued hands back
// that job, so the page can follow it.
export const PUBLIC_RESIM_MAX_PENDING = 10;
export const PUBLIC_RESIM_NOTE = "Requested from the replay page";
app.post("/api/resim/request", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const raw = (body as { gameId?: unknown })?.gameId;
  const gameId = typeof raw === "string" && raw.length <= 2048 ? parseGameId(raw) : null;
  if (!gameId) return c.json({ error: "gameId must be a BAR game id" }, 400);
  try {
    const r = await fetch(`https://api.bar-rts.com/replays/${encodeURIComponent(gameId)}`);
    if (r.status === 404) return c.json({ error: "BAR has no record of this game", gameId, status: "unknown" }, 404);
    if (!r.ok) return c.json({ error: `BAR API: ${r.status}`, gameId }, 502);
  } catch (e) {
    return c.json({ error: `fetching the BAR API: ${e}`, gameId }, 502);
  }
  const res = await indexStub(c.env).resimRequest(crypto.randomUUID(), gameId, PUBLIC_RESIM_NOTE, PUBLIC_RESIM_MAX_PENDING);
  if (res.status === "full") {
    return c.json({ error: "too many requests are waiting already; try again later", gameId, status: res.status }, 429);
  }
  return c.json({ job: res.job?.id ?? null, gameId, status: res.status, state: res.job?.state ?? null });
});

// ON-DEMAND SUMMARIES: the viewer asks for a revision's newest game summary
// when the one it found is older than the version it reads (or there is
// none), and WAITS here while it is computed. Body {rid, version}: the
// revision the page shows and the insights version it wants. The answer is
// the summary itself (200, the insights JSON) — read from the bucket, so it
// also gets past the CDN, which remembers the page's earlier 404 for hours.
// When it cannot be had, a status the page reads as "keep what you show":
// 503 busy/unavailable (no daemon connected, none computing that version, or
// more readers waiting than the hub queues), 504 timeout, 502 failed.
//
// The work is done by a plain `bringest` holding a WebSocket to the
// SummaryHub Durable Object (GET /api/insights/connect below), which owns
// the capacity: summaryhub.ts has the rules.
//
// OPEN, like the upload route, because what it can cost is bounded: only a
// revision that IS published (its .brp, or an older replay's .brw) whose
// summary file is NOT, the hub's slots and short queue cap how much runs at
// once, readers of one replay share one computation, and a failed one is not
// retried for ten minutes. It answers any origin (the lavabalance embed asks
// too) with a text/plain body, so the cross-origin POST needs no preflight.
const INSIGHTS_RID_RE = /^(?:[0-9a-f]{32}(?:-[0-9a-f]{8})?|(?:[0-9]{4}-[0-9]{2}|undated)\/[0-9a-f]{32}(?:-[0-9a-f]{8})?)$/;
export const hubStub = (env: Env) => env.SUMMARY_HUB.get(env.SUMMARY_HUB.idFromName("hub"));
const anyOrigin = { "access-control-allow-origin": "*" };

const insightsBody = async (env: Env, key: string, how: "fresh" | "computed"): Promise<Response | null> => {
  const obj = await env.BUCKET.get(key);
  if (obj === null) return null;
  return new Response(obj.body, {
    headers: { ...anyOrigin, "content-type": "application/json", "cache-control": "no-store", "x-summary": how },
  });
};

app.options(
  "/api/insights",
  () =>
    new Response(null, {
      status: 204,
      headers: { ...anyOrigin, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" },
    }),
);

app.post("/api/insights", async (c) => {
  const fail = (body: Record<string, unknown>, status: 400 | 404 | 502 | 503 | 504) => c.json(body, status, anyOrigin);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail({ error: "body must be JSON" }, 400);
  }
  const { rid, version } = (body ?? {}) as { rid?: unknown; version?: unknown };
  if (typeof rid !== "string" || !INSIGHTS_RID_RE.test(rid)) {
    return fail({ error: "rid must be a published revision id" }, 400);
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 99) {
    return fail({ error: "version must be an insights version number" }, 400);
  }
  const key = `replays/${rid}.insights${version}.json`;
  const have = await insightsBody(c.env, key, "fresh");
  if (have) return have;
  const published =
    (await c.env.BUCKET.head(`replays/${rid}.brp`)) !== null || (await c.env.BUCKET.head(`replays/${rid}.brw`)) !== null;
  if (!published) return fail({ error: "no replay is published under that revision", rid }, 404);

  const r = await hubStub(c.env).compute(rid, version);
  switch (r.status) {
    case "done": {
      const made = await insightsBody(c.env, key, "computed");
      return made ?? fail({ status: "failed", error: "the daemon reported success but published no file" }, 502);
    }
    case "failed":
      return fail({ status: r.status, error: r.error }, 502);
    case "timeout":
      return fail({ status: r.status }, 504);
    case "unavailable":
      return fail({ status: r.status, reason: r.reason }, 503);
    default:
      return fail({ status: r.status }, 503);
  }
});

// The summary daemon's connection: a WebSocket to the SummaryHub, opened by
// `bringest` (cmd/bringest/summaries.go) with ?version=<insights version it
// computes>&slots=<summaries at once>. Bearer-guarded like every other
// daemon route; outbound from the daemon, so it still needs no inbound
// connectivity.
app.get("/api/insights/connect", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  return hubStub(c.env).fetch(c.req.raw);
});

// Job status for the browser that created it — a dropped stream or a pasted
// re-sim link: pending -> processing -> done|error. Open, so like /api/admin/queue
// it answers with a subset of the row rather than the row: the archive key is
// the one field of a job that is not public.
app.get("/api/jobs/:id", async (c) => {
  const job = await indexStub(c.env).jobGet(c.req.param("id"));
  if (!job) return c.json({ error: "unknown job" }, 404);
  const { id, gameId, kind, state, error, errorKind, stats, progress, disabled, note, installId, createdUnix, updatedUnix } =
    job;
  return c.json(
    { id, gameId, kind, state, error, errorKind, stats, progress, disabled, note, installId, createdUnix, updatedUnix },
    200,
    {
      "cache-control": "no-cache",
    },
  );
});

// One job's healthcheck HISTORY: the series behind the queue page's charts,
// fetched only when a row is expanded rather than riding every queue read (a
// page of 25 rows would otherwise carry thousands of points nobody asked for).
// Admin-only, like the queue it belongs to.
//
// An unknown job is an empty series, not a 404 — a job that never healthchecked
// (an upload, or anything from a daemon older than the beat) is indistinguishable
// from one that does not exist, and the view says the same thing about both.
app.get("/api/admin/jobs/:id/samples", async (c) => {
  const samples = await indexStub(c.env).jobSamples(c.req.param("id"));
  return c.json({ samples }, 200, { "cache-control": "no-cache" });
});

// The queue as the landing page's "Queue" section shows it: unfinished jobs
// first, then what recently finished. Admin-only (requireAdmin): it is the
// pipeline's state, every uploader's jobs and their failure messages. The
// archive KEY is still not in the reply: the route serving those bytes is
// bearer-guarded, and the view has no use for it.
// Paged, because the table only grows and the view shows a handful at a time:
// ?offset= and ?limit= (capped), with `total` and `active` counted over the
// whole table so the pager and the menu's in-flight count are true on any page.
const QUEUE_LIMIT_MAX = 100;
const QUEUE_LIMIT_DEFAULT = 25;

app.get("/api/admin/queue", async (c) => {
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

  const pageSize = Math.min(Math.max(limit, 1), QUEUE_LIMIT_MAX);
  // ?install= narrows the queue to one FogOfWar.exe install's jobs, newest
  // first (every job from one PC). `active` is then not counted.
  const installRaw = params.get("install");
  const install = installRaw === null ? null : parseInstallId(installRaw);
  if (installRaw !== null && install === null) return c.json({ error: "install must be an install id" }, 400);
  const page =
    install !== null
      ? { ...(await indexStub(c.env).jobsByInstall(install, pageSize, offset)), active: 0 }
      : await indexStub(c.env).queuePage(pageSize, offset);
  return c.json(
    {
      jobs: page.jobs.map(
        ({
          id,
          gameId,
          kind,
          state,
          error,
          errorKind,
          stats,
          progress,
          disabled,
          note,
          installId,
          game,
          createdUnix,
          updatedUnix,
        }) => ({
          id,
          gameId,
          kind,
          state,
          error,
          errorKind,
          stats,
          progress,
          disabled,
          note,
          installId,
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
      install,
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
/** Cap on ?id= — a fetch-by-ids is a lookup, not a listing, and 100 ids is
 * already every row a listing page can carry. The DO chunks the IN() under
 * this, so raising it means checking gamesByIds' chunk size too. */
const GAMES_IDS_MAX = 100;

app.get("/api/games", async (c) => {
  const params = new URL(c.req.url).searchParams;

  // Fetch-by-ids: ?id=<id>[,<id>...] answers exactly the named games (in the
  // asked order, ids the mirror does not hold absent) instead of a listing
  // page — so a client holding ids from elsewhere (the queue, a gex link, an
  // earlier listing) resolves them in one request instead of one each.
  // limit/after are ignored with it: a lookup has nothing to page. Malformed
  // ids are REFUSED rather than answered with an empty list — an id the
  // mirror could never store describes a broken request, not a missing game.
  const rawIds = params.get("id");
  if (rawIds !== null && rawIds !== "") {
    const ids = [...new Set(rawIds.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
    if (ids.length === 0) return c.json({ error: "id lists no ids" }, 400);
    if (ids.length > GAMES_IDS_MAX) return c.json({ error: `id lists more than ${GAMES_IDS_MAX} ids` }, 400);
    const bad = ids.find((id) => !GAME_ID_RE.test(id));
    if (bad !== undefined) return c.json({ error: "id is not a game id" }, 400);
    const games = await indexStub(c.env).gamesByIds(ids);
    return c.json({ games, next: null }, 200, { "cache-control": "no-cache" });
  }

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

  // The replay list's filters (parseReplayFilter), on END time for the dates,
  // with two differences: the id PREFIX is ?idPrefix= because ?id= above is
  // already the fetch-by-ids lookup, and there is no player-name filter (see
  // ReplayIndex.gamesPage).
  const fp = new URLSearchParams(params);
  fp.delete("id");
  fp.delete("player");
  const prefix = params.get("idPrefix");
  if (prefix !== null) fp.set("id", prefix);
  const filter = parseReplayFilter(fp);
  if (typeof filter === "string") return c.json({ error: filter.replace(/^id /, "idPrefix ") }, 400);

  const page = await indexStub(c.env).gamesPage(limit, after, filter);
  // A ReplayIndex from before the filters drops the third argument and answers
  // with the whole mirror — which happens for a while after a deploy, when the
  // new route reaches the old instance (and always under dev:prod until
  // production is deployed). Its reply has no `partial`; a filtered request
  // then fails loudly rather than listing games that do not match.
  if (typeof page.partial !== "boolean" && !isEmptyFilter(filter)) {
    return c.json({ error: "game filters are not available yet: the catalog is still running an older build" }, 503, {
      "cache-control": "no-store",
    });
  }
  return c.json(
    {
      games: page.games,
      next: page.next === null ? null : encodeGamesCursor(page.next),
      // A filtered page that stopped searching before it filled: `next`
      // resumes the search, and there may be nothing more to find.
      partial: page.partial,
    },
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
// GUARDED, unlike /api/admin/resim: this is the one door into the job table with no
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

// One-off / recovery backfill for the games mirror. The cron only ever walks
// back GAMES_COVERAGE_SEC (2h) from the newest game, so games the pre-2h-window
// build missed, or any older gap, are beyond its reach. This lets an operator
// feed them in from OUTSIDE: the body is verbatim api.bar-rts.com/replays/<id>
// details (a bare array, or {games:[...]}), exactly the shape the sync's own
// detail fetch decodes — so a local script does ALL the BAR fetching (no
// per-invocation subrequest cap to worry about; this handler makes no outbound
// call) and posts them here in batches. gamesUnknown dedups, so re-posting is
// a no-op and the caller need not know what the mirror already has. Guarded by
// the same token as the other write APIs. Not the cron's job and never called
// by it: this is a manual recovery door, kept small.
//
// ?refresh=true skips the dedup and re-reads the named games from the posted
// details — gamesInsert is an upsert that leaves the lobby columns alone, so
// this REPAIRS a row rather than replacing it. It exists for rows the cron
// recorded from a detail the BAR API was still writing (see
// games.ts DETAIL_SETTLE_SEC): an 8v8 stored as "7v6" stays that way for
// good otherwise, since nothing else ever re-reads a mirrored game. The
// posted details are the operator's to choose, so it is not a blanket
// re-sync — just the ids they name.
const MAX_BACKFILL = 500;
app.post("/api/games/backfill", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const raw = Array.isArray(body)
    ? body
    : Array.isArray((body as { games?: unknown })?.games)
      ? (body as { games: unknown[] }).games
      : null;
  if (raw === null) return c.json({ error: "body must be a JSON array of replay details (or {games:[...]})" }, 400);
  if (raw.length > MAX_BACKFILL) {
    return c.json({ error: `too many games in one batch (${raw.length} > ${MAX_BACKFILL})` }, 400);
  }
  // Map each detail to a mirror row, keeping only ones with a usable id — the
  // same shape check the sync applies before it would ever key a row on it.
  const entries = [];
  const ids = [];
  for (const detail of raw) {
    const id = (detail as { id?: unknown })?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
    ids.push(id);
    entries.push({ id, entry: gameFromApi(id, detail) });
  }
  if (ids.length === 0) return c.json({ received: raw.length, fresh: 0, inserted: 0 });
  const refresh = c.req.query("refresh") === "true";
  const fresh = new Set(refresh ? ids : await indexStub(c.env).gamesUnknown(ids));
  const toInsert = entries.filter((e) => fresh.has(e.id)).map((e) => e.entry);
  const inserted = toInsert.length === 0 ? 0 : await indexStub(c.env).gamesInsert(toInsert);
  return c.json({ received: raw.length, fresh: fresh.size, inserted });
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
  if (!DAEMON_KINDS.includes(kind as JobKind)) {
    return c.json({ error: `kind must be one of ${DAEMON_KINDS.join(", ")}` }, 400);
  }
  // ?mem= is the daemon's total RAM in bytes (bringest -resim sends it), which
  // is what lets a lava game that ran out of memory on a small host go to a
  // bigger one. Anything unparseable reads as "not said".
  const mem = Number(new URL(c.req.url).searchParams.get("mem") ?? 0);
  const jobs = await indexStub(c.env).jobsOffer(
    kind as JobKind,
    crypto.randomUUID(),
    Number.isFinite(mem) && mem > 0 ? Math.floor(mem) : 0,
  );
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
    if (!DAEMON_KINDS.includes(kind as JobKind)) {
      return c.json({ error: `kind must be one of ${DAEMON_KINDS.join(", ")}` }, 400);
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

// FogOfWar.exe's re-simulations, reported by the app itself: it creates the
// job when it starts simulating, beats every 10 s with its progress (the same
// JobProgress a daemon sends, so the queue page charts it), and ends it with
// done/error and its stats. OPEN — the app has no token (Marcin: no
// authentication for now) — which is why these routes touch only "app" jobs:
// the guarded POST /api/jobs/:id is the door to a daemon's. An "app" job is
// never offered to a daemon (DAEMON_KINDS), and the cron fails one that
// stops reporting (APP_JOB_STALE_SEC).
app.post("/api/app/jobs", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const b = body as { gameId?: unknown; installId?: unknown; stats?: unknown };
  const gameId = typeof b.gameId === "string" ? parseGameId(b.gameId) : null;
  if (!gameId) return c.json({ error: "gameId must be a BAR game id" }, 400);
  const installId = parseInstallId(b.installId);
  if (installId === null) return c.json({ error: "installId must be a UUID" }, 400);
  const job = await indexStub(c.env).appJobStart(crypto.randomUUID(), gameId, installId, parseJobStats(b.stats));
  return c.json({ job: job?.id ?? null, gameId });
});

app.post("/api/app/jobs/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const b = body as { state?: unknown; error?: unknown; stats?: unknown; progress?: unknown; errorKind?: unknown };
  if (b.state !== "processing" && b.state !== "done" && b.state !== "error") {
    return c.json({ error: "state must be processing, done or error" }, 400);
  }
  const detail = typeof b.error === "string" ? b.error.slice(0, 2000) : null;
  const res = await indexStub(c.env).appJobUpdate(
    c.req.param("id"),
    b.state,
    detail,
    parseJobStats(b.stats),
    parseJobProgress(b.progress),
    parseJobErrorKind(b.errorKind),
  );
  if (res === "unknown") return c.json({ error: "unknown job" }, 404);
  if (res === "not-app") return c.json({ error: "not an app job" }, 403);
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
// Admin-only (requireAdmin), like the other maintenance routes the admin UI
// drives (/refresh-settings and /view): the browser carries the Access
// cookie, which is what lets the button exist without a bearer token.
app.post("/api/admin/jobs/:id/disabled", async (c) => {
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

// The queue page's per-row "Retry": queue the job's work again under a fresh
// id (ReplayIndex.jobRetry). It exists because a FAILED re-sim has no other
// door from the browser: the paste box refuses a game that is in the catalog,
// and POST /api/jobs, which does not, takes a bearer token a browser has not
// got. The old row stays as the record of the attempt. Answers with the
// announce vocabulary — "queued", or "duplicate"/"disabled" with the job that
// already covers the work — so the page can say what happened. Admin-only
// like /disabled beside it: the browser's Access cookie is the credential.
app.post("/api/admin/jobs/:id/retry", async (c) => {
  const res = await indexStub(c.env).jobRetry(crypto.randomUUID(), c.req.param("id"));
  if (res === null) return c.json({ error: "unknown job" }, 404);
  return c.json({ status: res.status, job: res.job?.id ?? null });
});

// Archived raw streams for the ingest daemon (which speaks only HTTP to the
// worker — no S3 credentials needed on the read side). Guarded: the archive
// is not public, unlike the published replay pieces.
app.get("/api/streams/:gameId/:file", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const key = `streams/${c.req.param("gameId")}/${c.req.param("file")}`;
  return serveR2(c.env.BUCKET, key, c.req.raw, false);
});
// Archived since month folders: streams/<YYYY-MM>/<gameId>/<file>.
app.get("/api/streams/:month/:gameId/:file", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const month = c.req.param("month");
  if (!isReplayFolder(month)) return c.json({ error: "not found" }, 404);
  const key = `streams/${month}/${c.req.param("gameId")}/${c.req.param("file")}`;
  return serveR2(c.env.BUCKET, key, c.req.raw, false);
});

// /replays/<id> with no extension is a PAGE — the viewer's canonical URL for
// one replay (app.js routes on the path) — while every data piece under the
// same prefix has an extension (<id>.brw/.brp/.keys/.resources) or a second
// segment (<id>/c<n>, which this single-segment route never matches). The dot
// is the whole dispatch: bucket keys and page ids cannot collide on it.
// Registered before the wildcard so it wins for one-segment paths.
app.on(["GET", "HEAD"], "/replays/:id", (c) => {
  const id = c.req.param("id");
  if (!id.includes(".")) return serveEntry(c);
  return serveR2(c.env.BUCKET, c.req.path.slice(1), c.req.raw, true);
});
// /replays/<YYYY-MM>/<rid name> with no extension is a page too: the link
// to one specific upload published since month folders. A legacy chunk,
// replays/<rid>/c<n>, also has no dot, but its first segment is a game id,
// never a month, which is the whole dispatch.
app.on(["GET", "HEAD"], "/replays/:folder/:id", (c) => {
  if (isReplayFolder(c.req.param("folder")) && !c.req.param("id").includes(".")) return serveEntry(c);
  return serveR2(c.env.BUCKET, c.req.path.slice(1), c.req.raw, true);
});
app.on(["GET", "HEAD"], "/replays/*", (c) => {
  const key = c.req.path.slice(1); // strip leading "/"
  return serveR2(c.env.BUCKET, key, c.req.raw, true);
});

// Trusted piece writes: PUT the exact key the viewer will GET. This is how
// `pack -upload local` and the ingest daemon's local mode seed the dev
// simulator's bucket quickly (it is otherwise only writable via `wrangler r2
// object put` — one ~1s node startup per object, serially); it works against
// a deployed worker too when the bearer secret authorizes it. The publisher
// is responsible for the order of an older multi-object bundle (its .brw
// head last — the listing barrier); a .brp is one object.
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
  // If-None-Match: * is how a publisher claims a game's MAIN replay name
  // (internal/packer names.go): write only if nothing is there, else 412 and
  // the publisher falls back to a suffixed name. Checked up front and again
  // by R2 itself, so a race between two publishers cannot overwrite either.
  const ifAbsent = c.req.header("if-none-match")?.trim() === "*";
  if (ifAbsent && (await c.env.BUCKET.head(key)) !== null) {
    return c.json({ error: "object already exists" }, 412);
  }
  // Store the HTTP metadata rather than relying on serveR2 to add it: the
  // bucket is also read through its OWN hostname (cdn-bar.fogofwar.dev), where
  // R2 replies with exactly what is stored and no Worker gets to fix it up.
  // Derived from the key, not from the request headers, so every transport
  // (S3, wrangler, this route) leaves the bucket in the same state.
  const meta = objectHTTPMeta(key);
  const stored = await c.env.BUCKET.put(key, body, {
    httpMetadata: { contentType: meta.contentType, cacheControl: meta.cacheControl },
    ...(ifAbsent ? { onlyIf: new Headers({ "if-none-match": "*" }) } : {}),
  });
  if (ifAbsent && stored === null) return c.json({ error: "object already exists" }, 412);
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
// The landing page's sections live at paths now (/queue, /games, /sqlstats —
// app.js routes on the pathname), so a direct load or refresh of one must
// serve the SPA entry exactly like "/". The replay page path (/replays/<id>)
// is handled above, where it shares a prefix with the data pieces.
app.get("/queue", serveEntry);
app.get("/games", serveEntry);
app.get("/sqlstats", serveEntry);

// The FogOfWar.exe download page (public/setup.html), linked from the landing page's
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

// BAR API PROXY for what the map drawing reads: a map's record
// (/maps/<file>), its terrain images (/maps/<file>/texture-*.jpg) and, as the
// fallback that finds a map's file name, a replay's detail (/replays/<id>).
// api.bar-rts.com answers the JSON with no cache-control and the images with
// max-age=0, so a browser re-downloaded a several-hundred-KB terrain texture
// on every replay load. Through here the answer is cached at our edge
// (cf.cacheTtlByStatus) AND told to the browser (cache-control), a map's
// archive name naming fixed content. The browser is told `immutable` with a
// year's max-age, so it does not even revalidate on reload (Firefox does
// revalidate a plain max-age resource on reload; immutable stops that), and a
// revalidation that does arrive (a hard reload) is answered 304 off the ETag.
// The edge copy stays a week, so a re-uploaded map reaches new visitors. A
// 404 is cached briefly rather than
// long: resolveMapFile reads it as "the guess was wrong, ask the replay", and
// a map uploaded after a miss should not stay missing for a week.
// access-control-allow-origin: * because the summary embed draws maps from
// another site (lavabalance) through this same path.
const BAR_API = "https://api.bar-rts.com";
const BAR_PROXY_OK_SEC = 7 * 24 * 3600;
const BAR_PROXY_BROWSER_SEC = 365 * 24 * 3600;
const BAR_PROXY_MISS_SEC = 300;
const MAP_ASSETS = new Set(["texture-mq.jpg", "texture-lq.jpg", "texture-thumb.jpg"]);

async function barProxy(path: string, ifNoneMatch?: string, base = BAR_API): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(base + path, {
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": BAR_PROXY_OK_SEC, "404": BAR_PROXY_MISS_SEC, "500-599": 0 } },
    } as RequestInit);
  } catch {
    return new Response("upstream unreachable", { status: 502, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });
  }
  const h = new Headers();
  const ct = r.headers.get("content-type");
  if (ct) h.set("content-type", ct);
  for (const k of ["etag", "last-modified"]) {
    const v = r.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set("access-control-allow-origin", "*");
  h.set("cache-control", r.ok ? `public, max-age=${BAR_PROXY_BROWSER_SEC}, immutable`
    : r.status === 404 ? `public, max-age=${BAR_PROXY_MISS_SEC}` : "no-store");
  const etag = r.headers.get("etag");
  if (r.ok && etag && ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim() === etag)) {
    await r.body?.cancel();
    return new Response(null, { status: 304, headers: h });
  }
  return new Response(r.body, { status: r.status, headers: h });
}

// A map's file name is the archive its author uploaded: anything but a path
// separator, so it can be handed on (re-escaped) without reaching another
// upstream path.
const okMapFile = (f: string) => f.length > 0 && f.length <= 200 && !/[\/\\]/.test(f) && f !== "." && f !== "..";
app.get("/api/bar/maps/:file", (c) => {
  const file = c.req.param("file");
  if (!okMapFile(file)) return c.text("bad map file", 400);
  return barProxy(`/maps/${encodeURIComponent(file)}`, c.req.header("if-none-match"));
});
app.get("/api/bar/maps/:file/:asset", (c) => {
  const file = c.req.param("file");
  const asset = c.req.param("asset");
  if (!okMapFile(file) || !MAP_ASSETS.has(asset)) return c.text("not proxied", 404);
  return barProxy(`/maps/${encodeURIComponent(file)}/${asset}`, c.req.header("if-none-match"));
});
app.get("/api/bar/replays/:id", (c) => {
  const id = c.req.param("id");
  if (!GAME_ID_RE.test(id)) return c.text("bad game id", 400);
  return barProxy(`/replays/${id}`, c.req.header("if-none-match"));
});

// A game's DEMO (the .sdfz the BAR API names as its fileName), for the
// summary's achievements, which read the order stream, chat and end-of-game
// totals out of it in the browser. BAR keeps demos on OVH object storage,
// which sends no CORS headers, so a page cannot fetch one itself. A demo
// never changes once written, so it gets the same caching as a map. The file
// name is checked like a map's: one path segment, re-escaped.
const BAR_DEMOS = "https://storage.uk.cloud.ovh.net/v1/AUTH_10286efc0d334efd917d476d7183232e/BAR/demos";
const okDemoFile = (f: string) => okMapFile(f) && f.endsWith(".sdfz");
app.get("/api/bar/demos/:file", (c) => {
  const file = c.req.param("file");
  if (!okDemoFile(file)) return c.text("bad demo file", 400);
  return barProxy(`/${encodeURIComponent(file)}`, c.req.header("if-none-match"), BAR_DEMOS);
});

// Non-R2, non-API requests reach the Worker only when no static asset matched.
// Hand them to the SPA fallback.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

// serveR2 streams an object out of the bucket, honoring a byte Range request
// (how the viewer reads keyframes and chunks out of a published .brp). `immutable` marks per-replay files that
// never change once written.
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

// parseRange handles the single "bytes=start-[end]" form the viewer sends for
// its reads out of a .brp. Anything else (multi-range, suffix ranges) → no range (full body).
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
  // compression itself); .brw, .brp, .keys and chunk files are opaque binary the
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
