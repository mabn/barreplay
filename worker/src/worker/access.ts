// Cloudflare Access as the admin login.
//
// The admin surface — the Queue and SQL sections, the re-sim paste box, the
// row refresh and POV controls, the job hold-back switch — used to be gated
// by nothing but `?admin=true` in the front-end. The routes behind it were
// open, and app.js is served unminified to every visitor, so anyone could
// read the request shape off the page and drive the routes from a script;
// somebody did, feeding every ranked game to POST /api/resim within minutes
// of it ending (2026-09-15: 195 pending re-sims, 60 an hour arriving against
// one host clearing 2-3).
//
// Access is the login because it means no password handling here at all: an
// Access APPLICATION in the Zero Trust dashboard protects ONE path of this
// worker's hostname, /admin/login, with a policy naming the people allowed.
// A visitor who passes it gets a `CF_Authorization` cookie for the whole
// hostname holding a JWT that Access signed. This module VERIFIES that JWT —
// signature against the team's published keys, audience against this
// application's AUD tag, issuer, expiry — on every admin route, so the edge
// rule is the login and the worker is the gate. Verifying here rather than
// trusting the edge matters twice: the routes are also reachable on the
// workers.dev hostname, where no Access rule runs, and a header saying "Access
// let me through" is only trustworthy on the path Access actually protects.
//
// Configuration is two vars (env.d.ts): ACCESS_TEAM_DOMAIN, the Zero Trust
// team ("<team>.cloudflareaccess.com", or just "<team>"), and ACCESS_AUD, the
// application's Audience tag. FAIL-CLOSED: with either missing every admin
// route answers 401, so a deploy that forgot them locks the admin out rather
// than opening the door. Local dev opts out with ADMIN_OPEN=true in .dev.vars
// — a deliberate setting, never a default, and never in wrangler.jsonc.
//
// The bearer token the daemons hold (REPLAY_PUT_TOKEN) is accepted too, so an
// operator's script can drive an admin route with the credential it already
// has. Only when the token is CONFIGURED and matches: `authorized` in app.ts
// is open when the secret is absent, which is right for a dev bucket and
// wrong for a login.
//
// Pure like games.ts: the JWKS fetch is `globalThis.fetch` read at call time
// (the node tests stub it, as they do for the BAR API) and the clock is an
// argument, so the whole thing is tested against a keypair the test makes.

/** Where a team's Access signing keys are published. */
export const accessCertsURL = (teamDomain: string): string =>
  `https://${normalizeTeamDomain(teamDomain)}/cdn-cgi/access/certs`;

/** The `iss` claim Access stamps: the team domain, with scheme, no path. */
export const accessIssuer = (teamDomain: string): string => `https://${normalizeTeamDomain(teamDomain)}`;

/** normalizeTeamDomain accepts what a person pastes — "mabn",
 * "mabn.cloudflareaccess.com", "https://mabn.cloudflareaccess.com/" — and
 * returns the bare hostname. */
export function normalizeTeamDomain(raw: string): string {
  let d = raw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!d.includes(".")) d = `${d}.cloudflareaccess.com`;
  return d.toLowerCase();
}

/** Who an admin request is from, once verified. `email` is what Access puts
 * in the token for a person; a service token has none (`sub` only). */
export interface AccessIdentity {
  email: string | null;
  sub: string;
}

export interface AccessJWK {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

/** How long a fetched key set is trusted before it is re-read. Access keys
 * rotate rarely (and an unknown kid re-reads at once, below), so this is
 * only what bounds a stale set. */
export const JWKS_TTL_MS = 6 * 60 * 60 * 1000;
/** The floor between two key-set fetches provoked by an UNKNOWN kid. A token
 * naming a kid the set does not have is what key rotation looks like — and
 * also what a forged token looks like, and the second must not turn into one
 * outbound fetch per request. */
export const JWKS_REFETCH_MIN_MS = 60 * 1000;

/** The JWK set the verifier holds for one team domain, with when it was
 * read. */
interface JWKSCache {
  url: string;
  keys: AccessJWK[];
  fetchedAt: number;
}

export interface VerifyOptions {
  teamDomain: string;
  aud: string;
  /** Unix milliseconds; defaults to Date.now(). */
  now?: number;
}

/** AccessVerifier verifies Access JWTs for one team + application, caching
 * the team's key set across calls. One instance lives for the isolate's
 * life in app.ts. */
export class AccessVerifier {
  private cache: JWKSCache | null = null;
  private lastRefetch = 0;

  /** verify returns the token's identity, or null for anything short of a
   * valid, unexpired token for THIS application. It never throws for a bad
   * token; it throws only when the key set cannot be read at all, which is
   * an outage, not an answer. */
  async verify(token: string, opts: VerifyOptions): Promise<AccessIdentity | null> {
    const now = opts.now ?? Date.now();
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(b64urlToString(h));
      claims = JSON.parse(b64urlToString(p));
    } catch {
      return null;
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

    // Claims before the signature: they are cheap, and a token that fails
    // them is not worth a key lookup (which may be a fetch).
    const nowSec = Math.floor(now / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= nowSec) return null;
    if (typeof claims.nbf === "number" && claims.nbf > nowSec) return null;
    if (claims.iss !== accessIssuer(opts.teamDomain)) return null;
    const aud = claims.aud;
    const audOk = Array.isArray(aud) ? aud.includes(opts.aud) : aud === opts.aud;
    if (!audOk) return null;
    if (typeof claims.sub !== "string") return null;

    const key = await this.keyFor(header.kid, opts.teamDomain, now);
    if (!key) return null;
    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    } catch {
      return null;
    }
    let ok = false;
    try {
      ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        cryptoKey,
        b64urlToBytes(s),
        new TextEncoder().encode(`${h}.${p}`),
      );
    } catch {
      return null;
    }
    if (!ok) return null;
    return { email: typeof claims.email === "string" ? claims.email : null, sub: claims.sub };
  }

  /** keyFor finds the signing key by kid, reading the team's key set when
   * there is none cached, when the cache is old, or — rate-limited — when the
   * kid is unknown (rotation). */
  private async keyFor(kid: string, teamDomain: string, now: number): Promise<AccessJWK | null> {
    const url = accessCertsURL(teamDomain);
    const stale = !this.cache || this.cache.url !== url || now - this.cache.fetchedAt > JWKS_TTL_MS;
    if (stale) await this.refetch(url, now);
    let key = this.cache?.keys.find((k) => k.kid === kid) ?? null;
    if (!key && !stale && now - this.lastRefetch >= JWKS_REFETCH_MIN_MS) {
      await this.refetch(url, now);
      key = this.cache?.keys.find((k) => k.kid === kid) ?? null;
    }
    return key;
  }

  private async refetch(url: string, now: number): Promise<void> {
    this.lastRefetch = now;
    // globalThis.fetch at call time, never captured at import: the tests
    // stub it per test, and a captured reference would outlive the stub.
    const r = await globalThis.fetch(url);
    if (!r.ok) throw new Error(`Access certs: HTTP ${r.status} from ${url}`);
    const body = (await r.json()) as { keys?: unknown };
    const keys = Array.isArray(body.keys)
      ? (body.keys as unknown[]).filter(
          (k): k is AccessJWK =>
            typeof k === "object" &&
            k !== null &&
            typeof (k as AccessJWK).kid === "string" &&
            (k as AccessJWK).kty === "RSA" &&
            typeof (k as AccessJWK).n === "string" &&
            typeof (k as AccessJWK).e === "string",
        )
      : [];
    this.cache = { url, keys, fetchedAt: now };
  }

  /** forget drops the cached key set (tests). */
  forget(): void {
    this.cache = null;
    this.lastRefetch = 0;
  }
}

/** accessToken finds the Access JWT on a request. On the path the Access
 * application protects, Access itself adds the assertion header; everywhere
 * else the browser sends the cookie Access set for the hostname, which is
 * what every admin API call carries. */
export function accessToken(headers: { get(name: string): string | null }): string | null {
  const h = headers.get("cf-access-jwt-assertion");
  if (h) return h.trim();
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === "CF_Authorization") return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** loginNext keeps a post-login destination on this site: a path, never a
 * URL — an open redirect on the one page every admin passes through would
 * be a phishing tool. Anything else lands on the queue. */
export function loginNext(raw: string | null | undefined): string {
  if (typeof raw === "string" && /^\/(?!\/)[^\r\n]*$/.test(raw) && raw.length <= 2048) return raw;
  return "/queue?admin=true";
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}
