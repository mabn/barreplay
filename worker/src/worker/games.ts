// The BAR history mirror: a background sync that reads the newest games
// api.bar-rts.com knows about and records the ones this worker has never seen
// in the Durable Object's `games` table.
//
// Why it exists: `replays` is the catalog of what somebody UPLOADED or had
// re-simulated, which is a thin slice of what is actually played. `games` is
// the other side — the games BAR published, whether or not any capture of them
// exists — so the pipeline has a work list of its own instead of waiting for a
// person to paste a link.
//
// It reads the newest games until the last GAMES_COVERAGE_SEC (2h) of START
// TIMES is covered, up to GAMES_MAX_PAGES pages of GAMES_PAGE_LIMIT. The
// listing is ordered by start time DESCENDING, so a game that started a while
// ago sits deep in it from the moment it ends: at ~2000 games/day a game that
// started ~90 min ago is already ~120 rows down, and a single 24-row page 1
// never saw it — long and older games were silently missed. Paging back a
// fixed span of start time is what fixes that. It is still bounded, and that
// is what keeps it inside the ROW BUDGET (see worker/ CLAUDE.md): SIZE by
// GAMES_MAX_PAGES, and the index reads it feeds (gamesUnknown) are chunked and
// PK-backed. Games LONGER than the window can still slip past — a start-time
// window cannot cover them — but that is a rare tail, not the every-day miss.
// A gap bigger than the window is a backfill: a different job, run once.
//
// Two API calls are involved and they are not interchangeable: the LISTING
// (which this queries) carries no modoptions, so the settings badges can only
// come from the per-game detail (/replays/<id>), which is fetched once per
// genuinely new game and never again.
//
// Like app.ts, this file has no `cloudflare:workers` import anywhere in its
// module graph, so the node tests drive the whole sync against a fake index
// and a fake fetch.
import { CATALOG_PLAYERS_PER_ALLY, SETTINGS_MODS_FLAG, derivePlayerCount, playersFromApi, settingsFlags } from "./replayentry";
import type { CatalogTeam } from "./replayentry";

/** The BAR replay API this mirrors. */
export const BAR_API = "https://api.bar-rts.com";

/** The listing filters, verbatim. `hasBots=false` and `endedNormally=true`
 * keep the mirror to games worth having: a bot match describes nobody's play,
 * and a game that did not end normally is a crash or an abandon. */
export const GAMES_BASE_QUERY = "hasBots=false&endedNormally=true";

/** Rows per page. 50 (the API caps at 100). */
export const GAMES_PAGE_LIMIT = 50;

/** Page back until the oldest fetched start is at least this old, so every
 * game that STARTED within this span is seen whatever its length (see the
 * module comment). Two hours. */
export const GAMES_COVERAGE_SEC = 2 * 3600;

/** Safety cap on pages per run. 6 x 50 = 300 games comfortably exceeds two
 * hours at BAR's rate (~2000/day), so this is only ever reached by a clock
 * skew, a listing that never ages out, or a bad reply — none of which may turn
 * the once-a-minute cron into a walk of history, and it bounds the burst
 * against a public API. */
export const GAMES_MAX_PAGES = 6;

/** The listing URL for one page. */
export function gamesPageUrl(page: number): string {
  return `${BAR_API}/replays?page=${page}&limit=${GAMES_PAGE_LIMIT}&${GAMES_BASE_QUERY}`;
}

/** How many per-game detail fetches run at once. The list is at most one page,
 * so this bounds a first run's burst against a public API; in the steady state
 * a run has a handful of new games at most. */
const DETAIL_CONCURRENCY = 4;

/** Shape check for an id from the API, matching the /api routes' own. It only
 * has to be safe as a key — BAR's ids are 32 hex chars, but refusing anything
 * else here would silently empty the mirror the day that changes. */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** One mirrored game: what the BAR API says about a game nobody necessarily
 * captured. Deliberately the same vocabulary as a catalog row (map, size,
 * roster, settings badges) so the two can be compared without a translation
 * layer — but it is NOT a ReplayEntry: there is no revision, no upload, no
 * bundle, because nothing has been published. */
export interface GameEntry {
  id: string;
  startUnix: number | null;
  durationSec: number | null;
  /** The map's script name ("Isidis crack 1.1") — what a catalog row's `map`
   * holds, so the two agree. */
  map: string | null;
  /** The map's archive file name, which is what BAR's maps API keys on and
   * what the viewer's own lookup has to guess at when it is missing. */
  mapFile: string | null;
  /** Team spec, largest ally first: "8v8", "1v1", "2v2v2". */
  gameSize: string | null;
  /** BAR's own classification of the game: "duel", "team" or "ffa". Stored
   * verbatim rather than checked against those three, since a value the API
   * adds later is still worth having; the enum lives in ITS source
   * (ReplayPreset), not here, and dropping an unrecognized one would quietly
   * blank the column for a whole class of games. */
  preset: string | null;
  playerCount: number | null;
  players: CatalogTeam[] | null;
  settings: Record<string, boolean | string> | null;
  /** The exact builds the demo pins. A re-simulation must run these two and
   * nothing else, so a work list without them cannot say what a game costs to
   * simulate — see the engine-version note in CLAUDE.md. */
  engineVersion: string | null;
  gameVersion: string | null;
}

/** One row of the Games section's listing (GET /api/games): a mirrored game
 * plus what this deployment has done about it. The mirror itself never
 * says whether a game was captured — that is the catalog's business, and the
 * whole point of putting the two side by side is to see which of the games
 * BAR published this site has a replay of, and which the pipeline is working
 * on. Joined per read (a primary-key seek and one index seek per row), never
 * stored: a stored flag would have to be cleared by whoever finishes the job. */
export interface GameListRow extends GameEntry {
  /** The lobby name the teiserver poll matched to the game, when it did. */
  lobbyName: string | null;
  /** When the mirror recorded the game. */
  syncedUnix: number;
  /** A playable catalog row exists for the game (placeholders — a re-sim in
   * flight with nothing published yet — do not count). */
  published: boolean;
  /** The state of the game's most recent ingest job, if it ever had one. */
  jobState: string | null;
}

/** Where a page of the Games listing stopped: the ORDER key of its last row
 * — when the game ended (start + duration; null for a game with no recorded
 * start, which the DESC order puts last) and its id, the tiebreak. The next
 * page resumes strictly after it on the same index, which is what makes a
 * page cost the same whether it is the first or the thousandth: an OFFSET
 * steps over every row before the page, a cursor seeks to it. */
export interface GamesCursor {
  endUnix: number | null;
  id: string;
}

/** The cursor on the wire: "<endUnix>:<id>", the number blank for null. Not
 * opaque on purpose — a cursor a person can read is a cursor a person can
 * debug — but nothing about its shape is promised to a client beyond "hand
 * back what `next` said". */
export function encodeGamesCursor(c: GamesCursor): string {
  return `${c.endUnix ?? ""}:${c.id}`;
}

const CURSOR_RE = /^(-?\d{1,15})?:([A-Za-z0-9_-]{1,128})$/;

/** parseGamesCursor reads a wire cursor back, or null for anything that is
 * not one. The id part is held to the same shape the mirror accepts (ID_RE),
 * so a cursor is never a way to feed the query an arbitrary string. */
export function parseGamesCursor(raw: string): GamesCursor | null {
  const m = CURSOR_RE.exec(raw);
  if (!m) return null;
  return { endUnix: m[1] === undefined ? null : parseInt(m[1], 10), id: m[2] };
}

/** What syncGames needs of the ReplayIndex Durable Object. Narrowed to the two
 * methods so the tests can stand in for it without modelling the catalog. */
export interface GamesIndex {
  gamesUnknown(ids: string[]): string[] | Promise<string[]>;
  gamesInsert(games: GameEntry[]): number | Promise<number>;
}

/** What one run did, for the cron's log line. */
export interface GameSyncResult {
  /** Ids on the page. */
  scanned: number;
  /** Of those, ones the games table had never recorded. */
  fresh: number;
  /** Rows written. */
  added: number;
  /** New games whose detail could not be fetched or parsed. They are NOT
   * recorded, so the next run retries them — which is the whole recovery
   * story for a blip, and costs nothing once the game drops off the window. */
  failed: number;
  /** Listing pages read this run (1..GAMES_MAX_PAGES). */
  pages: number;
  /** Of the games recorded, ones carrying the mods flag — lava-sync
   * candidates, which is what the cron triggers the lava sync on. */
  modded: number;
}

/** syncGames runs one pass: read page 1, ask the index which ids are new,
 * fetch each new game's detail for its modoptions and roster, and record them.
 *
 * Throws only when the LISTING itself fails — that is the run, and there is
 * nothing partial to keep. A single game's detail failing is counted, not
 * thrown: one unparseable game must not cost the other 23 their row. */
export async function syncGames(index: GamesIndex, fetchImpl: typeof fetch = fetch): Promise<GameSyncResult> {
  // The instant the walk must cover back to. Read once, so every page this run
  // is judged against the same horizon.
  const horizon = Math.floor(Date.now() / 1000) - GAMES_COVERAGE_SEC;
  const seen = new Set<string>();
  const ids: string[] = [];
  let pages = 0;
  for (let page = 1; page <= GAMES_MAX_PAGES; page++) {
    let rows: unknown[];
    try {
      const listed = await fetchJSON(fetchImpl, gamesPageUrl(page));
      rows = Array.isArray((listed as { data?: unknown })?.data)
        ? ((listed as { data: unknown[] }).data)
        : [];
    } catch (e) {
      // Page 1 failing is the run — nothing partial to keep. A LATER page
      // failing ends the walk with what earlier pages gathered, so a blip deep
      // in the list still records the newer games above it.
      if (page === 1) throw e;
      break;
    }
    pages = page;
    let oldest: number | null = null;
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const id = r?.id;
      // Newest first, as the API sorts them, and deduped across pages.
      if (typeof id === "string" && ID_RE.test(id) && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
      // Track the oldest start on this page to decide coverage. A row with no
      // parseable start cannot prove the horizon was reached, so it is ignored
      // here and never shortens the walk.
      const start = parseStart(r?.startTime);
      if (start !== null && (oldest === null || start < oldest)) oldest = start;
    }
    // Stop once the last page is reached (a short page has no successor), or the
    // window is covered (the oldest start this page is at/older than the
    // horizon, so every later game started even earlier).
    if (rows.length < GAMES_PAGE_LIMIT) break;
    if (oldest !== null && oldest <= horizon) break;
  }
  if (ids.length === 0) return { scanned: 0, fresh: 0, added: 0, failed: 0, pages, modded: 0 };

  const fresh = await index.gamesUnknown(ids);
  if (fresh.length === 0) return { scanned: ids.length, fresh: 0, added: 0, failed: 0, pages, modded: 0 };

  const entries: GameEntry[] = [];
  let failed = 0;
  await pool(fresh, DETAIL_CONCURRENCY, async (id) => {
    try {
      const detail = await fetchJSON(fetchImpl, `${BAR_API}/replays/${encodeURIComponent(id)}`);
      entries.push(gameFromApi(id, detail));
    } catch {
      failed++;
    }
  });
  // Oldest first, so a run that is somehow cut short leaves the NEWEST games
  // unrecorded — the ones the next page-1 read is certain to offer again.
  entries.sort((a, b) => (a.startUnix ?? 0) - (b.startUnix ?? 0));
  const added = entries.length === 0 ? 0 : await index.gamesInsert(entries);
  const modded = entries.filter((e) => e.settings?.[SETTINGS_MODS_FLAG] !== undefined).length;
  return { scanned: ids.length, fresh: fresh.length, added, failed, pages, modded };
}

/** gameFromApi builds a mirror row from one /replays/<id> detail reply. The
 * settings and roster go through the same settingsFlags/playersFromApi the
 * admin refresh route uses, so a mirrored game and a refreshed catalog row
 * describe an identical game identically. */
export function gameFromApi(id: string, detail: unknown): GameEntry {
  const d = (typeof detail === "object" && detail !== null ? detail : {}) as Record<string, unknown>;
  const map = (typeof d.Map === "object" && d.Map !== null ? d.Map : {}) as Record<string, unknown>;
  const players = playersFromApi(d.AllyTeams);
  const gameSize = gameSizeSpec(players);
  // The API serves modoption values as strings; coerce defensively, exactly as
  // the refresh-settings route does.
  let settings: Record<string, boolean | string> | null = null;
  if (typeof d.gameSettings === "object" && d.gameSettings !== null) {
    const mo: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.gameSettings as Record<string, unknown>)) mo[k] = String(v);
    settings = settingsFlags(mo);
  }
  return {
    id,
    startUnix: parseStart(d.startTime),
    durationSec: typeof d.durationMs === "number" && Number.isFinite(d.durationMs)
      ? Math.round(d.durationMs / 1000)
      : null,
    map: str(map.scriptName),
    mapFile: str(map.fileName),
    gameSize,
    preset: str(d.preset),
    playerCount: derivePlayerCount(players, gameSize),
    players,
    settings,
    engineVersion: str(d.engineVersion),
    gameVersion: str(d.gameVersion),
  };
}

/** gameSizeSpec renders a roster as BAR's usual size spec — the TypeScript
 * twin of viz.GameSizeSpec, minus its Gaia rule: the API's AllyTeams are the
 * lobby's real sides, so there is no neutral team to drop. A roster capped at
 * CATALOG_PLAYERS_PER_ALLY still counts its full ally, since the group keeps
 * the true count. */
export function gameSizeSpec(players: CatalogTeam[] | null): string | null {
  if (players === null || players.length === 0) return null;
  const counts = players
    .map((g) => (g.count > 0 ? g.count : Math.min(g.players.length, CATALOG_PLAYERS_PER_ALLY)))
    .filter((n) => n > 0)
    .sort((a, b) => b - a);
  return counts.length === 0 ? null : counts.join("v");
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** parseStart reads the API's ISO timestamp into unix seconds. */
function parseStart(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

async function fetchJSON(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`BAR API ${r.status} for ${url}`);
  return await r.json();
}

/** pool runs `fn` over `items` with at most `limit` in flight. Exported for
 * the lobby sync (teiserver.ts), which bounds its show-page fetches with it. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
