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
// The JWT work itself is jose's (jwtVerify + createRemoteJWKSet): nothing
// here parses a token by hand.

import { createRemoteJWKSet, customFetch, decodeJwt, errors, jwtVerify } from "jose";
import type { JWTPayload } from "jose";

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

/** How long jose trusts a fetched key set before re-reading it. Access keys
 * rotate rarely (and an unknown kid re-reads at once, below), so this only
 * bounds a stale set. */
export const JWKS_TTL_MS = 6 * 60 * 60 * 1000;
/** The floor between two key-set fetches provoked by an UNKNOWN kid. A token
 * naming a kid the set does not have is what key rotation looks like — and
 * also what a forged token looks like, and the second must not turn into one
 * outbound fetch per request. jose's cooldownDuration. */
export const JWKS_REFETCH_MIN_MS = 60 * 1000;

export interface VerifyOptions {
  teamDomain: string;
  aud: string;
  /** Unix milliseconds; defaults to Date.now(). Only the claims (exp/nbf)
   * read it — the key-set cache keeps jose's own clock. */
  now?: number;
}

export interface VerifierOptions {
  /** Override of JWKS_REFETCH_MIN_MS (tests: 0 makes a rotation visible
   * without waiting a minute). */
  cooldownMs?: number;
  /** Override of JWKS_TTL_MS. */
  cacheMaxAgeMs?: number;
}

/** The jose errors that mean "this token is no good" — answered with null.
 * Everything else jose throws (a key set that cannot be fetched or parsed,
 * a timeout) is an outage and propagates. */
const BAD_TOKEN_ERRORS = [
  errors.JWTClaimValidationFailed,
  errors.JWTExpired,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWTInvalid,
  errors.JWKInvalid,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

/** AccessVerifier verifies Access JWTs for one team + application with jose
 * (jwtVerify over createRemoteJWKSet, which owns the key-set cache, its
 * TTL and the unknown-kid refetch cooldown). One instance lives for the
 * isolate's life in app.ts. */
export class AccessVerifier {
  private jwks: { href: string; get: ReturnType<typeof createRemoteJWKSet> } | null = null;
  private readonly cooldownMs: number;
  private readonly cacheMaxAgeMs: number;

  constructor(opts: VerifierOptions = {}) {
    this.cooldownMs = opts.cooldownMs ?? JWKS_REFETCH_MIN_MS;
    this.cacheMaxAgeMs = opts.cacheMaxAgeMs ?? JWKS_TTL_MS;
  }

  /** verify returns the token's identity, or null for anything short of a
   * valid, unexpired token for THIS application. It never throws for a bad
   * token; it throws only when the key set cannot be read at all, which is
   * an outage, not an answer. */
  async verify(token: string, opts: VerifyOptions): Promise<AccessIdentity | null> {
    const now = opts.now ?? Date.now();
    const issuer = accessIssuer(opts.teamDomain);

    // A cheap look at the claims first (no signature, no key set): a token
    // for another issuer or application, or one already expired, is not
    // worth a key lookup, which may be a fetch.
    let claims: JWTPayload;
    try {
      claims = decodeJwt(token);
    } catch {
      return null;
    }
    if (claims.iss !== issuer) return null;
    const aud = claims.aud;
    if (!(Array.isArray(aud) ? aud.includes(opts.aud) : aud === opts.aud)) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;

    const url = new URL(accessCertsURL(opts.teamDomain));
    if (!this.jwks || this.jwks.href !== url.href) {
      this.jwks = {
        href: url.href,
        get: createRemoteJWKSet(url, {
          cooldownDuration: this.cooldownMs,
          cacheMaxAge: this.cacheMaxAgeMs,
          // globalThis.fetch at call time, never captured at import: the
          // tests stub it per test, and a captured reference would outlive
          // the stub.
          [customFetch]: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
        }),
      };
    }
    try {
      const { payload } = await jwtVerify(token, this.jwks.get, {
        issuer,
        audience: opts.aud,
        algorithms: ["RS256"],
        currentDate: new Date(now),
        requiredClaims: ["exp", "sub"],
      });
      return {
        email: typeof payload.email === "string" ? payload.email : null,
        sub: payload.sub as string,
      };
    } catch (e) {
      if (BAD_TOKEN_ERRORS.some((cls) => e instanceof cls)) return null;
      throw e;
    }
  }

  /** forget drops the key-set cache (tests). */
  forget(): void {
    this.jwks = null;
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
