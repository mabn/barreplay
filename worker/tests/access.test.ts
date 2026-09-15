// The Access JWT verifier (src/worker/access.ts) against a keypair this test
// makes: a token it signs itself must verify, and every way a token can be
// wrong — signature, audience, issuer, expiry, algorithm, an unknown key —
// must come back null rather than throw. The key set is served by a stubbed
// globalThis.fetch, which is also how the refetch-on-rotation and its rate
// limit are observed.
import assert from "node:assert/strict";
import test from "node:test";

import {
  AccessVerifier,
  JWKS_REFETCH_MIN_MS,
  JWKS_TTL_MS,
  accessCertsURL,
  accessToken,
  loginNext,
  normalizeTeamDomain,
} from "../src/worker/access";

const TEAM = "example";
const AUD = "a".repeat(64);
const NOW = 1_800_000_000_000;

const b64url = (bytes: Uint8Array | string): string => {
  const bin = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

interface Signer {
  kid: string;
  jwk: JsonWebKey;
  sign: (header: object, claims: object) => Promise<string>;
}

async function makeSigner(kid: string): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    jwk,
    sign: async (header, claims) => {
      const h = b64url(JSON.stringify(header));
      const p = b64url(JSON.stringify(claims));
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
      return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
    },
  };
}

/** Serve these signers' public keys as the team's cert set, counting reads. */
function stubCerts(t: { after(fn: () => void): void }, signers: () => Signer[]) {
  const orig = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url !== accessCertsURL(TEAM)) return new Response("nope", { status: 404 });
    const keys = signers().map((s) => ({ kid: s.kid, kty: "RSA", n: s.jwk.n, e: s.jwk.e, alg: "RS256" }));
    return Response.json({ keys });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = orig;
  });
  return calls;
}

const goodClaims = (over: Record<string, unknown> = {}) => ({
  aud: [AUD],
  iss: `https://${TEAM}.cloudflareaccess.com`,
  sub: "user-1",
  email: "admin@example.org",
  exp: Math.floor(NOW / 1000) + 3600,
  iat: Math.floor(NOW / 1000) - 60,
  ...over,
});

test("a token Access signed for this application verifies to its identity", async (t) => {
  const signer = await makeSigner("k1");
  const calls = stubCerts(t, () => [signer]);
  const v = new AccessVerifier();
  const token = await signer.sign({ alg: "RS256", kid: "k1", typ: "JWT" }, goodClaims());

  const id = await v.verify(token, { teamDomain: TEAM, aud: AUD, now: NOW });
  assert.deepEqual(id, { email: "admin@example.org", sub: "user-1" });
  assert.equal(calls.length, 1, "the key set was read once");

  // A second token reuses the cached keys.
  await v.verify(token, { teamDomain: TEAM, aud: AUD, now: NOW + 1000 });
  assert.equal(calls.length, 1, "cached");

  // A string aud (Access sends an array, but the claim allows both).
  const single = await signer.sign({ alg: "RS256", kid: "k1" }, goodClaims({ aud: AUD }));
  assert.ok(await v.verify(single, { teamDomain: TEAM, aud: AUD, now: NOW }));

  // A service token carries no email.
  const svc = await signer.sign({ alg: "RS256", kid: "k1" }, goodClaims({ email: undefined }));
  assert.deepEqual(await v.verify(svc, { teamDomain: TEAM, aud: AUD, now: NOW }), { email: null, sub: "user-1" });
});

test("every wrong token is null, never an exception", async (t) => {
  const signer = await makeSigner("k1");
  const other = await makeSigner("k1"); // same kid, different key: a forgery
  stubCerts(t, () => [signer]);
  const v = new AccessVerifier();
  const H = { alg: "RS256", kid: "k1" };
  const opts = { teamDomain: TEAM, aud: AUD, now: NOW };

  const cases: [string, Promise<string> | string][] = [
    ["forged signature", other.sign(H, goodClaims())],
    ["wrong audience", signer.sign(H, goodClaims({ aud: ["b".repeat(64)] }))],
    ["wrong issuer", signer.sign(H, goodClaims({ iss: "https://evil.cloudflareaccess.com" }))],
    ["expired", signer.sign(H, goodClaims({ exp: Math.floor(NOW / 1000) - 1 }))],
    ["not yet valid", signer.sign(H, goodClaims({ nbf: Math.floor(NOW / 1000) + 60 }))],
    ["no exp", signer.sign(H, goodClaims({ exp: undefined }))],
    ["no sub", signer.sign(H, goodClaims({ sub: undefined }))],
    ["alg none", `${b64url('{"alg":"none","kid":"k1"}')}.${b64url(JSON.stringify(goodClaims()))}.`],
    ["HS256", signer.sign({ alg: "HS256", kid: "k1" }, goodClaims())],
    ["no kid", signer.sign({ alg: "RS256" }, goodClaims())],
    ["two parts", "abc.def"],
    ["garbage", "not a token at all"],
    ["bad json", `${b64url("{nope")}.${b64url("{}")}.${b64url("x")}`],
    ["tampered payload", (async () => {
      const tok = await signer.sign(H, goodClaims());
      const [h, , s] = tok.split(".");
      return `${h}.${b64url(JSON.stringify(goodClaims({ email: "root@example.org" })))}.${s}`;
    })()],
  ];
  for (const [name, tok] of cases) {
    assert.equal(await v.verify(await tok, opts), null, name);
  }
});

test("an unknown kid re-reads the key set once a minute at most — rotation, not a fetch per forgery", async (t) => {
  const k1 = await makeSigner("k1");
  const k2 = await makeSigner("k2");
  let live = [k1];
  const calls = stubCerts(t, () => live);
  const v = new AccessVerifier();
  const opts = { teamDomain: TEAM, aud: AUD };

  assert.ok(await v.verify(await k1.sign({ alg: "RS256", kid: "k1" }, goodClaims()), { ...opts, now: NOW }));
  assert.equal(calls.length, 1);

  // Rotation: k2 signs, the set is re-read and k2 is found — once the floor
  // since the last read has passed (a rotation seconds after a read waits
  // out the minute, which is the price of the rate limit).
  live = [k1, k2];
  const t2 = await k2.sign({ alg: "RS256", kid: "k2" }, goodClaims());
  const T_ROT = NOW + JWKS_REFETCH_MIN_MS + 1000;
  assert.equal(await v.verify(t2, { ...opts, now: NOW + 1000 }), null, "inside the floor: not re-read yet");
  assert.equal(calls.length, 1);
  assert.ok(await v.verify(t2, { ...opts, now: T_ROT }), "the rotated-in key is found on a re-read");
  assert.equal(calls.length, 2);

  // A stream of unknown kids inside the floor costs no further fetch.
  for (let i = 0; i < 5; i++) {
    const forged = await k1.sign({ alg: "RS256", kid: `bogus-${i}` }, goodClaims());
    assert.equal(await v.verify(forged, { ...opts, now: T_ROT + 1000 + i }), null);
  }
  assert.equal(calls.length, 2, "no re-read inside JWKS_REFETCH_MIN_MS");

  // Past the floor, one more.
  const later = await k1.sign({ alg: "RS256", kid: "bogus-x" }, goodClaims());
  assert.equal(await v.verify(later, { ...opts, now: T_ROT + JWKS_REFETCH_MIN_MS + 1 }), null);
  assert.equal(calls.length, 3);

  // And the TTL alone re-reads a set that is simply old (a token that is
  // still valid then, since the one above has expired by six hours later).
  const T_OLD = T_ROT + JWKS_TTL_MS + JWKS_REFETCH_MIN_MS + 10;
  const longLived = await k2.sign({ alg: "RS256", kid: "k2" }, goodClaims({ exp: Math.floor(T_OLD / 1000) + 60 }));
  assert.ok(await v.verify(longLived, { ...opts, now: T_OLD }));
  assert.equal(calls.length, 4);
});

test("an unreadable key set is an error, not a silent pass or a silent refusal", async (t) => {
  const signer = await makeSigner("k1");
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = orig;
  });
  const v = new AccessVerifier();
  const tok = await signer.sign({ alg: "RS256", kid: "k1" }, goodClaims());
  await assert.rejects(v.verify(tok, { teamDomain: TEAM, aud: AUD, now: NOW }), /Access certs: HTTP 503/);
});

test("the token is read from the Access header first, then the CF_Authorization cookie", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  assert.equal(accessToken(h({})), null);
  assert.equal(accessToken(h({ cookie: "other=1; CF_Authorization=tok.en.x; more=2" })), "tok.en.x");
  assert.equal(accessToken(h({ cookie: "CF_Authorization=" })), null, "an empty cookie is no token");
  assert.equal(accessToken(h({ cookie: "xCF_Authorization=nope" })), null, "the name must match whole");
  assert.equal(accessToken(h({ "cf-access-jwt-assertion": "hdr", cookie: "CF_Authorization=cookie" })), "hdr");
});

test("team domain spellings normalize; the login's next stays on this site", () => {
  for (const raw of ["example", "example.cloudflareaccess.com", "https://example.cloudflareaccess.com/", " Example "]) {
    assert.equal(normalizeTeamDomain(raw), "example.cloudflareaccess.com", raw);
    assert.equal(accessCertsURL(raw), "https://example.cloudflareaccess.com/cdn-cgi/access/certs");
  }
  assert.equal(loginNext("/queue?admin=true"), "/queue?admin=true");
  assert.equal(loginNext("/replays/abc?admin=true&gl=0"), "/replays/abc?admin=true&gl=0");
  assert.equal(loginNext(null), "/queue?admin=true");
  assert.equal(loginNext("https://evil.example/"), "/queue?admin=true", "an absolute URL is not a destination");
  assert.equal(loginNext("//evil.example/x"), "/queue?admin=true", "a protocol-relative URL neither");
  assert.equal(loginNext("queue"), "/queue?admin=true", "a relative path neither");
});
