// The lava sync: hand freshly-finished candidate games to the sibling
// lavabalance worker (the LOS OpenSkill ratings for the lava game mode),
// which ingests a game as the VERBATIM api.bar-rts.com/replays/<id> detail
// POSTed to its open /api/games.
//
// STATELESS BY DESIGN: barreplay keeps no watermark of its own. Each run asks
// lavabalance for its most recent stored game (GET /api/games?limit=1 — its
// listing is newest-by-start-time), takes that game's END (start + duration)
// as the high-water mark, and submits every candidate the mirror holds that
// ended at or after it. So a run after lavabalance downtime simply finds a
// lower watermark and catches up, and a crashed run costs nothing — the next
// one re-derives everything. Re-submission is absorbed on the other side
// (lavabalance answers "duplicate" for stored games).
//
// CANDIDATES are the mirror's MODDED games (the SETTINGS_MODS_FLAG the sync
// already derives: any tweakdefs/tweakunits slot set). "Lava" to lavabalance
// means the tweak-modded game mode — NOT barreplay's `lava` flag, which is
// map_waterislava — and only its own classifier can tell lava tweaks from any
// other mod, so barreplay pre-filters to modded (rare: ~0 in 24 games) and
// lets lavabalance reject the rest. A rejected or eligibility-skipped game is
// NOT stored there, so it can stay ahead of the watermark and be re-offered
// by later runs until a rated lava game moves the mark past it — bounded by
// how often this runs, which is why the cron triggers it on fresh modded
// games plus one hourly sweep rather than every tick.
//
// Like games.ts, no `cloudflare:workers` import anywhere: the lavabalance
// side is an injected fetch (the cron passes the service binding's), so the
// node tests drive the whole sync against fakes.

import type { LobbyDetails } from "./teiserver";

/** Cap on games submitted per run. Keeps one cron invocation's subrequest
 * count bounded (a detail fetch each); anything past the cap is picked up by
 * the next run once the watermark advances — or by the hourly sweep. */
export const MAX_LAVA_BATCH = 20;

/** How many BAR detail fetches run at once (matches the games sync's). */
const DETAIL_CONCURRENCY = 4;

/** The service-binding host is arbitrary; the path is what routes. */
const LAVA_BASE = "https://lavabalance";

/** One candidate row: the game, when it ended, and the lobby info the
 * teiserver poll matched onto it (null when it never was), which rides the
 * submission so lavabalance learns the parties the players queued in. */
export interface LavaCandidate {
  id: string;
  endUnix: number;
  lobbyName: string | null;
  lobbyDetails: LobbyDetails | null;
}

/** What the sync needs of the ReplayIndex Durable Object. */
export interface LavaSyncIndex {
  gamesModdedEndedAfter(endUnix: number, limit: number): LavaCandidate[] | Promise<LavaCandidate[]>;
}

/** What one run did, for the cron's log line. */
export interface LavaSyncResult {
  /** The high-water mark used: end of lavabalance's most recent stored game
   * (0 = its fold is empty and everything qualifies). */
  watermarkEnd: number;
  /** Modded mirror games at/after the mark (the watermark game excluded). */
  candidates: number;
  /** Of those, ones whose detail loaded and that were POSTed. */
  submitted: number;
  /** lavabalance's verdicts for the batch, verbatim counts. */
  rated: number;
  ignored: number;
  skipped: number;
  duplicate: number;
  rejected: number;
}

/** syncLava runs one pass. Throws when lavabalance itself is unreachable
 * (either call) — the caller logs and a later run retries; a single game's
 * BAR detail failing is skipped, not thrown, and re-offered next run. */
export async function syncLava(
  index: LavaSyncIndex,
  lavaFetch: typeof fetch,
  barFetch: typeof fetch = fetch,
): Promise<LavaSyncResult> {
  // 1. The watermark: lavabalance's most recent stored game. Its listing is
  // ordered by START time; comparing our ends against its end can therefore
  // re-offer an already-stored longer game — a harmless "duplicate".
  const head = await fetchJSON(lavaFetch, `${LAVA_BASE}/api/games?limit=1`);
  const newest = Array.isArray((head as { games?: unknown[] })?.games)
    ? ((head as { games: Record<string, unknown>[] }).games[0] ?? null)
    : null;
  const newestStart = newest ? Date.parse(String(newest.startTime)) : NaN;
  const watermarkEnd = Number.isFinite(newestStart)
    ? Math.floor(newestStart / 1000) + Math.round(Number(newest!.durationMs ?? 0) / 1000)
    : 0;
  const watermarkId = newest ? String(newest.id) : null;

  const zero: LavaSyncResult = {
    watermarkEnd, candidates: 0, submitted: 0,
    rated: 0, ignored: 0, skipped: 0, duplicate: 0, rejected: 0,
  };

  // 2. Everything modded that finished at/after the mark, oldest-ended first
  // (>= not >, so a sibling that ended the same second as the watermark game
  // is not silently dropped; the watermark game itself is excluded by id).
  const candidates = (await index.gamesModdedEndedAfter(watermarkEnd, MAX_LAVA_BATCH + 1))
    .filter((c) => c.id !== watermarkId)
    // Finish order, enforced here rather than assumed of the index — the
    // submission order is this module's contract, not the query's.
    .sort((a, b) => a.endUnix - b.endUnix || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_LAVA_BATCH);
  if (candidates.length === 0) return zero;

  // 3. The verbatim detail per candidate — lavabalance classifies from the
  // raw gameSettings, so nothing less than the API's own reply will do. The
  // matched lobby info rides as EXTRA top-level fields on the detail object
  // (the BAR API reply carries no lobbyName/lobbyDetails keys, so nothing
  // collides): parties are lobby-only knowledge the raw detail cannot carry.
  // A game with no matched lobby submits the plain detail, exactly as before.
  const details: unknown[] = new Array(candidates.length);
  await pool(candidates, DETAIL_CONCURRENCY, async (c, i) => {
    try {
      const detail = await fetchJSON(barFetch, `https://api.bar-rts.com/replays/${encodeURIComponent(c.id)}`);
      details[i] =
        c.lobbyName === null && c.lobbyDetails === null
          ? detail
          : { ...(detail as Record<string, unknown>), lobbyName: c.lobbyName, lobbyDetails: c.lobbyDetails };
    } catch {
      // Skipped this run; still ahead of the watermark, so a later run retries.
    }
  });
  const batch = details.filter((d) => d !== undefined);
  if (batch.length === 0) return { ...zero, candidates: candidates.length };

  // 4. One POST for the whole batch (lavabalance orders it internally).
  const result = (await fetchJSON(lavaFetch, `${LAVA_BASE}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(batch),
  })) as Record<string, unknown>;
  const n = (k: string) => (Array.isArray(result[k]) ? (result[k] as unknown[]).length : 0);
  return {
    watermarkEnd,
    candidates: candidates.length,
    submitted: batch.length,
    rated: n("rated"),
    ignored: n("ignored"),
    skipped: n("skipped"),
    duplicate: n("duplicate"),
    rejected: n("rejected"),
  };
}

async function fetchJSON(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<unknown> {
  const r = await fetchImpl(url, init);
  if (!r.ok) throw new Error(`lava sync: ${r.status} for ${url}`);
  return await r.json();
}

async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
