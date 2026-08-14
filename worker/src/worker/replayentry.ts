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
  /** Roster for the landing list: one group per ally team (ascending ally
   * id), each carrying the ally's top players by OpenSkill ("os") with count
   * keeping the ally's true size (viz.BuildCatalogEntry caps the slice). */
  players: CatalogTeam[] | null;
  /** Ally team of the client that recorded the capture behind the current
   * revision — which side's point of view the replay shows. Null for engine
   * re-sim captures and spectator recordings (they see the whole game). */
  uploaderAlly: number | null;
  /** Every revision ever published for this game with the side that recorded
   * it, oldest first. Server-owned: accumulated across PUTs (mergeUploads),
   * never accepted from a PUT body. Superseded revisions stay servable, so
   * each entry keeps playing at ?replay=<rid>. */
  uploads: UploadRef[] | null;
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
}

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
  const settings = sanitizeSettings(b.settings);
  if (typeof settings === "string") return settings;
  const players = sanitizePlayers(b.players);
  if (typeof players === "string") return players;
  let uploaderAlly: number | null = null;
  if (b.uploaderAlly !== undefined && b.uploaderAlly !== null) {
    if (typeof b.uploaderAlly !== "number" || !Number.isInteger(b.uploaderAlly)) return "uploaderAlly must be an integer";
    uploaderAlly = b.uploaderAlly;
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
    uploaderAlly,
    // Server-owned: the index accumulates this across PUTs (mergeUploads);
    // whatever a PUT body claims is ignored.
    uploads: null,
  };
}

// Guardrails for the players roster (stored verbatim as a JSON column).
const PLAYERS_MAX_ALLIES = 16;
const PLAYERS_MAX_PER_ALLY = 8;
const PLAYERS_MAX_JSON = 8192;

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
    for (let i = 0; i <= 9 && out["mods"] === undefined; i++) {
      if (mo[i === 0 ? base : base + i]) out["mods"] = true;
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

/** mergeUploads folds one PUT's revision into a row's accumulated uploads
 * list: appends {rid, ally} when the rid is new, refreshes the recorded ally
 * when the same rid is re-published with one (identical bytes always land on
 * the same rid, so re-publishing is idempotent). Order stays oldest-first. */
export function mergeUploads(existing: UploadRef[] | null, rid: string | null, ally: number | null): UploadRef[] | null {
  if (rid === null) return existing;
  const prior = existing ?? [];
  const out = prior.map((u) => (u.rid === rid && ally !== null ? { rid: u.rid, ally } : u));
  if (!prior.some((u) => u.rid === rid)) out.push({ rid, ally });
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
