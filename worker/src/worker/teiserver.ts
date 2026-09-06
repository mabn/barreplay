// Teiserver lobby polling: the OTHER half of the games mirror. The rts-api
// sync (games.ts) records what BAR PUBLISHED, which a game only reaches after
// it ends — and that record carries no lobby name. The name exists only while
// the lobby is alive, on teiserver's web UI, so this module watches
// https://server4.beyondallreason.info/battle/lobbies every cron tick,
// records an OBSERVATION per lobby-game the moment it is first seen in
// progress (name, map, the non-spectator roster — the snapshot the user cares
// about, taken within the first minute while the roster is still honest), and
// later matches each observation to the mirrored game that eventually appears,
// writing the lobby name onto its `games` row.
//
// There is no shared id between a teiserver lobby and an rts-api game, so the
// match is heuristic, on three signals: the MAP (strong), the START TIME
// (strong — the observation's started_unix is at most one cron tick after the
// true start), and the PLAYER LIST (players drift a little as people join and
// leave; spectators churn constantly and are excluded at capture time).
//
// The pages are Phoenix LiveView "dead renders": the data is in the initial
// HTML, there is no JSON API, and Workers have no DOM — hence the small
// well-scoped regex parsers (adapted, like the session below, from
// mabn/claudebar's lavabalance project, which drives the same pages).
//
// Like games.ts, this file has no `cloudflare:workers` import anywhere in its
// module graph, so the node tests drive the whole sync against a fake index
// and a fake fetch.
import { pool } from "./games";

/** Teiserver web base (the login form and the lobby pages). */
export const WEB_BASE = "https://server4.beyondallreason.info";
/** The lobby list page the sync reads every tick. */
export const LOBBIES_PATH = "/battle/lobbies";
/** Per-request timeout for an upstream web fetch. */
const FETCH_TIMEOUT_MS = 8000;
/** How many show-page fetches run at once. A tick observes the lobbies that
 * STARTED since the last one — normally 0-2 — so this only bounds the first
 * tick after a long outage, when everything running looks new. */
const SHOW_CONCURRENCY = 2;

/** How long after a game's rts-api start time a lobby observation may begin
 * and still match it. The observation lags the true start by up to one cron
 * tick; five minutes is generous slack for that plus clock disagreement
 * between teiserver and the API. */
export const LOBBY_MATCH_WINDOW_SEC = 300;
/** How much EARLIER than the game's start an observation may be and still
 * match. It should never meaningfully precede the game it describes; one
 * minute covers the two clocks disagreeing. */
export const LOBBY_MATCH_EARLY_SLACK_SEC = 60;
/** Minimum roster agreement: |intersection| / min(|lobby|, |game|). Half the
 * smaller roster still present tolerates the join/leave churn around a game
 * start without letting two different games on one map shake hands. */
export const LOBBY_MATCH_MIN_OVERLAP = 0.5;

// ---- HTML parsing (adapted from claudebar's lavabalance/src/teiserver.ts) ----

/** Strip HTML tags then decode the handful of entities Teiserver emits. */
function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse the leading number out of a cell ("21.24" → 21.24); null if none. */
function parseNumber(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Parse the running time rendered next to the play icon — "13:49" or
 * "1:03:49" — into seconds; null for anything else. */
function parseElapsed(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Extract the Phoenix CSRF token from a rendered page. The `<meta
 * name="csrf-token">` value matches the login form's hidden `_csrf_token` on
 * the (unauthenticated) login page, and is what the POST must echo back.
 */
export function extractCsrfToken(html: string): string | null {
  const meta = /<meta\s+name="csrf-token"\s+content="([^"]*)"/.exec(html);
  if (meta) return meta[1];
  const input = /name="_csrf_token"[^>]*value="([^"]*)"/.exec(html);
  return input ? input[1] : null;
}

/** One row of the /battle/lobbies index table. The page has no player names
 * and no start time — those come from the show page and from WHEN the row is
 * first seen in progress, respectively. */
export interface IndexLobby {
  id: number;
  name: string;
  map: string;
  inProgress: boolean;
  /** How long the game has been running ("13:49" next to the play icon),
   * in seconds; null when not in progress or not rendered. This is what
   * makes the start time accurate even for a game already minutes in when
   * first observed (a fresh deployment, downtime): started = seen − elapsed. */
  elapsedSec: number | null;
  locked: boolean;
  passworded: boolean;
  memberCount: number;
  playerCount: number;
  spectatorCount: number;
}

/** Parse the /battle/lobbies index. Column meaning is positional (name, map,
 * play icon, lock icon, key icon, members, players, spectators) — the table
 * renders the same for every account class, unlike the show page. */
export function parseLobbyIndex(html: string): IndexLobby[] {
  const out: IndexLobby[] = [];
  for (const row of html.matchAll(/<tr id="lobby-(\d+)">([\s\S]*?)<\/tr>/g)) {
    const id = Number(row[1]);
    const tds = [...row[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    out.push({
      id,
      name: cellText(tds[0] ?? ""),
      map: cellText(tds[1] ?? ""),
      inProgress: /fa-play/.test(tds[2] ?? ""),
      elapsedSec: parseElapsed(cellText(tds[2] ?? "")),
      locked: /fa-lock/.test(tds[3] ?? ""),
      passworded: /fa-key/.test(tds[4] ?? ""),
      memberCount: parseNumber(cellText(tds[5] ?? "")) ?? 0,
      playerCount: parseNumber(cellText(tds[6] ?? "")) ?? 0,
      spectatorCount: parseNumber(cellText(tds[7] ?? "")) ?? 0,
    });
  }
  return out;
}

/** One non-spectator row of a show page's players table, every cell kept.
 * Any field but the name is null when its column is absent (teiserver renders
 * different columns per account class) or its cell is blank — a blank Party
 * cell means the player queued alone. */
export interface LobbyRosterPlayer {
  name: string;
  /** Numeric Team cell. */
  team: number | null;
  /** Party label, kept as the trimmed cell TEXT rather than a number: it is
   * only ever compared for equality (players sharing a value queued
   * together), so this survives whatever rendering teiserver picks. */
  party: string | null;
  /** The lobby-shown rating ("27.25"). */
  rating: number | null;
  /** Handicap bonus. */
  bonus: number | null;
  /** Faction pick ("Armada", "Random", ...). */
  faction: string | null;
}

/**
 * Parse the non-spectator players table of a /battle/lobbies/show/<id> page,
 * keeping every cell. Cells are resolved by header LABEL so the extra columns
 * a moderator account sees cannot shift anything; the spectators table is
 * deliberately never read — spectators join and leave constantly, so a roster
 * that included them would disagree with itself minutes apart, and the match
 * this roster feeds ignores them by design.
 */
export function parseLobbyShowRoster(html: string): LobbyRosterPlayer[] {
  const tbl = /<table[^>]*id="players-table"[\s\S]*?<\/table>/.exec(html);
  if (!tbl) return [];
  const thead = /<thead>([\s\S]*?)<\/thead>/.exec(tbl[0]);
  const headers = thead
    ? [...thead[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => cellText(m[1]).toLowerCase())
    : [];
  const col = (label: string) => headers.indexOf(label);
  const nameCol = col("name");
  if (nameCol < 0) return [];
  const teamCol = col("team");
  const partyCol = col("party");
  const ratingCol = col("rating");
  const bonusCol = col("bonus");
  const factionCol = col("faction");
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(tbl[0]);
  if (!tbody) return [];
  const out: LobbyRosterPlayer[] = [];
  for (const r of tbody[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
    if (!cells.length) continue;
    const cell = (i: number) => (i < 0 ? "" : cellText(cells[i]?.[1] ?? ""));
    const name = cell(nameCol);
    if (!name) continue;
    out.push({
      name,
      team: parseNumber(cell(teamCol)),
      party: cell(partyCol) || null,
      rating: parseNumber(cell(ratingCol)),
      bonus: parseNumber(cell(bonusCol)),
      faction: cell(factionCol) || null,
    });
  }
  return out;
}

/** The roster's names alone — what the lobby↔game matching consumes. */
export function parseLobbyShowPlayers(html: string): string[] {
  return parseLobbyShowRoster(html).map((p) => p.name);
}

// ---- Session (adapted from claudebar's lavabalance/src/bot/teiserverWeb.ts) ----

/** Credentials, read lazily on each use; `base` overrides the web base for
 * tests. The web form wants the password raw. */
export interface TeiserverConfig {
  email?: string;
  password?: string;
  base?: string;
}

/**
 * A logged-in session to the Teiserver web UI: a cookie jar, lazy CSRF login,
 * and authed fetches with one expired-session re-login retry. The jar lives
 * in memory for the duration of one sync; the `onCookiesChanged` hook is how
 * it persists between ticks (the DO stores it in the one-row
 * teiserver_session table), so the cron reuses the Guardian token instead of
 * re-logging-in every minute.
 */
export class TeiserverSession {
  /** Cookie jar (name → value). */
  private cookies = new Map<string, string>();
  /** De-dupes concurrent logins so overlapping calls share one round-trip. */
  private loginInflight?: Promise<void>;

  constructor(
    private readonly config: () => TeiserverConfig,
    /** Called with the whole jar whenever it changes (for persistence). */
    private readonly onCookiesChanged?: (cookies: Record<string, string>) => void | Promise<void>,
    /** The network; injected so the node tests can stub it. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Seed the jar from persisted state. In-memory cookies already set win —
   * the live jar is newer than what was stored. */
  seedCookies(stored: Record<string, string>): void {
    for (const [name, value] of Object.entries(stored)) {
      if (!this.cookies.has(name)) this.cookies.set(name, value);
    }
  }

  /** Whether the jar carries a Guardian auth token (a live-looking session). */
  hasSession(): boolean {
    return this.cookies.has("guardian_default_token");
  }

  /** Ensure a live session: reuse an existing Guardian cookie, otherwise log
   * in once (de-duped across overlapping callers). */
  ensureLogin(): Promise<void> {
    if (this.hasSession()) return Promise.resolve();
    if (!this.loginInflight) {
      this.loginInflight = this.login().finally(() => {
        this.loginInflight = undefined;
      });
    }
    return this.loginInflight;
  }

  /**
   * Log in: GET the login form (for the CSRF token + initial session cookie),
   * then POST the credentials. Success is a 3xx redirect that sets a
   * non-empty `guardian_default_token`; a failed login re-renders the form
   * (200) with no token.
   */
  private async login(): Promise<void> {
    const { email, password } = this.config();
    if (!email || !password) {
      throw new Error("TEISERVER_EMAIL/TEISERVER_PASSWORD are not configured");
    }
    this.cookies.clear();

    const page = await this.webFetch("/login", { redirect: "manual" });
    this.captureCookies(page);
    const token = extractCsrfToken(await page.text());
    if (!token) throw new Error("could not find a CSRF token on the login page");

    const body = new URLSearchParams();
    body.set("_csrf_token", token);
    body.set("user[email]", email);
    body.set("user[password]", password);
    const res = await this.webFetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    this.captureCookies(res);

    const redirected = res.status >= 300 && res.status < 400;
    if (!redirected || !this.cookies.get("guardian_default_token")) {
      throw new Error("teiserver login failed (invalid credentials?)");
    }
    // Hand the freshly-issued session to the persistence hook.
    await this.notifyCookies();
  }

  /**
   * GET an authed page as text. An expired session shows up as a redirect
   * back to /login: drop the dead Guardian cookie, log in again, retry once.
   */
  async authedFetch(path: string): Promise<string> {
    await this.ensureLogin();
    let res = await this.webFetch(path, { redirect: "manual" });
    if (this.isLoginRedirect(res)) {
      this.cookies.delete("guardian_default_token");
      await this.ensureLogin();
      res = await this.webFetch(path, { redirect: "manual" });
    }
    // Keep the persisted jar in sync if the server rotated a cookie.
    if (this.captureCookies(res)) await this.notifyCookies();
    if (res.status !== 200) {
      throw new Error(`teiserver GET ${path} returned ${res.status} ${res.statusText}`);
    }
    return res.text();
  }

  private isLoginRedirect(res: Response): boolean {
    if (res.status < 300 || res.status >= 400) return false;
    return (res.headers.get("location") ?? "").includes("/login");
  }

  /** fetch() against the web base, attaching the cookie jar and a timeout.
   * A failure throws an error naming the request (method + path) and whether
   * it was our deadline — the raw AbortError says only "aborted" — and never
   * a body, which for the login POST would carry the password. */
  private async webFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    const headers = new Headers(init.headers);
    headers.set("accept", headers.get("accept") ?? "text/html");
    const cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.set("cookie", cookie);
    // Detach before calling: `this.fetchImpl(...)` would invoke the global
    // fetch with the session as `this`, which workerd rejects ("Illegal
    // invocation").
    const fetchImpl = this.fetchImpl;
    try {
      return await fetchImpl(`${this.config().base ?? WEB_BASE}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      const reason = timedOut
        ? `timed out after ${FETCH_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      throw new Error(`teiserver ${method} ${path} failed: ${this.redactPassword(reason)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Replace the configured password wherever it appears in a message (raw or
   * form-url-encoded, the shape the login POST body carries). */
  private redactPassword(s: string): string {
    const pw = this.config().password;
    if (!pw) return s;
    let out = s;
    for (const variant of new Set([pw, encodeURIComponent(pw)])) {
      if (variant) out = out.split(variant).join("REDACTED");
    }
    return out;
  }

  /** Merge a response's Set-Cookie headers into the jar (empty value =
   * delete). Returns whether the jar actually changed, so persistence runs
   * only when needed. */
  private captureCookies(res: Response): boolean {
    let changed = false;
    for (const line of res.headers.getSetCookie()) {
      const first = line.split(";", 1)[0];
      const eq = first.indexOf("=");
      if (eq < 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!name) continue;
      if (value === "") {
        if (this.cookies.delete(name)) changed = true;
      } else if (this.cookies.get(name) !== value) {
        this.cookies.set(name, value);
        changed = true;
      }
    }
    return changed;
  }

  private notifyCookies(): Promise<void> | void {
    return this.onCookiesChanged?.(Object.fromEntries(this.cookies));
  }
}

// ---- Matching ----

/** An unmatched lobby observation, as the matcher sees it. */
export interface MatchLobby {
  lobbyId: number;
  startedUnix: number;
  map: string | null;
  /** Non-spectator names; null when the show-page fetch failed at capture
   * time (the observation is still worth matching on map + time alone). */
  players: string[] | null;
}

/** A mirrored game still without a lobby name, as the matcher sees it. */
export interface MatchGame {
  id: string;
  startUnix: number | null;
  map: string | null;
  /** Roster names, flattened from the row's CatalogTeam JSON. */
  players: string[];
}

/** A decided pairing: this observation names that game. */
export interface LobbyMatch {
  lobbyId: number;
  startedUnix: number;
  gameId: string;
}

/** Map names compare case- and whitespace-insensitively: both sides carry the
 * map's script name, but nothing promises identical rendering. */
function normMap(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Decide which lobby observation names which game. Hard gates first — same
 * map (normalized), and the observation began within
 * [-LOBBY_MATCH_EARLY_SLACK_SEC, +LOBBY_MATCH_WINDOW_SEC] of the game's start
 * — then the roster score: |intersection| / min(|lobby|, |game|) of the
 * lowercased names, at least LOBBY_MATCH_MIN_OVERLAP. An observation whose
 * show-page fetch failed (players null) passes on map + time alone but scores
 * below every real roster match, so it only wins what nothing better claims.
 *
 * Assignment is greedy best-first — score, then smaller |Δt|, then lobby id —
 * and each observation and each game is used at most once. Ties resolve (best
 * candidate wins) rather than abstain: a lobby name on the games row is worth
 * an occasional coin flip between two near-identical lobbies.
 */
export function pickLobbyMatches(lobbies: MatchLobby[], games: MatchGame[]): LobbyMatch[] {
  interface Candidate {
    lobby: MatchLobby;
    game: MatchGame;
    score: number;
    dt: number;
  }
  const candidates: Candidate[] = [];
  for (const lobby of lobbies) {
    if (lobby.map === null) continue;
    for (const game of games) {
      if (game.startUnix === null || game.map === null) continue;
      if (normMap(lobby.map) !== normMap(game.map)) continue;
      const dt = lobby.startedUnix - game.startUnix;
      if (dt < -LOBBY_MATCH_EARLY_SLACK_SEC || dt > LOBBY_MATCH_WINDOW_SEC) continue;
      let score = 0;
      if (lobby.players !== null) {
        const gameNames = new Set(game.players.map((n) => n.toLowerCase()));
        const lobbyNames = new Set(lobby.players.map((n) => n.toLowerCase()));
        if (gameNames.size === 0 || lobbyNames.size === 0) continue;
        let common = 0;
        for (const n of lobbyNames) if (gameNames.has(n)) common++;
        score = common / Math.min(lobbyNames.size, gameNames.size);
        if (score < LOBBY_MATCH_MIN_OVERLAP) continue;
      }
      candidates.push({ lobby, game, score, dt: Math.abs(dt) });
    }
  }
  candidates.sort(
    (a, b) => b.score - a.score || a.dt - b.dt || a.lobby.lobbyId - b.lobby.lobbyId || (a.game.id < b.game.id ? -1 : 1),
  );
  const usedLobbies = new Set<MatchLobby>();
  const usedGames = new Set<string>();
  const out: LobbyMatch[] = [];
  for (const c of candidates) {
    if (usedLobbies.has(c.lobby) || usedGames.has(c.game.id)) continue;
    usedLobbies.add(c.lobby);
    usedGames.add(c.game.id);
    out.push({ lobbyId: c.lobby.lobbyId, startedUnix: c.lobby.startedUnix, gameId: c.game.id });
  }
  return out;
}

// ---- The sync itself ----

/** Everything the lobby pages say about a game beyond name/map/roster-names:
 * the index page's flags and counts plus the show page's full per-player
 * rows. One JSON blob (like jobs.stats): nothing filters on it in SQL, it is
 * recorded to be read back — and copied verbatim onto the matched games row,
 * since the observation itself is pruned 48h after a match. */
export interface LobbyDetails {
  locked: boolean;
  passworded: boolean;
  memberCount: number | null;
  spectatorCount: number | null;
  /** Per-player rows from the show page (party assignments live here); null
   * when that fetch failed — the index-page fields above are still good. */
  players: LobbyRosterPlayer[] | null;
}

/** A newly started lobby-game, ready to record. started_unix is stamped by
 * the DO at insert time — "when this sync saw it" IS the observation. */
export interface LobbyObservation {
  lobbyId: number;
  name: string;
  map: string | null;
  /** Non-spectator names, or null when the show-page fetch failed. */
  players: string[] | null;
  playerCount: number | null;
  /** The index page's running time at observation, so started_unix can be
   * back-dated for a game already minutes in when first seen. */
  elapsedSec: number | null;
  /** The full lobby detail at observation time (see LobbyDetails). */
  details: LobbyDetails;
}

/** An observation still open (its lobby was in progress last tick). */
export interface OpenLobby {
  lobbyId: number;
  startedUnix: number;
}

/** What one lobbiesMatch run did. */
export interface LobbyMatchResult {
  matched: number;
  pruned: number;
}

/** What syncLobbies needs of the ReplayIndex Durable Object, narrowed so the
 * node tests can stand in for it without modelling the catalog. */
export interface LobbyIndex {
  teiserverCookies(): Record<string, string> | null | Promise<Record<string, string> | null>;
  teiserverCookiesPut(jar: Record<string, string>): void | Promise<void>;
  lobbiesOpen(): OpenLobby[] | Promise<OpenLobby[]>;
  lobbiesObserve(obs: LobbyObservation[]): void | Promise<void>;
  lobbiesEnd(lobbyIds: number[]): void | Promise<void>;
  lobbiesMatch(): LobbyMatchResult | Promise<LobbyMatchResult>;
}

/** What one run did, for the cron's log line. */
export interface LobbySyncResult {
  /** Lobbies in progress on the page. */
  active: number;
  /** Of those, ones with no open observation — new games, observed now. */
  started: number;
  /** Open observations whose lobby finished or vanished. */
  ended: number;
  /** Observations paired to a mirrored game this tick. */
  matched: number;
  /** Started lobbies whose show page could not be fetched. Their observation
   * is still recorded (players null) — that first-minute roster never comes
   * back, but name + map + time can still match on their own. */
  failed: number;
}

/**
 * syncLobbies runs one pass: list the lobbies, open an observation for every
 * lobby newly in progress (with its roster, from one show-page fetch), close
 * the observations whose lobby finished, and try to match what is unmatched
 * against the games mirror.
 *
 * Throws only when the login or the list fetch fails — that is the run.
 * Steady-state cost is ONE authenticated GET per tick (the Guardian cookie
 * persists in the DO between ticks, so there is no per-tick login) plus one
 * show-page GET per newly started lobby, which is 0-2 in practice.
 */
export async function syncLobbies(
  index: LobbyIndex,
  creds: { email: string; password: string; base?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<LobbySyncResult> {
  const session = new TeiserverSession(
    () => ({ email: creds.email, password: creds.password, base: creds.base }),
    (jar) => index.teiserverCookiesPut(jar),
    fetchImpl,
  );
  const stored = await index.teiserverCookies();
  if (stored) session.seedCookies(stored);

  const page = parseLobbyIndex(await session.authedFetch(LOBBIES_PATH));
  const open = await index.lobbiesOpen();
  const openIds = new Set(open.map((o) => o.lobbyId));
  const inProgress = page.filter((l) => l.inProgress);
  const inProgressIds = new Set(inProgress.map((l) => l.id));

  const started = inProgress.filter((l) => !openIds.has(l.id));
  const endedIds = open.map((o) => o.lobbyId).filter((id) => !inProgressIds.has(id));

  let failed = 0;
  const observations: LobbyObservation[] = [];
  await pool(started, SHOW_CONCURRENCY, async (lobby) => {
    let roster: LobbyRosterPlayer[] | null = null;
    try {
      roster = parseLobbyShowRoster(await session.authedFetch(`${LOBBIES_PATH}/show/${lobby.id}`));
    } catch {
      failed++;
    }
    observations.push({
      lobbyId: lobby.id,
      name: lobby.name,
      map: lobby.map === "" ? null : lobby.map,
      players: roster === null ? null : roster.map((p) => p.name),
      playerCount: roster !== null ? roster.length : lobby.playerCount,
      elapsedSec: lobby.elapsedSec,
      details: {
        locked: lobby.locked,
        passworded: lobby.passworded,
        memberCount: lobby.memberCount,
        spectatorCount: lobby.spectatorCount,
        players: roster,
      },
    });
  });

  if (observations.length > 0) await index.lobbiesObserve(observations);
  if (endedIds.length > 0) await index.lobbiesEnd(endedIds);
  const m = await index.lobbiesMatch();

  return {
    active: inProgress.length,
    started: started.length,
    ended: endedIds.length,
    matched: m.matched,
    failed,
  };
}
