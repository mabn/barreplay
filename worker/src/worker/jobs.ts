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
  /** What the work is DOING, as of the daemon's last healthcheck — see
   * JobProgress. Non-null only while the job is running. */
  progress: JobProgress | null;
  createdUnix: number;
  updatedUnix: number;
}

/** JobProgress is a running job's live self-report, refreshed by every
 * healthcheck the daemon sends (cmd/bringest, every 10 seconds) and dropped the
 * moment the job stops running.
 *
 * The opposite of JobStats in every way that matters, which is why it is a
 * separate column and a separate shape: stats say what the work COST and are
 * written once, at the end, and kept; this says what the work IS DOING, is
 * overwritten continuously, and is meaningless afterwards. It exists because a
 * re-sim is the better part of an hour during which a job row would otherwise
 * say nothing but "processing" — indistinguishable from a daemon that died.
 *
 * Every field is optional for the same reason JobStats' are: a phase with
 * nothing to measure reports only its name, and an older daemon reports less. */
export interface JobProgress {
  /** The phase in words: "fetching demo", "provisioning content", "starting
   * engine", "loading", "simulating", "packing", "uploading". The one field
   * that means something in every phase, including the ones with no numbers. */
  state?: string;
  /** Position in the simulation, in sim frames (30 per game-second) — 0 outside
   * the simulating phase, which is most of a run's first minutes. */
  frame?: number;
  totalFrames?: number;
  /** frame against totalFrames, 0-100. Progress through the SIMULATION, not
   * through the job: the demo download and the engine's load phase are minutes
   * of their own and sit at 0. */
  percent?: number;
  /** Seconds of wall time the daemon thinks the simulation still needs, from
   * the rate it has recently been running at. */
  etaSec?: number;
  /** That rate: sim frames per wall second (30 = realtime). */
  simFps?: number;
  /** The ENGINE process's resident memory. */
  rssBytes?: number;
  /** The engine's CPU use as a percentage of ONE core, so a busy multi-threaded
   * engine reports well over 100. This and rssBytes are the only window anyone
   * has onto the health of the machine actually doing the work — the daemon
   * runs on somebody's workstation, behind NAT, and nothing else here can see
   * it. */
  cpuPct?: number;
}

/** Cap on the stored progress JSON. It is a dozen small numbers; the cap only
 * exists so a malformed report cannot be written into every read of the queue
 * page, the same reason MAX_JOB_STATS_BYTES does. */
export const MAX_JOB_PROGRESS_BYTES = 2 * 1024;

/** parseJobProgress validates a live progress report off the wire. Shallow,
 * like parseJobStats and for the same reason — the fields are shown, never
 * computed with. Returns null for "no usable progress", which callers treat as
 * "do not touch what is stored": a beat that carries nothing must not blank a
 * reading a previous beat did carry. */
export function parseJobProgress(v: unknown): JobProgress | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const json = JSON.stringify(v);
  if (json === undefined || json.length > MAX_JOB_PROGRESS_BYTES) return null;
  return v as JobProgress;
}

/** JobSample is one healthcheck kept as HISTORY — the same reading JobProgress
 * carries, plus the moment the worker recorded it, stored as its own row in
 * job_samples rather than overwritten in place.
 *
 * The two are the same numbers answering different questions. `progress` on the
 * job row answers "what is it doing now" and is what the collapsed queue row
 * reads; this answers "what did it do" — the memory curve of a run that died at
 * minute forty, which is exactly the reading nobody has when they most want it,
 * because the live one is cleared the moment the job stops.
 *
 * The fields are typed here and typed in SQL, which is a real difference from
 * JobProgress: parseJobProgress is deliberately shallow (its fields are only
 * ever displayed), so the DO coerces each one on the way into a column. */
export interface JobSample {
  /** When the worker recorded the beat — its clock, not the daemon's, so a
   * daemon with a skewed clock cannot bend the time axis. */
  atUnix: number;
  /** The phase, so the chart can say what a flat stretch was doing. */
  state: string | null;
  frame: number | null;
  percent: number | null;
  rssBytes: number | null;
  cpuPct: number | null;
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
