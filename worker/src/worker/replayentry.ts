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
  return {
    id,
    rid,
    startUnix: nums.startUnix,
    durationSec: nums.durationSec,
    sizeBytes: nums.sizeBytes,
    map: strs.map,
    gameSize: strs.gameSize,
    settings,
  };
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
