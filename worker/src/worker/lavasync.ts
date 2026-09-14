// The lava sync: hand freshly-finished candidate games to the sibling
// lavabalance worker (the LOS OpenSkill ratings for the lava game mode),
// which ingests a game as the VERBATIM api.bar-rts.com/replays/<id> detail
// POSTed to its open /api/games.
//
// WHAT BARREPLAY REMEMBERS is which games it has already offered, one mark per
// game (ReplayIndex.gamesLavaPending / lavaMarkOffered). Each run takes the
// oldest-started candidates nobody has offered yet, submits them, and marks
// them once lavabalance has answered. A run that throws marks nothing, so the
// next one re-offers the lot and a crash still costs nothing; re-submission is
// absorbed on the other side, which answers "duplicate" for games it holds.
//
// It used to keep NO state and derive the queue from lavabalance instead: ask
// for the newest game in ITS listing, take that game's end as a watermark,
// offer everything the mirror holds that ended at or after it. The flaw took
// three days to show and never recovered on its own. lavabalance stores only
// what its classifier accepts, so every game it declined stayed ahead of the
// watermark and came back next run — and when a night of zombie and
// noob-friendly lobbies left 33 such games in front of the queue, with
// MAX_LAVA_BATCH at 20, the sync re-offered the same 20 rejects hourly from
// 2026-09-11 to 09-14 and never reached the 72 real lava games behind them.
// Nothing logged an error, because nothing had failed. A queue whose head can
// be held by work the consumer refuses must be drained by the producer, so the
// producer now keeps the tally.
//
// CANDIDATES are the mirror's LAVA-SHAPED games: the `lava` flag
// (map_waterislava) on an 8v8 roster — the two facts lavabalance requires of
// every game it stores. It stays the authority on what a lava game IS, since
// the mode ships as tweakdefs and only its classifier reads those; but handing
// it every MODDED game on the theory that mods are rare (~0 in 24) was measured
// wrong — 405 in three days — and those rejects are what jammed the queue.
//
// Like games.ts, no `cloudflare:workers` import anywhere: the lavabalance
// side is an injected fetch (the cron passes the service binding's), so the
// node tests drive the whole sync against fakes.

import type { LobbyDetails } from "./teiserver";

/** Cap on games submitted per run. Keeps one cron invocation's subrequest
 * count bounded (a detail fetch each); anything past the cap is picked up by
 * the next run, which now finds it simply because this run marked what it
 * took — or by the hourly sweep. */
export const MAX_LAVA_BATCH = 20;

/** How many BAR detail fetches run at once (matches the games sync's). */
const DETAIL_CONCURRENCY = 4;

/** The service-binding host is arbitrary; the path is what routes. */
const LAVA_BASE = "https://lavabalance";

/** One candidate row: the game, when it started and ended, and the lobby info
 * the teiserver poll matched onto it (null when it never was), which rides the
 * submission so lavabalance learns the parties the players queued in.
 * `startUnix` is the submission order (see syncLava); `endUnix` is what the
 * pending query's horizon is measured on. */
export interface LavaCandidate {
  id: string;
  startUnix: number;
  endUnix: number;
  lobbyName: string | null;
  lobbyDetails: LobbyDetails | null;
}

/** What the sync needs of the ReplayIndex Durable Object: the pending queue,
 * and the mark that takes a game out of it. */
export interface LavaSyncIndex {
  gamesLavaPending(limit: number): LavaCandidate[] | Promise<LavaCandidate[]>;
  lavaMarkOffered(ids: string[]): number | Promise<number>;
}

/** What one run did, for the cron's log line. */
export interface LavaSyncResult {
  /** Unoffered candidates this run took (capped at MAX_LAVA_BATCH). */
  candidates: number;
  /** Of those, ones whose detail loaded and that were POSTed. */
  submitted: number;
  /** True when the queue still held candidates past this run's cap — a backlog
   * draining, which is worth a log line: the stall this design replaced was
   * invisible precisely because nothing counted what was waiting. */
  more: boolean;
  /** lavabalance's verdicts for the batch, verbatim counts. */
  rated: number;
  ignored: number;
  skipped: number;
  duplicate: number;
  rejected: number;
}

/** syncLava runs one pass. Throws when lavabalance is unreachable — the caller
 * logs and a later run retries, with nothing marked so nothing is lost; a
 * single game's BAR detail failing is skipped, not thrown, and stays pending. */
export async function syncLava(
  index: LavaSyncIndex,
  lavaFetch: typeof fetch,
  barFetch: typeof fetch = fetch,
): Promise<LavaSyncResult> {
  const zero: LavaSyncResult = {
    candidates: 0, submitted: 0, more: false,
    rated: 0, ignored: 0, skipped: 0, duplicate: 0, rejected: 0,
  };

  // 1. One batch of never-offered candidates, plus one row to see whether a
  // backlog is draining behind it. Oldest-STARTED first: lavabalance folds
  // ratings forward from a (startTime, id) head and stores anything behind it
  // unranked for good, so start order is the order it wants. Enforced here
  // rather than assumed of the query — the submission order is this module's
  // contract.
  const queue = await index.gamesLavaPending(MAX_LAVA_BATCH + 1);
  const more = queue.length > MAX_LAVA_BATCH;
  const candidates = [...queue]
    .sort((a, b) => a.startUnix - b.startUnix || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_LAVA_BATCH);
  if (candidates.length === 0) return zero;

  // 2. The verbatim detail per candidate — lavabalance classifies from the
  // raw gameSettings, so nothing less than the API's own reply will do. The
  // matched lobby info rides as EXTRA top-level fields on the detail object
  // (the BAR API reply carries no lobbyName/lobbyDetails keys, so nothing
  // collides): parties are lobby-only knowledge the raw detail cannot carry.
  // A game with no matched lobby submits the plain detail, exactly as before.
  const details: unknown[] = new Array(candidates.length);
  const ids: (string | undefined)[] = new Array(candidates.length);
  await pool(candidates, DETAIL_CONCURRENCY, async (c, i) => {
    try {
      const detail = await fetchJSON(barFetch, `https://api.bar-rts.com/replays/${encodeURIComponent(c.id)}`);
      details[i] =
        c.lobbyName === null && c.lobbyDetails === null
          ? detail
          : { ...(detail as Record<string, unknown>), lobbyName: c.lobbyName, lobbyDetails: c.lobbyDetails };
      ids[i] = c.id;
    } catch {
      // Left unmarked, so it is still pending and a later run retries it.
    }
  });
  const batch = details.filter((d) => d !== undefined);
  if (batch.length === 0) return { ...zero, candidates: candidates.length, more };

  // 3. One POST for the whole batch (lavabalance orders it internally too).
  const result = (await fetchJSON(lavaFetch, `${LAVA_BASE}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(batch),
  })) as Record<string, unknown>;

  // 4. Mark what was answered — AFTER the POST, so a throw above leaves every
  // game pending. The verdicts are not consulted: classification is
  // deterministic, so a reject stays a reject, and the one thing that can
  // change (lobby info landing late) clears the mark from the other side, in
  // ReplayIndex.lobbiesMatch.
  await index.lavaMarkOffered(ids.filter((id): id is string => id !== undefined));

  const n = (k: string) => (Array.isArray(result[k]) ? (result[k] as unknown[]).length : 0);
  return {
    candidates: candidates.length,
    submitted: batch.length,
    more,
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
