// What search engines and link previews read (src/worker/seo.ts), through
// the real routes: each page's head written into the SPA entry, robots.txt
// and the sitemaps.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import app from "../src/worker/app";
import type { ReplayEntry } from "../src/worker/replayentry";
import { HEAD_END, HEAD_START, gameIdOfPage, injectHead, replayHead } from "../src/worker/seo";

const ORIGIN = "https://replay.fogofwar.dev";
const GAME = "6a37d06acbb455b1d19179d8ec965f10";
const INDEX_HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function entry(over: Partial<ReplayEntry> = {}): ReplayEntry {
  return {
    id: GAME,
    rid: `2026-11/${GAME}`,
    startUnix: Date.UTC(2026, 10, 26, 18, 30) / 1000,
    durationSec: 34 * 60,
    map: "Supreme Isthmus v2.1",
    gameSize: "8v8",
    sizeBytes: 1,
    settings: { ranked: true },
    players: [
      { count: 8, players: [{ name: "Alice" }, { name: "Bob" }] },
      { count: 8, players: [{ name: "Carol" }, { name: "<script>" }] },
    ],
    playerCount: 16,
    uploaderAlly: null,
    uploads: null,
    view: "full",
    widgetVersion: null,
    widgetSha: null,
    widgetDate: null,
    placeholder: false,
    lobbyName: "Lava & friends",
    mapFile: "supreme_isthmus_v2.1",
    ...over,
  } as ReplayEntry;
}

function env(rows: ReplayEntry[], sitemap: { id: string; updatedUnix: number | null }[] = []) {
  const index = {
    list: (filter: { id: string | null }) => rows.filter((r) => filter.id === null || r.id.startsWith(filter.id)),
    sitemapRows: (shard: string) => sitemap.filter((r) => r.id.startsWith(shard)),
  };
  return {
    REPLAY_INDEX: { idFromName: () => ({}), get: () => index },
    ASSETS: {
      fetch: async () => new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
    },
  } as unknown as Env;
}

const headOf = (html: string) => html.slice(html.indexOf(HEAD_START), html.indexOf(HEAD_END));

test("index.html carries the head block the worker rewrites", () => {
  const head = headOf(INDEX_HTML);
  assert.match(head, /<title>BAR Replays: watch Beyond All Reason replays online/);
  assert.match(head, /<meta name="description"/);
});

test("the home page gets its title, canonical URL and WebSite data", async () => {
  const res = await app.request("/", {}, env([]));
  const head = headOf(await res.text());
  assert.match(head, /<title>BAR Replays: watch Beyond All Reason replays online \| barreplay<\/title>/);
  assert.match(head, new RegExp(`<link rel="canonical" href="${ORIGIN}/">`));
  assert.match(head, /"@type":"WebSite"/);
  assert.doesNotMatch(head, /noindex/);
  assert.equal(res.headers.get("cache-control"), "no-cache");
});

test("a replay page is titled by its map, size and date, and names its players", async () => {
  const res = await app.request(`/replays/${GAME}`, {}, env([entry()]));
  const head = headOf(await res.text());
  assert.match(head, /<title>Supreme Isthmus v2\.1 8v8, 26 Nov 2026: Beyond All Reason replay \| barreplay<\/title>/);
  assert.match(head, /34 min, 26 Nov 2026, ranked, lobby &quot;Lava &amp; friends&quot;/);
  assert.match(head, /Players: Alice, Bob \+6 vs Carol, &lt;script&gt; \+6\./);
  assert.match(head, new RegExp(`<link rel="canonical" href="${ORIGIN}/replays/${GAME}">`));
  assert.match(head, /og:image" content="https:\/\/replay\.fogofwar\.dev\/api\/bar\/maps\/supreme_isthmus_v2\.1\/texture-mq\.jpg"/);
  assert.doesNotMatch(head, /noindex/);
});

test("a revision's page points at the game's canonical URL", async () => {
  for (const path of [`/replays/${GAME}-1a2b3c4d`, `/replays/2026-11/${GAME}-1a2b3c4d`]) {
    const head = headOf(await (await app.request(path, {}, env([entry()]))).text());
    assert.match(head, new RegExp(`<link rel="canonical" href="${ORIGIN}/replays/${GAME}">`), path);
  }
});

test("an unpublished or placeholder replay is not indexed", async () => {
  for (const rows of [[], [entry({ placeholder: true })]]) {
    const head = headOf(await (await app.request(`/replays/${GAME}`, {}, env(rows))).text());
    assert.match(head, /<meta name="robots" content="noindex">/);
  }
});

test("admin sections are not indexed; the games list is", async () => {
  for (const [path, noindex] of [["/queue", true], ["/sqlstats", true], ["/games", false]] as const) {
    const head = headOf(await (await app.request(path, {}, env([]))).text());
    assert.equal(/noindex/.test(head), noindex, path);
  }
});

test("the workers.dev hostname asks not to be indexed", async () => {
  const res = await app.request("https://replay.bartools.workers.dev/", {}, env([]));
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  const pub = await app.request("https://replay.fogofwar.dev/", {}, env([]));
  assert.equal(pub.headers.get("x-robots-tag"), null);
});

test("robots.txt is text and names the sitemap", async () => {
  const res = await app.request("/robots.txt", {}, env([]));
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  const body = await res.text();
  assert.match(body, new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, "m"));
  assert.match(body, /^Disallow: \/api\/admin\/$/m);
  // /api/ itself must stay crawlable: the rendered page reads /api/replays.
  assert.doesNotMatch(body, /^Disallow: \/api\/$/m);
});

test("the sitemap index lists the pages and every replay shard", async () => {
  const body = await (await app.request("/sitemap.xml", {}, env([]))).text();
  assert.match(body, /<sitemapindex/);
  assert.match(body, new RegExp(`<loc>${ORIGIN}/sitemaps/pages\\.xml</loc>`));
  for (const s of "0123456789abcdef") assert.match(body, new RegExp(`sitemaps/replays-${s}\\.xml`));
});

test("a replay shard lists its replays with their last publish", async () => {
  const rows = [
    { id: GAME, updatedUnix: Date.UTC(2026, 10, 26) / 1000 },
    { id: "6b00000000000000000000000000000a", updatedUnix: null },
    { id: "7c00000000000000000000000000000a", updatedUnix: 1 },
  ];
  const res = await app.request("/sitemaps/replays-6.xml", {}, env([], rows));
  assert.match(res.headers.get("content-type") ?? "", /application\/xml/);
  const body = await res.text();
  assert.match(body, new RegExp(`<url><loc>${ORIGIN}/replays/${GAME}</loc><lastmod>2026-11-26</lastmod></url>`));
  assert.match(body, /replays\/6b00000000000000000000000000000a<\/loc><\/url>/);
  assert.doesNotMatch(body, /7c000/);
  assert.equal((await app.request("/sitemaps/replays-g.xml", {}, env([]))).status, 404);
});

test("gameIdOfPage takes the id from every replay page form", () => {
  assert.equal(gameIdOfPage(GAME), GAME);
  assert.equal(gameIdOfPage(`${GAME}-1a2b3c4d`), GAME);
  assert.equal(gameIdOfPage("not-a-game"), null);
});

test("a free-for-all is titled by its head count, not its spec", () => {
  const h = replayHead(ORIGIN, GAME, entry({ gameSize: "1v1v1v1v1v1", players: null, lobbyName: null }));
  assert.match(h.title, /^Supreme Isthmus v2\.1 6-player FFA, /);
});

test("injectHead leaves a page without markers alone", () => {
  assert.equal(injectHead("<title>x</title>", replayHead(ORIGIN, GAME, entry())), "<title>x</title>");
});
