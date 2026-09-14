// The lava sync: hand freshly-finished candidate games to the sibling
// lavabalance worker (the LOS OpenSkill ratings for the lava game mode),
// which ingests a game as the VERBATIM api.bar-rts.com/replays/<id> detail
// POSTed to its open /api/games.
//
// WHAT BARREPLAY REMEMBERS is which games it has already offered, one mark per
// game (ReplayIndex.gamesLavaPending / lavaMarkOffered). A run works through the
// oldest-started candidates nobody has offered yet in batches of
// MAX_LAVA_BATCH, marking each batch once lavabalance has answered for it and
// carrying on until the queue is empty or MAX_LAVA_RUN is reached. A batch that
// throws marks nothing, so the next run re-offers it and a crash costs nothing;
// re-submission is absorbed on the other side, which answers "duplicate" for
// games it holds.
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

/** Games per POST, and per marking call. The batch is the unit of PROGRESS: it
 * is marked before the next one is fetched, so a run that dies in batch four
 * keeps batches one to three. That is what makes the loop in syncLava safe to
 * write at all. */
export const MAX_LAVA_BATCH = 20;

/** Ceiling on games ONE RUN will take, over as many batches as that needs.
 *
 * NOT a subrequest bound. MAX_LAVA_BATCH used to be described as one — "keeps
 * one cron invocation's subrequest count bounded" — which was reasoning from
 * the FREE plan's 50 per invocation. This Worker is on Workers Paid, where the
 * limit is 10,000, and 200 details plus ten service-binding POSTs is 210. The
 * ceiling is here for the two limits that are real at this size: api.bar-rts.com,
 * a community API this asks for one detail per game and whose goodwill is worth
 * more than a fast backfill (the politeness here is structural — no backoff
 * anywhere, just concurrency 4 and fetch-each-game-once), and the cron's
 * envelope (30s CPU under an hourly interval, 15min wall). At concurrency 4 a
 * full 200 is ~10-15s of mostly waiting, which fits both with room to spare.
 *
 * What it costs to be wrong in either direction: too high is a burst at
 * somebody else's API after a long outage, too low is the trickle this replaced
 * — a backlog arriving one batch per cron tick over a night. */
export const MAX_LAVA_RUN = 200;

/** How many BAR detail fetches run at once (matches the games sync's). */
const DETAIL_CONCURRENCY = 4;

/** Per-request deadline on a BAR detail fetch, matching teiserver.ts's.
 * Nothing used to time these out, which was survivable while a run was one
 * batch: a hung fetch rode the invocation's wall clock and the cron moved on a
 * minute later. A ten-batch run makes that long enough to overlap later ticks,
 * so each fetch now has a deadline — and a timed-out game needs no special
 * handling, since an unfetched candidate is simply one this run does not mark. */
const DETAIL_TIMEOUT_MS = 8000;

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
  /** Unoffered candidates this run took, across every batch (≤ MAX_LAVA_RUN). */
  candidates: number;
  /** Of those, ones whose detail loaded and that were POSTed. */
  submitted: number;
  /** Candidates whose BAR detail did not load, so they stay pending. */
  failed: number;
  /** Why the first of those failed, or null. Reported because the alternative
   * is what this whole design is a reaction to: a sync that was not working and
   * said nothing. "timed out" and "502" call for different follow-up. */
  failure: string | null;
  /** Batches it took to do that — one POST each. */
  batches: number;
  /** True when work was still waiting when the run stopped: the ceiling was
   * reached, or the queue would not shrink. False means the queue is EMPTY,
   * which is the normal end of a run and the thing worth being able to say —
   * the stall this design replaced was invisible precisely because nothing
   * counted what was left. */
  more: boolean;
  /** lavabalance's verdicts for the batch, verbatim counts. */
  rated: number;
  ignored: number;
  skipped: number;
  duplicate: number;
  rejected: number;
}

/** syncLava runs one pass, draining the pending queue a batch at a time until it
 * is empty or MAX_LAVA_RUN is reached.
 *
 * It loops because there is no longer a reason to stop after one batch: each is
 * MARKED before the next is read, so the queue actually shrinks and progress is
 * kept whatever happens next. The single-batch version left a backlog arriving
 * one batch per cron tick — hours, for what is seconds of work.
 *
 * Throws when lavabalance is unreachable. Batches already marked stay marked, so
 * a throw mid-drain costs only the rest of this run; a single game's BAR detail
 * failing is skipped, not thrown, and stays pending for a later run. */
export async function syncLava(
  index: LavaSyncIndex,
  lavaFetch: typeof fetch,
  barFetch: typeof fetch = fetch,
): Promise<LavaSyncResult> {
  const out: LavaSyncResult = {
    candidates: 0, submitted: 0, failed: 0, failure: null, batches: 0, more: false,
    rated: 0, ignored: 0, skipped: 0, duplicate: 0, rejected: 0,
  };
  // Everything this run has taken. Only used by the no-progress guard below —
  // re-offering a game is harmless ("duplicate"), looping on one is not.
  const taken = new Set<string>();

  while (out.candidates < MAX_LAVA_RUN) {
    // 1. A batch of never-offered candidates, plus one row to tell a full batch
    // from the last one. Oldest-STARTED first: lavabalance folds ratings forward
    // from a (startTime, id) head and stores anything behind it unranked for
    // good, so start order is the order it wants. Enforced here rather than
    // assumed of the query — the submission order is this module's contract.
    const room = Math.min(MAX_LAVA_BATCH, MAX_LAVA_RUN - out.candidates);
    const queue = await index.gamesLavaPending(room + 1);
    out.more = queue.length > room;
    const candidates = [...queue]
      .sort((a, b) => a.startUnix - b.startUnix || (a.id < b.id ? -1 : 1))
      .slice(0, room);
    if (candidates.length === 0) break; // drained; `more` is false by construction

    // The loop's premise is that marking shrinks the queue. If a batch comes
    // back entirely already-taken, it did not — a mark that wrote nothing, a
    // concurrent run, a predicate that no longer matches what was marked — and
    // continuing would re-fetch the same games until the ceiling. Stop instead,
    // saying work is still waiting.
    if (candidates.every((c) => taken.has(c.id))) {
      out.more = true;
      break;
    }
    for (const c of candidates) taken.add(c.id);
    out.candidates += candidates.length;

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
        const detail = await fetchDetail(barFetch, c.id);
        details[i] =
          c.lobbyName === null && c.lobbyDetails === null
            ? detail
            : { ...(detail as Record<string, unknown>), lobbyName: c.lobbyName, lobbyDetails: c.lobbyDetails };
        ids[i] = c.id;
      } catch (err) {
        // Left unmarked, so it is still pending and a later run retries it.
        out.failed += 1;
        out.failure ??= err instanceof Error ? err.message : String(err);
      }
    });
    const batch = details.filter((d) => d !== undefined);
    // Every detail failed — BAR is having a bad minute. Nothing to POST and
    // nothing to mark, so the guard above would end the next pass anyway; stop
    // here and let a later run retry, rather than hammer on through the ceiling.
    if (batch.length === 0) {
      out.more = true;
      break;
    }

    // 3. One POST for the batch (lavabalance orders it internally too).
    const result = (await fetchJSON(lavaFetch, `${LAVA_BASE}/api/games`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
    })) as Record<string, unknown>;

    // 4. Mark what was answered — AFTER the POST, so a throw above leaves this
    // batch pending, and BEFORE the next read, so the queue shrinks. The
    // verdicts are not consulted: classification is deterministic, so a reject
    // stays a reject, and the one thing that can change (lobby info landing
    // late) clears the mark from the other side, in ReplayIndex.lobbiesMatch.
    await index.lavaMarkOffered(ids.filter((id): id is string => id !== undefined));

    const n = (k: string) => (Array.isArray(result[k]) ? (result[k] as unknown[]).length : 0);
    out.submitted += batch.length;
    out.batches += 1;
    out.rated += n("rated");
    out.ignored += n("ignored");
    out.skipped += n("skipped");
    out.duplicate += n("duplicate");
    out.rejected += n("rejected");

    // A short batch was the end of the queue: stop without spending a read to
    // be told so.
    if (!out.more) break;
  }
  return out;
}

/** One game's verbatim BAR detail, under DETAIL_TIMEOUT_MS. The deadline is the
 * only reason this is not a bare fetchJSON: a hung upstream must not hold a
 * multi-batch run open across cron ticks. */
async function fetchDetail(barFetch: typeof fetch, id: string): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DETAIL_TIMEOUT_MS);
  try {
    return await fetchJSON(barFetch, `https://api.bar-rts.com/replays/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    });
  } catch (err) {
    // The raw AbortError says only "aborted"; name the deadline, since a
    // timed-out BAR and a broken BAR call for different follow-up.
    throw new Error(
      timedOut
        ? `lava sync: detail ${id} timed out after ${DETAIL_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
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
