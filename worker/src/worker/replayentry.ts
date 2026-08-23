// The replay catalog's row shape and PUT-body validation. Kept free of any
// workerd import so the node-side tests (tsx --test) and the upload tooling
// can use it directly; the Durable Object in replayindex.ts builds on it.

/** One catalog row, as served by GET /api/replays. Stats are best-effort —
 * an uploader that doesn't know a field sends null and the UI shows a dash. */
export interface ReplayEntry {
  id: string;
  /** The revision the pieces are actually served under (`<gameId>-<rev>`,
   * rev = first 8 hex of the source stream's SHA-256). Publishes are
   * append-only — a re-upload lands under a fresh rid and this field moves,
   * so `/replays/*`'s immutable caching is always sound. Null for replays
   * uploaded pre-revisioning (pieces live under the bare id). */
  rid: string | null;
  /** Unix seconds when the game started (demo header UnixTime). */
  startUnix: number | null;
  /** Game length in seconds (sampled range of the capture). */
  durationSec: number | null;
  map: string | null;
  /** Team-size spec, e.g. "8v8", "1v1", "2v2v2". */
  gameSize: string | null;
  /** Download footprint of the replay's static files in bytes. */
  sizeBytes: number | null;
  /** Notable game-settings flags distilled from the demo's modoptions by the
   * uploader (viz.SettingsFlags in Go — keys like ranked/lava/mods/noAir with
   * boolean or short string values). Flat object; only present flags are sent,
   * so a vanilla ranked game is just {ranked: true}. Null when the uploader
   * had no demo to read (pack -no-demo). */
  settings: Record<string, boolean | string> | null;
  /** Roster for the landing list AND the list's player filter: one group per
   * ally team (ascending ally id), each carrying the ally's players sorted by
   * OpenSkill ("os") with count keeping the ally's true size. The slice is
   * capped at CATALOG_PLAYERS_PER_ALLY, which is why that cap is generous
   * rather than display-sized — a name missing from here cannot be filtered
   * on, and at the old cap of 5 an 8v8 hid three players per side. */
  players: CatalogTeam[] | null;
  /** Total players in the game, Gaia/scavenger teams excluded — the "size"
   * the list filters on. DERIVED (derivePlayerCount), never read from a PUT
   * body: it is the roster's summed counts, falling back to the gameSize spec
   * when a row has no roster at all. Null when neither is available. */
  playerCount: number | null;
  /** Ally team of the client that recorded the capture behind the current
   * revision — which side's point of view the replay shows. Null for engine
   * re-sim captures and spectator recordings (they see the whole game). */
  uploaderAlly: number | null;
  /** Whose point of view the capture is from, when known:
   *  - "full"    a spectator (or a re-sim) — sees every team
   *  - "ally"    one side only; uploaderAlly names it
   *  - "unknown" explicitly marked as undetermined
   *  - null      never marked
   * uploaderAlly alone cannot express this: null there is ambiguous between
   * "full", "unknown" and "legacy row". Set by the publishing PUT when the
   * capture knows its own provenance, and by hand via setView for the many
   * rows whose captures predate the recorder fields. */
  view: "full" | "ally" | "unknown" | null;
  /** Every revision ever published for this game with the side that recorded
   * it, oldest first. Server-owned: accumulated across PUTs (mergeUploads),
   * never accepted from a PUT body. Superseded revisions stay servable, so
   * each entry keeps playing at ?replay=<rid>. */
  uploads: UploadRef[] | null;
  /** The uploader-widget build that produced the capture behind the CURRENT
   * revision, read out of the stream's GAME line by the publisher:
   *  - widgetVersion  semver of the release, e.g. "1.7.0"
   *  - widgetSha      git SHA of the exact file, stamped into the copy players
   *                   download (worker/tools/sync-assets.mjs). Null when a
   *                   player installed the widget straight from the repo, so
   *                   it was never stamped
   *  - widgetDate     when that release was cut (the widget bumps it with the
   *                   version)
   * Version+date say which release; the SHA says which bytes of it — the
   * distinction that matters for a file served unchanged in name for weeks.
   * All null for a re-sim revision (no uploader widget involved) and for the
   * many rows whose captures predate the fields. Per-revision provenance is
   * not lost when a game is re-published: each entry in `uploads` carries the
   * same trio for its own revision. */
  widgetVersion: string | null;
  widgetSha: string | null;
  widgetDate: string | null;
  /** True while this row exists ONLY because the pipeline is working on the
   * game: a job entered "processing" and nothing has been published yet. It
   * is the row's way of saying there is nothing to play, which is what the
   * viewer refuses to open — a missing rid could not carry that meaning, since
   * the Go server's rows have none and play fine. A publish clears it, and a
   * job that ends with nothing published removes the row.
   *
   * Server-owned, like `uploads`: a PUT body cannot set it. Absent from the Go
   * server's catalog, which has no pipeline behind it, so the front-end must
   * read a missing value as false. */
  placeholder: boolean;
  /** True while some job for this game is in "processing" — the badge the list
   * shows. DERIVED from the jobs table on every read rather than stored, so
   * nothing has to remember to clear it: it stops being true the moment the
   * job stops running, whether it finished, failed, or its daemon vanished.
   * Server-owned and absent from the Go server's catalog, exactly like
   * `placeholder`. */
  processing: boolean;
  /** The processing job's live percent (0-100), when it reports one — read
   * off the jobs row's progress JSON at the same moment `processing` is
   * derived, so the list's pill can say "processing: 52%" instead of just
   * that something is happening. Null while the job is in a phase with
   * nothing to measure (download, provisioning, load). Server-owned and
   * optional like lobbyName. */
  processingPercent?: number | null;
  /** The name of the lobby the game was played under, JOINED at read time
   * from the games mirror's lobby_name (the teiserver poll wrote it there —
   * see teiserver.ts). Never stored on the replays row and never accepted
   * from a PUT — the join is the single source, so the name appears the
   * moment the match lands with no republish. Optional because only the DO's
   * list fills it; the Go server's catalog has no games mirror and omits it,
   * and the front-end reads a missing value as null. */
  lobbyName?: string | null;
  /** The map's ARCHIVE file name ("all_that_glitters_v2.2.3") — what BAR's
   * maps API keys on, and what the list's terrain thumbnail needs. Joined at
   * read time from the games mirror exactly like lobbyName (same ownership,
   * same optionality); rows without a mirror row read null and the front-end
   * falls back to guessing the file from the display name. */
  mapFile?: string | null;
}

/** One ally team's roster slice in a catalog row. */
export interface CatalogTeam {
  ally: number;
  /** Total players on the ally team (players may be a capped slice). */
  count: number;
  players: { name: string; os?: number }[];
}

/** One published revision of a game and the ally team that recorded it. */
export interface UploadRef {
  rid: string;
  ally: number | null;
  /** The widget build behind THIS revision (see the row's widget* fields).
   * The row's copy describes only the revision it currently points at, so a
   * re-publish would otherwise erase what produced the earlier upload —
   * exactly the data this is here to keep. Absent for revisions published
   * before the fields existed, and for re-sim revisions. */
  widget?: WidgetRef;
}

/** The uploader-widget build that produced one capture. */
export interface WidgetRef {
  version?: string;
  sha?: string;
  date?: string;
}

/** ReplayFilter narrows GET /api/replays. Every field is independent and
 * ANDed; a null (or empty settings) means "don't restrict on this". The same
 * shape is applied by the Durable Object in SQL and by the Go viz server over
 * its computed list (internal/viz/catalog.go), so the one front-end filters
 * identically against either backend. */
export interface ReplayFilter {
  /** Inclusive bounds on startUnix (unix seconds). */
  from: number | null;
  to: number | null;
  /** Exact map name. */
  map: string | null;
  /** Inclusive bounds on playerCount (Gaia excluded — see derivePlayerCount). */
  minPlayers: number | null;
  maxPlayers: number | null;
  /** Inclusive bounds on durationSec. A row whose duration is unknown matches
   * NEITHER bound: there is nothing to compare, and counting an unknown as a
   * match would put games of any length inside a range the user drew. */
  minDuration: number | null;
  maxDuration: number | null;
  /** PREFIX of the game id, lowercase hex. A prefix rather than
   * an exact match for one reason: the whole id is 32 characters of hex that
   * nobody types, so what actually happens is a paste — of the id, or of the
   * head of one out of a log line or a URL — and an exact match turns the
   * second of those into an empty list. It is a range over the PRIMARY KEY,
   * so a full id costs one seek. */
  id: string | null;
  /** Case-insensitive PREFIX of a player's name; the row matches when any
   * player in its roster matches. A prefix rather than a substring because it
   * answers to an index range scan, and because the UI offers the known names
   * as completions anyway. */
  player: string | null;
  /** Settings flags that must ALL be present on the row (the list's badges). */
  settings: string[];
}

/** The empty filter: matches every row. */
export function emptyFilter(): ReplayFilter {
  return {
    from: null, to: null, map: null,
    minPlayers: null, maxPlayers: null,
    minDuration: null, maxDuration: null,
    id: null, player: null, settings: [],
  };
}

const FILTER_MAX_SETTINGS = 16;

/** parseReplayFilter reads a ReplayFilter off a GET /api/replays query string,
 * or returns a string describing what was malformed. Dates accept either unix
 * seconds or YYYY-MM-DD; a YYYY-MM-DD `to` covers the WHOLE day (a date range
 * that silently excluded its last day would be a quiet lie about the result).
 * Unknown params are ignored, so an older front-end and a newer worker keep
 * working together. */
export function parseReplayFilter(params: URLSearchParams): ReplayFilter | string {
  const f = emptyFilter();

  const date = (key: string, endOfDay: boolean): number | null | string => {
    const raw = (params.get(key) ?? "").trim();
    if (raw === "") return null;
    if (/^-?\d+$/.test(raw)) return Number(raw);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!m) return `${key} must be unix seconds or YYYY-MM-DD`;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
    if (!Number.isFinite(t)) return `${key} is not a valid date`;
    return endOfDay ? t + 86399 : t;
  };
  const from = date("from", false);
  if (typeof from === "string") return from;
  const to = date("to", true);
  if (typeof to === "string") return to;
  f.from = from;
  f.to = to;

  // digits caps the value implicitly, which is all these need: a bound is
  // compared against a column, never used to size anything.
  const int = (key: string, digits: number): number | null | string => {
    const raw = (params.get(key) ?? "").trim();
    if (raw === "") return null;
    if (!new RegExp(`^\\d{1,${digits}}$`).test(raw)) return `${key} must be a non-negative integer`;
    return Number(raw);
  };
  const minP = int("minPlayers", 4);
  if (typeof minP === "string") return minP;
  const maxP = int("maxPlayers", 4);
  if (typeof maxP === "string") return maxP;
  f.minPlayers = minP;
  f.maxPlayers = maxP;

  // Seconds, six digits: the slider only ever writes 0..3600 (its top end
  // means "and longer", so it writes nothing at all), but a hand-written URL
  // may reasonably ask for a three-hour game.
  const minD = int("minDuration", 6);
  if (typeof minD === "string") return minD;
  const maxD = int("maxDuration", 6);
  if (typeof maxD === "string") return maxD;
  f.minDuration = minD;
  f.maxDuration = maxD;

  const map = (params.get("map") ?? "").trim();
  if (map !== "") f.map = map.slice(0, 200);
  // A game id is lowercase hex, and a REFUSAL rather than a silent miss when
  // it is not: unlike a map or a player name, there is no such thing as a
  // partly-typed id that happens to be wrong — anything non-hex here is a
  // paste of the wrong thing, and an empty list would look like an archive
  // that does not have the game.
  const id = (params.get("id") ?? "").trim().toLowerCase();
  if (id !== "") {
    if (!/^[0-9a-f]{1,32}$/.test(id)) return "id must be a game id, or the start of one (hex)";
    f.id = id;
  }
  const player = (params.get("player") ?? "").trim();
  if (player !== "") f.player = player.slice(0, 64).toLowerCase();

  const settings = (params.get("settings") ?? "").trim();
  if (settings !== "") {
    const flags = [...new Set(settings.split(",").map((s) => s.trim()).filter(Boolean))];
    if (flags.length > FILTER_MAX_SETTINGS) return `at most ${FILTER_MAX_SETTINGS} settings flags`;
    for (const flag of flags) {
      if (!/^[A-Za-z0-9_]{1,40}$/.test(flag)) return `invalid settings flag ${JSON.stringify(flag)}`;
    }
    f.settings = flags;
  }
  return f;
}

/** filterIsEmpty reports whether a filter restricts anything at all. */
export function filterIsEmpty(f: ReplayFilter): boolean {
  return (
    f.from === null && f.to === null && f.map === null &&
    f.minPlayers === null && f.maxPlayers === null &&
    f.minDuration === null && f.maxDuration === null &&
    f.id === null && f.player === null && f.settings.length === 0
  );
}

/** ReplayFacets are the distinct values present in the catalog, so the filter
 * UI can offer real choices instead of free text. Served by
 * GET /api/replays/facets by both backends. */
export interface ReplayFacets {
  maps: string[];
  /** Distinct playerCount values, ascending. */
  sizes: number[];
  /** Distinct player names (display spelling), capped — see FACET_PLAYERS_MAX. */
  players: string[];
  /** Distinct settings flags present on some row. */
  settings: string[];
  /** Oldest and newest start time in the catalog, for the date inputs. */
  from: number | null;
  to: number | null;
}

/** FACET_PLAYERS_MAX bounds the name list a facets reply carries. The names
 * are only completions — the filter itself matches server-side against the
 * full index — so truncating the list costs discoverability, never results. */
export const FACET_PLAYERS_MAX = 2000;

// Guardrails for the settings object: it is stored verbatim (a JSON column),
// so cap how much an uploader can stuff into it.
const SETTINGS_MAX_KEYS = 32;
const SETTINGS_MAX_JSON = 2048;

/** sanitizeEntry validates a PUT /api/replays/<id> body into a ReplayEntry,
 * or returns a string describing why it is unacceptable. Unknown fields are
 * dropped, missing stats become null, and a field of the wrong type is
 * rejected rather than coerced. */
export function sanitizeEntry(id: string, body: unknown): ReplayEntry | string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return "invalid replay id";
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;

  let rid: string | null = null;
  if (b.rid !== undefined && b.rid !== null) {
    if (typeof b.rid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(b.rid)) return "invalid rid";
    rid = b.rid;
  }

  const nums: Record<string, number | null> = {};
  for (const k of ["startUnix", "durationSec", "sizeBytes"]) {
    const v = b[k];
    if (v === undefined || v === null) nums[k] = null;
    else if (typeof v !== "number" || !Number.isFinite(v)) return `${k} must be a finite number`;
    else nums[k] = v;
  }
  const strs: Record<string, string | null> = {};
  for (const [k, max] of [["map", 200], ["gameSize", 40]] as const) {
    const v = b[k];
    if (v === undefined || v === null) strs[k] = null;
    else if (typeof v !== "string") return `${k} must be a string`;
    else strs[k] = v.slice(0, max);
  }
  const widget = sanitizeWidget(b);
  if (typeof widget === "string") return widget;
  const settings = sanitizeSettings(b.settings);
  if (typeof settings === "string") return settings;
  const players = sanitizePlayers(b.players);
  if (typeof players === "string") return players;
  let uploaderAlly: number | null = null;
  if (b.uploaderAlly !== undefined && b.uploaderAlly !== null) {
    if (typeof b.uploaderAlly !== "number" || !Number.isInteger(b.uploaderAlly)) return "uploaderAlly must be an integer";
    uploaderAlly = b.uploaderAlly;
  }
  // The point of view of the capture BEING PUBLISHED, when the publisher knows
  // it: a live upload's stream names the ally its recorder played on, and the
  // re-sim publisher declares "full". Accepting it here is what spares a fresh
  // upload from having to be marked by hand — the alternative, refusing it so
  // only setView could write the column, threw away provenance the capture
  // carried. Omitting it still leaves any existing marking untouched (upsert
  // COALESCEs), so a publisher with nothing to say cannot wipe one.
  let view: ReplayEntry["view"] = null;
  if (b.view !== undefined && b.view !== null) {
    if (b.view !== "full" && b.view !== "ally" && b.view !== "unknown") {
      return `view must be one of "full", "ally", "unknown"`;
    }
    // "ally" is only meaningful alongside the side it names; a row carrying one
    // without the other is the contradiction the view column exists to prevent.
    if (b.view === "ally" && uploaderAlly === null) return `view "ally" requires uploaderAlly`;
    view = b.view;
  }
  return {
    id,
    rid,
    startUnix: nums.startUnix,
    durationSec: nums.durationSec,
    sizeBytes: nums.sizeBytes,
    map: strs.map,
    gameSize: strs.gameSize,
    settings,
    players,
    // Derived here rather than accepted, so every writer (publish PUT, admin
    // refresh, backfill) counts a game the same way.
    playerCount: derivePlayerCount(players, strs.gameSize),
    uploaderAlly,
    // Server-owned: the index accumulates this across PUTs (mergeUploads);
    // whatever a PUT body claims is ignored.
    uploads: null,
    view,
    widgetVersion: widget.version ?? null,
    widgetSha: widget.sha ?? null,
    widgetDate: widget.date ?? null,
    // Server-owned like `uploads`. A PUT is a PUBLISH, which is the one event
    // that ends both states, so there is nothing a body could mean by them:
    // upsert writes placeholder = 0 unconditionally, and `processing` is read
    // back from the jobs table, never written at all.
    placeholder: false,
    processing: false,
  };
}

/** Longest accepted widget version/date string. Both are short constants the
 * widget declares ("1.7.0", "2026-08-16"); the cap is only here so a
 * malformed publisher cannot grow a row. */
const WIDGET_FIELD_MAX = 40;

/** sanitizeWidget validates the widget-provenance trio off a PUT body.
 *
 * The SHA is shape-checked (hex, 7-64) rather than merely capped: it is the
 * one field meant to be compared against a git history, so a value that could
 * never match one is a bug worth rejecting at the door — and the widget itself
 * only ever emits a full 40-hex SHA or nothing at all. Version and date are
 * free-form, since they are whatever constants the widget was cut with. */
function sanitizeWidget(b: Record<string, unknown>): WidgetRef | string {
  const out: WidgetRef = {};
  for (const k of ["version", "date"] as const) {
    const v = b[k === "version" ? "widgetVersion" : "widgetDate"];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return `widget${k[0].toUpperCase()}${k.slice(1)} must be a string`;
    if (v !== "") out[k] = v.slice(0, WIDGET_FIELD_MAX);
  }
  const sha = b.widgetSha;
  if (sha !== undefined && sha !== null && sha !== "") {
    if (typeof sha !== "string") return "widgetSha must be a string";
    if (!/^[0-9a-f]{7,64}$/.test(sha)) return "widgetSha must be a lowercase hex git SHA";
    out.sha = sha;
  }
  return out;
}

/** derivePlayerCount totals a game's players with Gaia/scavengers excluded.
 *
 * The roster is the authority: catalogPlayers only groups allies that have
 * players, so summing its counts already drops the neutral team. gameSize is
 * the fallback for a row with no roster, and only a fallback — it is built
 * from the TEAM list, where a scavenger ally survives the Gaia rule (that team
 * carries a side/name), so an 8v8-with-scavengers reads "8v8v1" there while
 * its roster correctly totals 16. Null when neither source can answer. */
export function derivePlayerCount(
  players: CatalogTeam[] | null,
  gameSize: string | null,
): number | null {
  if (players !== null && players.length > 0) {
    let n = 0;
    for (const g of players) n += g.count;
    return n;
  }
  if (gameSize !== null && /^\d+(v\d+)*$/.test(gameSize)) {
    let n = 0;
    for (const part of gameSize.split("v")) n += Number(part);
    return n;
  }
  return null;
}

// Guardrails for the players roster (stored verbatim as a JSON column).
//
// CATALOG_PLAYERS_PER_ALLY is the roster cap, and it is a FILTER limit, not a
// display one: the list's "player was in the game" filter can only match names
// the row actually stores, so anyone trimmed here is unfindable. It was 5 —
// enough for the three names the list prints per side — which left every 8v8
// storing 5 of 8 players and a 25v25 storing 5 of 25. 32 covers the largest
// games BAR runs; the twin cap lives in viz.catalogPlayersPerAlly (Go) and the
// two must stay in lockstep.
export const CATALOG_PLAYERS_PER_ALLY = 32;
const PLAYERS_MAX_ALLIES = 16;
const PLAYERS_MAX_PER_ALLY = CATALOG_PLAYERS_PER_ALLY;
const PLAYERS_MAX_JSON = 32768;

// sanitizePlayers validates the players roster: an array of ally-team groups
// {ally, count, players: [{name, os?}]}, matching viz.BuildCatalogEntry's
// output. Returns the cleaned array, null when absent/empty, or an error
// string.
function sanitizePlayers(v: unknown): CatalogTeam[] | null | string {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return "players must be an array";
  if (v.length === 0) return null;
  if (v.length > PLAYERS_MAX_ALLIES) return `players must have at most ${PLAYERS_MAX_ALLIES} ally teams`;
  const out: CatalogTeam[] = [];
  for (const g of v) {
    if (typeof g !== "object" || g === null || Array.isArray(g)) return "players entries must be objects";
    const { ally, count, players } = g as Record<string, unknown>;
    if (typeof ally !== "number" || !Number.isInteger(ally)) return "players[].ally must be an integer";
    if (typeof count !== "number" || !Number.isInteger(count)) return "players[].count must be an integer";
    if (!Array.isArray(players) || players.length > PLAYERS_MAX_PER_ALLY) {
      return `players[].players must be an array of at most ${PLAYERS_MAX_PER_ALLY}`;
    }
    const ps: CatalogTeam["players"] = [];
    for (const p of players) {
      if (typeof p !== "object" || p === null) return "players[].players entries must be objects";
      const { name, os } = p as Record<string, unknown>;
      if (typeof name !== "string" || name === "") return "player name must be a non-empty string";
      if (os !== undefined && (typeof os !== "number" || !Number.isFinite(os))) return "player os must be a finite number";
      ps.push(os === undefined ? { name: name.slice(0, 64) } : { name: name.slice(0, 64), os });
    }
    out.push({ ally, count, players: ps });
  }
  if (JSON.stringify(out).length > PLAYERS_MAX_JSON) return `players must serialize to at most ${PLAYERS_MAX_JSON} bytes`;
  return out;
}

/** The flag settingsFlags emits for a game that ran with any tweakdefs or
 * tweakunits slot set. Named because it is not only a badge: the re-sim
 * backfill (ReplayIndex.jobsOffer) RANKS a game carrying it first, and that
 * ranking is a string match in SQL — renaming the flag here without the query
 * would silently stop preferring modded games rather than break anything. The
 * Go twin viz.SettingsFlags emits the same literal.
 *
 * It used to be a refusal, on the grounds that an hour of engine time was
 * better spent elsewhere. It is the other way round: a modded game — which is
 * also how the modes that ship as tweak blobs, lava and zombies, show up — is
 * the one nobody has another way to look at. */
export const SETTINGS_MODS_FLAG = "mods";

/** settingsFlags distills a game's raw modoptions map (string-valued, as the
 * BAR API's gameSettings serves it) into the catalog's settings object — the
 * TypeScript twin of viz.SettingsFlags in internal/viz/catalog.go, used by
 * the admin settings-refresh route; the two MUST stay in lockstep. Only
 * true / non-default values are emitted; null when nothing notable is set. */
export function settingsFlags(mo: Record<string, string>): Record<string, boolean | string> | null {
  const out: Record<string, boolean | string> = {};
  const on = (key: string, name: string) => {
    if (mo[key] === "1") out[name] = true;
  };
  on("ranked_game", "ranked");
  // The one "off is the news" flag: an explicitly unranked lobby gets its
  // own badge (absent key = unknown).
  if (mo["ranked_game"] === "0") out["unranked"] = true;
  on("map_waterislava", "lava");
  on("scavunitsforplayers", "scavUnits");
  on("experimentalextraunits", "extraUnits");
  on("unit_restrictions_nonukes", "noNukes");
  on("unit_restrictions_noendgamelrpc", "noEndgameLrpc");
  on("unit_restrictions_nolrpc", "noLrpc");
  on("unit_restrictions_noair", "noAir");

  // Any tweak slot set at all means the game ran modded unit/def tables.
  for (const base of ["tweakdefs", "tweakunits"]) {
    for (let i = 0; i <= 9 && out[SETTINGS_MODS_FLAG] === undefined; i++) {
      if (mo[i === 0 ? base : base + i]) out[SETTINGS_MODS_FLAG] = true;
    }
  }

  // Enum-valued options: notable unless off/default.
  const qs = mo["quick_start"];
  if (qs && qs !== "default" && qs !== "disabled") out["quickStart"] = qs;
  const cb = mo["commanderbuildersenabled"];
  if (cb && cb !== "disabled") out["comBuilders"] = cb;
  // zombies defaults to "disabled"; "normal" is the plain on-state (badge
  // alone), the harder tiers (hard/nightmare/akumu) keep their name.
  const z = mo["zombies"];
  if (z && z !== "disabled") out["zombies"] = z === "normal" ? true : z;
  // ruins defaults to "scav_only" (present only in Scavengers games), so
  // only an explicit "enabled" is notable.
  if (mo["ruins"] === "enabled") out["ruins"] = true;

  return Object.keys(out).length === 0 ? null : out;
}

/** playersFromApi rebuilds the catalog's players column from the BAR API's
 * replay-detail AllyTeams array (its stored copy of the demo's roster) — the
 * admin refresh route's counterpart to viz.BuildCatalogEntry's .brp-derived
 * roster: same shape, same CATALOG_PLAYERS_PER_ALLY cap. Human players sort
 * best-OS-first; AI slots (Raptors, BARb bots — no rating) follow after.
 * Null when the reply names nobody.
 *
 * This route is also how rows published under the old cap of 5 get their full
 * roster back — the API keeps the demo's whole AllyTeams list, so a refresh
 * re-derives every name without repacking or re-uploading anything. */
export function playersFromApi(allyTeams: unknown): CatalogTeam[] | null {
  if (!Array.isArray(allyTeams)) return null;
  const groups: CatalogTeam[] = [];
  for (const at of allyTeams) {
    if (typeof at !== "object" || at === null) continue;
    const a = at as Record<string, unknown>;
    if (typeof a.allyTeamId !== "number" || !Number.isInteger(a.allyTeamId)) continue;
    const ps: CatalogTeam["players"] = [];
    for (const p of Array.isArray(a.Players) ? a.Players : []) {
      const name = (p as Record<string, unknown>)?.name;
      if (typeof name !== "string" || name === "") continue;
      const os = parseSkill((p as Record<string, unknown>).skill);
      ps.push(os === null ? { name } : { name, os });
    }
    ps.sort((x, y) => (y.os ?? -Infinity) - (x.os ?? -Infinity));
    for (const b of Array.isArray(a.AIs) ? a.AIs : []) {
      const bot = b as Record<string, unknown>;
      const name = typeof bot?.shortName === "string" && bot.shortName ? bot.shortName : bot?.name;
      if (typeof name === "string" && name !== "") ps.push({ name });
    }
    if (ps.length === 0) continue;
    groups.push({ ally: a.allyTeamId, count: ps.length, players: ps.slice(0, CATALOG_PLAYERS_PER_ALLY) });
  }
  groups.sort((x, y) => x.ally - y.ally);
  return groups.length ? groups : null;
}

// parseSkill reads the API's OpenSkill value: a bracketed string like
// "[16.67]" (the demo startscript form) or occasionally a plain number.
function parseSkill(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = parseFloat(v.replace(/[[\]]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** mergeUploads folds one PUT's revision into a row's accumulated uploads
 * list: appends {rid, ally} when the rid is new, refreshes the recorded ally
 * when the same rid is re-published with one (identical bytes always land on
 * the same rid, so re-publishing is idempotent). Order stays oldest-first. */
/** parseViewRequest validates a POST /api/replays/:id/view body. Returns the
 * marking, or an error string. "ally" requires a non-negative integer ally id;
 * any other view must not carry one, so a marking can never leave a stale team
 * behind. */
export function parseViewRequest(
  b: unknown,
): { view: "full" | "ally" | "unknown"; ally: number | null } | string {
  if (typeof b !== "object" || b === null) return "body must be a JSON object";
  const o = b as Record<string, unknown>;
  if (o.view !== "full" && o.view !== "ally" && o.view !== "unknown") {
    return `view must be one of "full", "ally", "unknown"`;
  }
  if (o.view !== "ally") {
    return { view: o.view, ally: null };
  }
  if (typeof o.ally !== "number" || !Number.isInteger(o.ally) || o.ally < 0) {
    return "ally must be a non-negative integer when view is \"ally\"";
  }
  return { view: "ally", ally: o.ally };
}

/** wantsFullView: is this game one somebody recorded from INSIDE, with no
 * full-view revision published for it yet? Which is to say: is a
 * re-simulation the thing that would improve it?
 *
 * A one-sided capture only ever saw its own side — the widget records what its
 * client could see — so the game has a fog of war in it that no upload can
 * lift; re-simulating the demo headlessly produces the spectator's view of the
 * same game and publishes it as another revision. This is the predicate that
 * decides when that is worth an hour of somebody's engine time, and it is
 * asked at the moment a publish makes it true (ReplayIndex.upsert), which is
 * the only moment it CAN become true.
 *
 * It reads the uploads list rather than the row's uploader_ally alone, because
 * the list is the durable record: a later provenance-less re-publish nulls the
 * column (upsert overwrites it) while mergeUploads keeps what every revision
 * was. `ally: null` in the list is a full view — a spectator's upload or a
 * re-sim's — and one of those is enough to say the game is covered.
 *
 * It used to be `needsResim` in cmd/bringest, applied to every row of the
 * catalog on a timer, which is how the daemon found this work; the answer is
 * the same, it is just no longer hunted for. */
export function wantsFullView(uploaderAlly: number | null, uploads: UploadRef[] | null): boolean {
  const list = uploads ?? [];
  // Something has to SAY the game was recorded from a playing client. A row
  // that knows nothing about its own provenance — most of them, from before
  // the recorder record existed — is not a candidate: "unknown" is not "ally".
  if (uploaderAlly === null && !list.some((u) => u.ally !== null)) return false;
  return list.every((u) => u.ally !== null);
}

export function mergeUploads(
  existing: UploadRef[] | null,
  rid: string | null,
  ally: number | null,
  widget?: WidgetRef | null,
): UploadRef[] | null {
  if (rid === null) return existing;
  // Only carry a widget that says something, so an entry never grows an empty
  // object, and a re-publish that knows nothing cannot blank one that did.
  const w = widget && (widget.version || widget.sha || widget.date) ? widget : undefined;
  const prior = existing ?? [];
  const out = prior.map((u) => {
    if (u.rid !== rid) return u;
    // Same rid re-published (identical bytes always land on the same one): let
    // it refresh what it knows, keep what it doesn't.
    const merged: UploadRef = { rid: u.rid, ally: ally ?? u.ally };
    const keep = w ?? u.widget;
    if (keep) merged.widget = keep;
    return merged;
  });
  if (!prior.some((u) => u.rid === rid)) out.push(w ? { rid, ally, widget: w } : { rid, ally });
  return out;
}

// sanitizeSettings validates the settings object: a flat map of boolean/short
// string values (matching what viz.SettingsFlags emits), size-capped. Returns
// the cleaned object, null when absent, or an error string.
function sanitizeSettings(v: unknown): Record<string, boolean | string> | null | string {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return "settings must be a JSON object";
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return null;
  if (entries.length > SETTINGS_MAX_KEYS) return `settings must have at most ${SETTINGS_MAX_KEYS} keys`;
  const out: Record<string, boolean | string> = {};
  for (const [k, val] of entries) {
    if (typeof val !== "boolean" && typeof val !== "string") {
      return `settings.${k} must be a boolean or string`;
    }
    out[k] = val;
  }
  if (JSON.stringify(out).length > SETTINGS_MAX_JSON) return `settings must serialize to at most ${SETTINGS_MAX_JSON} bytes`;
  return out;
}
