// What search engines read: each page's <title>, description, canonical URL
// and share preview, written into the SPA entry by the worker before it is
// served, plus robots.txt and the sitemaps.
//
// The viewer is a single page that draws everything in the browser, so
// without this every URL on the site answered with the same "barreplay
// viewer" title and no description, and /robots.txt and /sitemap.xml were
// answered with the viewer itself (the asset layer's single-page fallback).
// Google does run the page's script, but it ranks and lists a page by what
// the HTML says first, and a replay link shared in Discord shows only that.
//
// Pure (no workerd imports), like app.ts, so tests/seo.test.ts drives it in
// node.
import type { ReplayEntry } from "./replayentry";

export const SITE_NAME = "barreplay";

/** HEAD_START/HEAD_END bracket the block of index.html this module
 * rewrites. index.html carries the home page's version of it, so a page
 * served without the worker (vite dev, a plain static host) still has a
 * sensible title. */
export const HEAD_START = "<!--seo-->";
export const HEAD_END = "<!--/seo-->";

const HOME_TITLE = "BAR Replays: watch Beyond All Reason replays online | barreplay";
const HOME_DESCRIPTION =
  "Watch Beyond All Reason (BAR) replays in your browser: every unit on the map, " +
  "the chat, and a game summary of the battles and turning points. Thousands of recent BAR games.";

export interface PageHead {
  title: string;
  description: string;
  /** Absolute canonical URL, always on the public origin. */
  canonical: string;
  /** False: the page asks not to be indexed (admin sections, a replay that
   * is not published). */
  index: boolean;
  /** Absolute URL of a share-preview image, if the page has one. */
  image?: string;
  /** Extra JSON-LD to embed (already a plain object). */
  jsonLd?: Record<string, unknown>;
}

export function homeHead(origin: string): PageHead {
  return {
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    canonical: `${origin}/`,
    index: true,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE_NAME,
      alternateName: ["BAR replays", "Beyond All Reason replays"],
      url: `${origin}/`,
      description: HOME_DESCRIPTION,
    },
  };
}

/** sectionHead is the head of a landing-page section other than the replay
 * list. Admin sections are not indexed (a visitor sees nothing there). */
export function sectionHead(origin: string, section: "games" | "queue" | "sqlstats"): PageHead {
  if (section === "games") {
    return {
      title: "Recent Beyond All Reason games | barreplay",
      description: "Every recent Beyond All Reason (BAR) game, with its map, players and settings, " +
        "and a link to its replay where one has been simulated.",
      canonical: `${origin}/games`,
      index: true,
    };
  }
  return { title: `${SITE_NAME}`, description: HOME_DESCRIPTION, canonical: `${origin}/${section}`, index: false };
}

/** GAME_ID_RE finds the game id at the head of any replay page path segment:
 * a bare id, <id>-<rev>, or the file name under a month folder. */
const GAME_ID_RE = /^([0-9a-f]{32})(?:-[0-9a-f]+)?$/;

export function gameIdOfPage(segment: string): string | null {
  const m = GAME_ID_RE.exec(segment);
  return m ? m[1] : null;
}

/** replayHead is the head of /replays/<gameId>. A missing row (a game not
 * simulated yet: the page offers to request it) and a placeholder (a game
 * being worked on, nothing to play) are not indexed — the same URL becomes
 * worth indexing once the replay is published, and the sitemap lists it
 * then. */
export function replayHead(origin: string, gameId: string, e: ReplayEntry | null): PageHead {
  const canonical = `${origin}/replays/${gameId}`;
  if (!e || e.placeholder) {
    return {
      title: `Beyond All Reason replay ${gameId.slice(0, 8)} | barreplay`,
      description: HOME_DESCRIPTION,
      canonical,
      index: false,
    };
  }
  const map = e.map?.trim() || null;
  const size = sizeText(e);
  const date = e.startUnix ? fmtDay(e.startUnix) : null;
  const head = [map, size].filter(Boolean).join(" ") || "Game";
  const title = `${head}${date ? `, ${date}` : ""}: Beyond All Reason replay | barreplay`;

  const what = [size ? `${size} game` : "game", map ? `on ${map}` : null].filter(Boolean).join(" ");
  const facts = [
    e.durationSec ? `${Math.max(1, Math.round(e.durationSec / 60))} min` : null,
    date,
    e.settings?.ranked === true ? "ranked" : null,
    e.lobbyName ? `lobby "${e.lobbyName}"` : null,
  ].filter(Boolean);
  let description = `Watch this Beyond All Reason ${what}${facts.length ? ` (${facts.join(", ")})` : ""}: ` +
    "every unit on the map, the chat and a game summary.";
  const players = playersText(e);
  if (players) description += ` ${players}`;

  return {
    title,
    description: clip(description, 300),
    canonical,
    index: true,
    image: e.mapFile ? `${origin}/api/bar/maps/${encodeURIComponent(e.mapFile)}/texture-mq.jpg` : undefined,
  };
}

/** sizeText says the game's size the way the list does: "8v8", and a
 * free-for-all of four or more sides as "16-player FFA" (its spec would be
 * "1v1v1v1v...", useless in a title). */
function sizeText(e: ReplayEntry): string | null {
  const spec = e.gameSize?.trim();
  if (!spec) return null;
  const parts = spec.split("v");
  if (parts.length >= 4) {
    const n = parts.reduce((s, p) => s + (parseInt(p, 10) || 0), 0);
    return n > 0 ? `${n}-player FFA` : "FFA";
  }
  return spec;
}

/** playersText names the players side by side ("Players: a, b vs c, d"),
 * a few per side, so a search for a player's name can find their games. */
function playersText(e: ReplayEntry): string | null {
  const sides = (e.players ?? []).filter((t) => t.players.length > 0);
  if (sides.length === 0) return null;
  const per = sides.length > 2 ? 2 : 5;
  const text = sides
    .slice(0, 4)
    .map((t) => {
      const names = t.players.slice(0, per).map((p) => p.name);
      return t.count > names.length ? `${names.join(", ")} +${t.count - names.length}` : names.join(", ");
    })
    .join(" vs ");
  return `Players: ${text}${sides.length > 4 ? " vs ..." : ""}.`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(unix: number): string {
  const d = new Date(unix * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "\u2026";
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** renderHead writes the block that replaces index.html's HEAD_START..
 * HEAD_END. */
export function renderHead(h: PageHead): string {
  const a = escapeHtml;
  const lines = [
    `<title>${a(h.title)}</title>`,
    `<meta name="description" content="${a(h.description)}">`,
    `<link rel="canonical" href="${a(h.canonical)}">`,
    h.index ? null : `<meta name="robots" content="noindex">`,
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${a(h.title)}">`,
    `<meta property="og:description" content="${a(h.description)}">`,
    `<meta property="og:url" content="${a(h.canonical)}">`,
    h.image ? `<meta property="og:image" content="${a(h.image)}">` : null,
    `<meta name="twitter:card" content="${h.image ? "summary_large_image" : "summary"}">`,
    // "</" cannot appear inside a script block; JSON.stringify leaves it.
    h.jsonLd ? `<script type="application/ld+json">${JSON.stringify(h.jsonLd).replace(/</g, "\\u003c")}</script>` : null,
  ];
  return HEAD_START + "\n" + lines.filter(Boolean).join("\n") + "\n" + HEAD_END;
}

/** injectHead swaps the page's head block for this page's. An entry with no
 * markers (an old build, or a page that is not the viewer) is returned
 * untouched rather than guessed at. */
export function injectHead(html: string, h: PageHead): string {
  const i = html.indexOf(HEAD_START);
  const j = html.indexOf(HEAD_END, i);
  if (i < 0 || j < 0) return html;
  return html.slice(0, i) + renderHead(h) + html.slice(j + HEAD_END.length);
}

/** robotsTxt keeps crawlers out of the admin routes only. /api/ stays open
 * on purpose: Google renders the page with its own script, and a blocked
 * /api/replays would leave the rendered replay list empty. */
export function robotsTxt(origin: string): string {
  return [
    "User-agent: *",
    "Disallow: /admin/",
    "Disallow: /api/admin/",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

/** The replay sitemaps are split by the first hex digit of the game id: each
 * is a range scan over the catalog's primary key, no count or paging needed,
 * and each stays under the 50,000-URL limit until the catalog passes ~800k. */
export const SITEMAP_SHARDS = "0123456789abcdef".split("");

export function sitemapIndex(origin: string): string {
  const maps = [`${origin}/sitemaps/pages.xml`, ...SITEMAP_SHARDS.map((s) => `${origin}/sitemaps/replays-${s}.xml`)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    maps.map((u) => `<sitemap><loc>${escapeHtml(u)}</loc></sitemap>`).join("\n") +
    "\n</sitemapindex>\n";
}

export interface SitemapUrl {
  loc: string;
  lastmod?: number;
}

export function sitemapPages(origin: string): SitemapUrl[] {
  return [{ loc: `${origin}/` }, { loc: `${origin}/games` }, { loc: `${origin}/setup` }];
}

export function sitemapReplays(origin: string, rows: { id: string; updatedUnix: number | null }[]): SitemapUrl[] {
  return rows.map((r) => ({ loc: `${origin}/replays/${r.id}`, lastmod: r.updatedUnix ?? undefined }));
}

export function sitemapXml(urls: SitemapUrl[]): string {
  const body = urls.map((u) => {
    const mod = u.lastmod ? `<lastmod>${new Date(u.lastmod * 1000).toISOString().slice(0, 10)}</lastmod>` : "";
    return `<url><loc>${escapeHtml(u.loc)}</loc>${mod}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    body.join("\n") + "\n</urlset>\n";
}
