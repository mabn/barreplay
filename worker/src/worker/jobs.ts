// The ingest job contract: what a job IS, shared by the Durable Object that
// stores jobs (replayindex.ts) and the routes that hand them out (app.ts).
//
// It lives in its own module because app.ts must stay free of any
// `cloudflare:workers` import in its module graph — that is what lets the
// node-side tests drive the real routes — and replayindex.ts, which is the
// natural home for this, imports the DurableObject base class. A `import type`
// would erase, but JOB_KINDS is a value the route validates against.

/** What kind of work a job is, which decides WHICH daemon serves it:
 * "upload" hands an archived .brepstream to a plain `bringest` (no engine
 * needed), "resim" hands a bare gameId to `bringest -resim`, which downloads
 * the demo and re-simulates it headlessly. The states below describe both
 * equally well — what differs is the work, not the progress — so this is a
 * kind, not a fifth state. */
export type JobKind = "upload" | "resim";

export const JOB_KINDS: readonly JobKind[] = ["upload", "resim"];

export const JOB_STATES = ["pending", "processing", "done", "error"] as const;

/** One job's trip through the ingest pipeline: a drag&drop upload, or a
 * re-simulation requested by pasting a replay link. */
export interface IngestJob {
  id: string;
  /** R2 key of the archived raw stream (streams/<gameId>/<ts>-<who>.brepstream).
   * Empty for a "resim" job, which has no uploaded stream — the demo it works
   * from is fetched from the BAR API by the daemon. */
  streamKey: string;
  gameId: string;
  kind: JobKind;
  state: (typeof JOB_STATES)[number];
  /** Failure detail when state is "error". */
  error: string | null;
  /** What the work cost, reported by the daemon with its terminal state — see
   * JobStats. Null until then (and for a job that predates the column). */
  stats: JobStats | null;
  createdUnix: number;
  updatedUnix: number;
}

/** One job's processing record, written by cmd/bringest (its jobStats struct
 * is the other half of this contract) and shown by the queue page: the
 * headline duration in the table, the rest expanded on click.
 *
 * Stored as ONE JSON column rather than a column per number. Nothing queries
 * these — they are read, not filtered on — and the two kinds of job barely
 * overlap: an upload records what packing and uploading cost, a re-sim adds
 * most of an hour of engine time and what the engine's own log said about it.
 * Every field is optional, because a daemon older than any of them simply
 * sends less, and a failed job sends only what it got as far as measuring. */
export interface JobStats {
  /** Whole job, claim to report. */
  tookSec?: number;
  packSec?: number;
  uploadSec?: number;
  brpBytes?: number;
  /** Re-sim only: engine wall time, and its load/sim split. */
  resimSec?: number;
  loadSec?: number;
  simSec?: number;
  /** Newest sim frame captured, frames written, and how much faster than
   * realtime the simulation ran. */
  frames?: number;
  samples?: number;
  speedUp?: number;
  /** The demo's own length in seconds — what `frames` falls short of when a
   * run is cut off. */
  gameSec?: number;
  engineVersion?: string;
  infolog?: {
    bytes?: number;
    lines?: number;
    lastFrame?: number;
    /** The one that matters: a re-simulation that desynced describes a game
     * that never happened, and looks perfectly normal on disk. */
    desyncs?: number;
    warnings?: number;
  };
  /** packer.ReportStats' output verbatim (the `pack -stats` breakdown). */
  sizeReport?: string;
}

/** Cap on the stored stats JSON. The real thing is 2-4 KB, nearly all of it
 * the size report; the cap only stops a pathological one from being written
 * into every read of the queue page. */
export const MAX_JOB_STATS_BYTES = 32 * 1024;

/** parseJobStats validates a stats object off the wire. It is deliberately
 * shallow — the fields are shown, never computed with, so an unknown or
 * oddly-typed one costs a line of the detail view and nothing else — but the
 * whole thing must be a plain object and must fit. Returns null for "no usable
 * stats", which callers treat as "do not touch what is stored". */
export function parseJobStats(v: unknown): JobStats | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const json = JSON.stringify(v);
  if (json === undefined || json.length > MAX_JOB_STATS_BYTES) return null;
  return v as JobStats;
}
