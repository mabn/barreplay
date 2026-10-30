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
 * the demo and re-simulates it headlessly. "app" is a re-simulation somebody
 * is running in FogOfWar.exe on their own PC: nobody hands it out — the app
 * creates the row itself when it starts simulating (POST /api/app/jobs) and
 * reports on it like a daemon would, so it is never in DAEMON_KINDS. The
 * states below describe all three equally well — what differs is the work,
 * not the progress — so this is a kind, not a fifth state. */
export type JobKind = "upload" | "resim" | "app";

export const JOB_KINDS: readonly JobKind[] = ["upload", "resim", "app"];

/** The kinds a bringest daemon may ask for and claim. An "app" job is already
 * being worked on by the app that created it, so offering it to a daemon would
 * run the same hour of engine time twice. */
export const DAEMON_KINDS: readonly JobKind[] = ["upload", "resim"];

/** How long an "app" job may go without a healthcheck before the cron marks it
 * failed. The app beats every 10 s; a PC that went to sleep, a crash or a
 * killed window simply stop, and without this the row (and the catalog's
 * "processing" pill for its game) would stay processing forever. A beat that
 * arrives after the expiry puts the row back into "processing". */
export const APP_JOB_STALE_SEC = 5 * 60;

/** An install id as the app sends it: a UUID (v7 from FogOfWar.exe), checked
 * for shape only. */
export function parseInstallId(v: unknown): string | null {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.toLowerCase())
    ? v.toLowerCase()
    : null;
}

export const JOB_STATES = ["pending", "processing", "done", "error"] as const;

/** Failures worth telling apart on the queue page.
 *
 * "oom": the host ran out of memory and the daemon stopped the engine rather
 * than letting the kernel OOM-kill it. It is the one failure that is about the
 * MACHINE rather than the game or the pipeline — the same replay on a bigger
 * box would have worked — so a queue full of red rows should say which ones are
 * that, without anyone parsing a sentence.
 *
 * A CLOSED set, validated on the way in: the queue page renders each kind
 * specifically, so an unknown one would have nothing to render. A daemon that
 * learns to recognise a new failure adds it here first. */
export const JOB_ERROR_KINDS = ["oom"] as const;
export type JobErrorKind = (typeof JOB_ERROR_KINDS)[number];

/** parseJobErrorKind takes a kind off the wire, or null for anything that is
 * not one of the known ones. Dropped rather than rejected, like the stats: a
 * daemon newer than this worker must still be able to report that its job
 * failed. */
export function parseJobErrorKind(v: unknown): JobErrorKind | null {
  return typeof v === "string" && (JOB_ERROR_KINDS as readonly string[]).includes(v)
    ? (v as JobErrorKind)
    : null;
}

/** One job's trip through the ingest pipeline: a drag&drop upload, or a
 * re-simulation requested by pasting a replay link. */
export interface IngestJob {
  id: string;
  /** The FogOfWar.exe install that made the job (an "app" job, or the upload
   * of the .brp it produced), so every job from one PC can be found. Null for
   * everything bringest does. */
  installId: string | null;
  /** The "app" job an upload job publishes the .brp of; null otherwise. The
   * queue shows such an upload inside its parent's row (QueueJob.publish). */
  parentId: string | null;
  /** R2 key of the archived raw stream (streams/<gameId>/<ts>-<who>.brepstream).
   * Empty for a "resim" job, which has no uploaded stream — the demo it works
   * from is fetched from the BAR API by the daemon. */
  streamKey: string;
  gameId: string;
  kind: JobKind;
  state: (typeof JOB_STATES)[number];
  /** Failure detail when state is "error". */
  error: string | null;
  /** What KIND of failure, where the daemon could tell — see JOB_ERROR_KINDS.
   * Null for a failure it has no name for (most of them), and for every job
   * that did not fail. */
  errorKind: JobErrorKind | null;
  /** Held back: no daemon will be offered this job, and no game it names will
   * be auto-queued while the row exists. Orthogonal to `state` rather than a
   * fifth value of it — the four states describe how far the WORK got, and
   * being held back is not a stage of that; it is also reversible, which a
   * state would make awkward. Disabling a running job resets it to "pending"
   * (nothing is working on it as far as this table is concerned) and its
   * heartbeats stop moving it, though a daemon already mid-run may still
   * report a terminal state, which is recorded. */
  disabled: boolean;
  /** A word from the worker about the row, e.g. why a pasted re-sim was
   * recorded disabled ("Already simulated at .brp format version 6"). */
  note: string | null;
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
  /** How much of the engine has been pushed out to SWAP. Zero is the healthy
   * answer and the usual one, which is exactly why the daemon sends it even
   * when it is zero: "the engine is not swapping" and "this daemon is too old
   * to know" must not arrive as the same absent field. Anything above zero is
   * the direct explanation for a run that has gone slow — a sim frame faulting
   * its own state back in is doing disk I/O per frame. */
  swapBytes?: number;
  /** The engine's CPU use as a percentage of ONE core, so a busy multi-threaded
   * engine reports well over 100. This and rssBytes are the only window anyone
   * has onto the health of the machine actually doing the work — the daemon
   * runs on somebody's workstation, behind NAT, and nothing else here can see
   * it. */
  cpuPct?: number;
  /** How long the job has been running, so the page can put the time left
   * against the whole run. */
  elapsedSec?: number;
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

/** What the queue page shows about the GAME a job is working on, as opposed to
 * about the job. It is not part of IngestJob because it is not part of a job:
 * the jobs table knows a gameId and nothing else about the game, and these are
 * joined on at read time from whichever table happens to know them.
 *
 * Two sources, in that order of preference: the catalog row if the game has one
 * (what was actually captured), else the games mirror (what BAR published).
 * The mirror is what covers a re-sim of a game nobody has uploaded — which is
 * most of what sits in this queue — and the catalog covers an upload of a game
 * the mirror never saw. Null when neither knows it. */
export interface QueueGame {
  durationSec: number | null;
  /** The team spec, "8v8" / "1v1". */
  gameSize: string | null;
  /** When the game started (unix seconds); its end is this plus durationSec. */
  startUnix: number | null;
  map: string | null;
  /** The map's archive name, which BAR's maps API keys on (mirror only). */
  mapFile: string | null;
  /** The notable-settings flags the list draws as pills. */
  settings: Record<string, boolean | string> | null;
}

/** The publish of an app run's .brp: the upload job created for it, as the
 * queue shows it inside the app's row. */
export interface JobPublish {
  id: string;
  state: IngestJob["state"];
  error: string | null;
  /** What bringest measured publishing it (pack/upload time, its host). */
  stats: JobStats | null;
  updatedUnix: number;
}

/** One row of the queue page: the job, plus what is known about its game,
 * plus — for an "app" job — the publish of the .brp it made. */
export type QueueJob = IngestJob & {
  game: QueueGame | null;
  publish: JobPublish | null;
  /** The game has a playable replay here (a catalog row that is not a
   * placeholder) — the only case the queue's Game cell links. */
  published: boolean;
};

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
  /** What the daemon thought was left, at that moment. Charted over time it is
   * the one series that says whether the run is CONVERGING: a healthy re-sim
   * walks it down towards zero, and a stretch where it climbs is the run
   * getting slower than it is getting on. */
  etaSec: number | null;
  rssBytes: number | null;
  swapBytes: number | null;
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
  /** An upload's view as its opening frames showed it (packer.ViewCheck):
   * what decided the view it was published under. */
  viewCheck?: string;
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
  /** Which bringest did the work: its git commit (dirty when the tree had
   * uncommitted changes), the commit's time and the binary's build time. */
  bringest?: {
    sha?: string;
    dirty?: boolean;
    commitTime?: string;
    time?: string;
    /** "vcs" | "git" | "ldflags" — where the sha was read from. */
    source?: string;
    goVersion?: string;
  };
  /** The widget build behind the capture: the player's copy for an upload,
   * the daemon's embedded one for a re-sim. */
  widgetVersion?: string;
  widgetSha?: string;
  widgetDate?: string;
  /** The .brp container version published. */
  brpVersion?: number;
  /** The machine the daemon ran on: hostname, total RAM, CPU model and
   * physical cores / logical threads (cores absent where /proc says none).
   * The app adds the Windows version, what was free when the run started and
   * the free disk under its data folder; it sends no hostname (a volunteer's
   * PC name is theirs — the install id identifies the machine). */
  host?: {
    hostname?: string;
    memBytes?: number;
    cores?: number;
    threads?: number;
    cpuModel?: string;
    os?: string;
    osBuild?: string;
    memFreeBytes?: number;
    diskFreeBytes?: number;
  };
  /** Whether the run used the patched engine, and which published build. */
  enginePatched?: boolean;
  patchedBuild?: string;
  /** FogOfWar.exe only: which app made the job and how it was asked to. */
  app?: {
    name?: string;
    version?: string;
    installId?: string;
    goVersion?: string;
    /** Picked by auto-replay rather than pasted by the user. */
    auto?: boolean;
    /** The user's settings for the run. */
    minFreeMB?: number;
    patchedEngine?: boolean;
    /** How many re-sims this install has run before this one. */
    runs?: number;
  };
  /** Wall seconds spent in each phase ("fetching demo", "provisioning
   * content", "loading", "simulating", "saving", "uploading"...), in order:
   * where a slow run's time went, downloads included. */
  phases?: { phase: string; sec: number }[];
  /** The engine process's highest resident memory and swap over the run. */
  peakRssBytes?: number;
  peakSwapBytes?: number;
  /** The upload job that publishes the app's .brp (its own queue row). */
  uploadJob?: string;
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
