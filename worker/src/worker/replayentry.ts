// The replay catalog's row shape and PUT-body validation. Kept free of any
// workerd import so the node-side tests (tsx --test) and the upload tooling
// can use it directly; the Durable Object in replayindex.ts builds on it.

/** One catalog row, as served by GET /api/replays. Stats are best-effort —
 * an uploader that doesn't know a field sends null and the UI shows a dash. */
export interface ReplayEntry {
  id: string;
  /** Unix seconds when the game started (demo header UnixTime). */
  startUnix: number | null;
  /** Game length in seconds (sampled range of the capture). */
  durationSec: number | null;
  map: string | null;
  /** Team-size spec, e.g. "8v8", "1v1", "2v2v2". */
  gameSize: string | null;
  /** Download footprint of the replay's static files in bytes. */
  sizeBytes: number | null;
}

/** sanitizeEntry validates a PUT /api/replays/<id> body into a ReplayEntry,
 * or returns a string describing why it is unacceptable. Unknown fields are
 * dropped, missing stats become null, and a field of the wrong type is
 * rejected rather than coerced. */
export function sanitizeEntry(id: string, body: unknown): ReplayEntry | string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return "invalid replay id";
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;

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
  return {
    id,
    startUnix: nums.startUnix,
    durationSec: nums.durationSec,
    sizeBytes: nums.sizeBytes,
    map: strs.map,
    gameSize: strs.gameSize,
  };
}
