// The replay index: a SQLite-backed Durable Object that owns the catalog of
// uploaded replays. One instance (idFromName("index")) holds two small
// tables; the Worker's /api routes are thin wrappers over its RPC methods.
// The R2 bucket remains the source of the replay DATA — the replays table is
// only the picker metadata (when the game started, how long it ran, which map,
// the team-size spec like "8v8"), which the bucket listing cannot provide
// because it lives inside each .brp's meta record. The jobs table tracks
// drag&drop uploads through the ingest pipeline: POST /api/upload archives the
// raw stream and inserts a pending row; the Go daemon (cmd/bringest)
// polls pending rows, publishes the replay, and reports done/error; the
// front-end polls its job row to know when to open the replay.
import { DurableObject } from "cloudflare:workers";

import { mergeUploads } from "./replayentry";
import type { CatalogTeam, ReplayEntry, UploadRef } from "./replayentry";

/** One drag&drop upload's trip through the ingest pipeline. */
export interface IngestJob {
  id: string;
  /** R2 key of the archived raw stream (streams/<gameId>/<ts>-<who>.brepstream). */
  streamKey: string;
  gameId: string;
  state: "pending" | "processing" | "done" | "error";
  /** Failure detail when state is "error". */
  error: string | null;
  createdUnix: number;
  updatedUnix: number;
}

export const JOB_STATES = ["pending", "processing", "done", "error"] as const;

/** A "processing" job untouched for this long is presumed crashed and is
 * offered to the daemon again alongside the pending ones. */
const STALE_PROCESSING_SEC = 15 * 60;

export class ReplayIndex extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS replays (
        id           TEXT PRIMARY KEY,
        start_unix   INTEGER,
        duration_sec INTEGER,
        map          TEXT,
        game_size    TEXT,
        size_bytes   INTEGER,
        settings     TEXT,
        updated_unix INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS replays_start ON replays (start_unix DESC);
      CREATE TABLE IF NOT EXISTS jobs (
        id           TEXT PRIMARY KEY,
        stream_key   TEXT NOT NULL,
        game_id      TEXT NOT NULL,
        state        TEXT NOT NULL,
        error        TEXT,
        created_unix INTEGER NOT NULL,
        updated_unix INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state, updated_unix);
    `);
    // In-place upgrades for tables created before a column existed (SQLite has
    // no ADD COLUMN IF NOT EXISTS; a duplicate-column error just means the
    // schema is already current).
    for (const col of ["settings TEXT", "rid TEXT", "players TEXT", "uploader_ally INTEGER", "uploads TEXT"]) {
      try {
        ctx.storage.sql.exec(`ALTER TABLE replays ADD COLUMN ${col}`);
      } catch (e) {
        if (!String(e).includes("duplicate column")) throw e;
      }
    }
  }

  /** upsert inserts or fully replaces one replay's catalog row — except the
   * uploads list, which accumulates: each revisioned PUT appends its
   * {rid, uploaderAlly} so the row remembers every published upload of the
   * game, not just the current one. */
  upsert(e: ReplayEntry): void {
    const prior = this.ctx.storage.sql
      .exec(`SELECT uploads FROM replays WHERE id = ?`, e.id)
      .toArray();
    const before: UploadRef[] | null =
      prior.length > 0 && prior[0].uploads != null ? JSON.parse(prior[0].uploads as string) : null;
    const uploads = mergeUploads(before, e.rid, e.uploaderAlly);
    this.ctx.storage.sql.exec(
      `INSERT INTO replays (id, rid, start_unix, duration_sec, map, game_size, size_bytes, settings, players, uploader_ally, uploads, updated_unix)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         rid = excluded.rid,
         start_unix = excluded.start_unix,
         duration_sec = excluded.duration_sec,
         map = excluded.map,
         game_size = excluded.game_size,
         size_bytes = excluded.size_bytes,
         settings = excluded.settings,
         players = excluded.players,
         uploader_ally = excluded.uploader_ally,
         uploads = excluded.uploads,
         updated_unix = excluded.updated_unix`,
      e.id,
      e.rid,
      e.startUnix,
      e.durationSec,
      e.map,
      e.gameSize,
      e.sizeBytes,
      e.settings === null ? null : JSON.stringify(e.settings),
      e.players === null ? null : JSON.stringify(e.players),
      e.uploaderAlly,
      uploads === null ? null : JSON.stringify(uploads),
      Math.floor(Date.now() / 1000),
    );
  }

  /** list returns every replay, most recently started first (rows with no
   * start time sort last, then by id so the order is stable). */
  list(): ReplayEntry[] {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, rid, start_unix, duration_sec, map, game_size, size_bytes, settings, players, uploader_ally, uploads
         FROM replays
         ORDER BY start_unix IS NULL, start_unix DESC, id`,
      )
      .toArray();
    return rows.map((r) => ({
      id: r.id as string,
      rid: r.rid as string | null,
      startUnix: r.start_unix as number | null,
      durationSec: r.duration_sec as number | null,
      map: r.map as string | null,
      gameSize: r.game_size as string | null,
      sizeBytes: r.size_bytes as number | null,
      settings: r.settings == null ? null : JSON.parse(r.settings as string),
      players: r.players == null ? null : JSON.parse(r.players as string),
      uploaderAlly: r.uploader_ally as number | null,
      uploads: r.uploads == null ? null : JSON.parse(r.uploads as string),
    }));
  }

  /** refreshFromApi replaces one row's settings badges and players roster
   * with values re-derived from the BAR API's stored demo metadata (the
   * admin refresh — no repack/re-upload). A null players keeps whatever the
   * row already has (the API not knowing the roster must never erase one).
   * Returns false when the id has no catalog row. */
  refreshFromApi(
    id: string,
    settings: Record<string, boolean | string> | null,
    players: CatalogTeam[] | null,
  ): boolean {
    const cur = this.ctx.storage.sql.exec(
      `UPDATE replays SET settings = ?, players = COALESCE(?, players), updated_unix = ? WHERE id = ?`,
      settings === null ? null : JSON.stringify(settings),
      players === null ? null : JSON.stringify(players),
      Math.floor(Date.now() / 1000),
      id,
    );
    return cur.rowsWritten > 0;
  }

  /** jobInsert records a fresh upload as a pending ingest job. */
  jobInsert(id: string, streamKey: string, gameId: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.ctx.storage.sql.exec(
      `INSERT INTO jobs (id, stream_key, game_id, state, error, created_unix, updated_unix)
       VALUES (?, ?, ?, 'pending', NULL, ?, ?)`,
      id,
      streamKey,
      gameId,
      now,
      now,
    );
  }

  jobGet(id: string): IngestJob | null {
    const rows = this.ctx.storage.sql
      .exec(`SELECT id, stream_key, game_id, state, error, created_unix, updated_unix FROM jobs WHERE id = ?`, id)
      .toArray();
    return rows.length === 0 ? null : jobRow(rows[0]);
  }

  /** jobsPending lists what the ingest daemon should work on: every pending
   * job, plus "processing" jobs whose worker apparently died (no update for
   * STALE_PROCESSING_SEC), oldest first. */
  jobsPending(): IngestJob[] {
    const staleBefore = Math.floor(Date.now() / 1000) - STALE_PROCESSING_SEC;
    return this.ctx.storage.sql
      .exec(
        `SELECT id, stream_key, game_id, state, error, created_unix, updated_unix FROM jobs
         WHERE state = 'pending' OR (state = 'processing' AND updated_unix < ?)
         ORDER BY created_unix, id`,
        staleBefore,
      )
      .toArray()
      .map(jobRow);
  }

  /** jobUpdate transitions a job's state (daemon claim / completion report).
   * Returns false when the job id is unknown. */
  jobUpdate(id: string, state: "processing" | "done" | "error", error: string | null): boolean {
    const cur = this.ctx.storage.sql.exec(`UPDATE jobs SET state = ?, error = ?, updated_unix = ? WHERE id = ?`,
      state,
      error,
      Math.floor(Date.now() / 1000),
      id,
    );
    return cur.rowsWritten > 0;
  }
}

function jobRow(r: Record<string, unknown>): IngestJob {
  return {
    id: r.id as string,
    streamKey: r.stream_key as string,
    gameId: r.game_id as string,
    state: r.state as IngestJob["state"],
    error: r.error as string | null,
    createdUnix: r.created_unix as number,
    updatedUnix: r.updated_unix as number,
  };
}
