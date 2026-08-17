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
  createdUnix: number;
  updatedUnix: number;
}
