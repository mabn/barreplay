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

import { FACET_PLAYERS_MAX, derivePlayerCount, mergeUploads } from "./replayentry";
import type { CatalogTeam, ReplayEntry, ReplayFacets, ReplayFilter, UploadRef } from "./replayentry";

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

/** Version of the DERIVED data (player_count + the replay_players and
 * replay_settings index tables). Rows carry no derivation of their own — it is
 * recomputed from the replays row — so bumping this rebuilds every row's
 * derived data on the next wake. Bump it whenever what those tables hold
 * changes; a rebuild is a few writes per row, not a migration. */
const DERIVED_VERSION = 1;

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

      -- Derived index tables behind the list filters. Both are rebuilt from
      -- the replays row on every write (and by rebuildDerived), never edited
      -- in place, so they cannot drift from the JSON columns they come from.
      -- Filtering on a name or a settings flag means "does this row have one",
      -- which is an EXISTS over these tables and answers to their index; the
      -- alternative, json_each over the stored blobs, has to open every row.
      CREATE TABLE IF NOT EXISTS replay_players (
        replay_id  TEXT NOT NULL,
        name_lower TEXT NOT NULL,
        name       TEXT NOT NULL,
        PRIMARY KEY (replay_id, name_lower)
      );
      CREATE INDEX IF NOT EXISTS replay_players_name ON replay_players (name_lower, replay_id);
      CREATE TABLE IF NOT EXISTS replay_settings (
        replay_id TEXT NOT NULL,
        flag      TEXT NOT NULL,
        PRIMARY KEY (replay_id, flag)
      );
      CREATE INDEX IF NOT EXISTS replay_settings_flag ON replay_settings (flag, replay_id);
      CREATE TABLE IF NOT EXISTS schema_meta (
        key   TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
    // In-place upgrades for tables created before a column existed (SQLite has
    // no ADD COLUMN IF NOT EXISTS; a duplicate-column error just means the
    // schema is already current).
    for (const col of [
      "settings TEXT",
      "rid TEXT",
      "players TEXT",
      "uploader_ally INTEGER",
      "uploads TEXT",
      "view TEXT",
      "player_count INTEGER",
      // The uploader-widget build behind the current revision. Three columns
      // rather than one JSON blob because the whole point is to be able to ask
      // "which widget builds are in the wild" / "which replays came from the
      // build with that bug" in SQL, over the catalog, without opening a blob
      // per row. The per-revision history lives in uploads[] (mergeUploads).
      "widget_version TEXT",
      "widget_sha TEXT",
      "widget_date TEXT",
    ]) {
      try {
        ctx.storage.sql.exec(`ALTER TABLE replays ADD COLUMN ${col}`);
      } catch (e) {
        if (!String(e).includes("duplicate column")) throw e;
      }
    }
    // Filter indexes. Created after the ALTERs because one of them indexes a
    // column the ALTERs may have just added.
    ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS replays_map   ON replays (map);
      CREATE INDEX IF NOT EXISTS replays_count ON replays (player_count);
    `);

    const have = ctx.storage.sql
      .exec(`SELECT value FROM schema_meta WHERE key = 'derived_version'`)
      .toArray();
    if ((have.length > 0 ? (have[0].value as number) : 0) < DERIVED_VERSION) {
      this.rebuildDerived();
      ctx.storage.sql.exec(
        `INSERT INTO schema_meta (key, value) VALUES ('derived_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        DERIVED_VERSION,
      );
    }
  }

  /** rebuildDerived recomputes player_count and the two index tables for every
   * row from the JSON the row already holds. Runs once per DERIVED_VERSION
   * bump (and so, once, for the rows that predate these tables). It cannot
   * invent what the row never stored: a row published under the old 5-per-ally
   * roster cap indexes the 5 names it has, and gets the rest only when it is
   * re-published or refreshed from the BAR API. */
  private rebuildDerived(): void {
    const rows = this.ctx.storage.sql
      .exec(`SELECT id, game_size, settings, players FROM replays`)
      .toArray();
    for (const r of rows) {
      const players: CatalogTeam[] | null = r.players == null ? null : JSON.parse(r.players as string);
      const settings: Record<string, boolean | string> | null =
        r.settings == null ? null : JSON.parse(r.settings as string);
      const count = derivePlayerCount(players, (r.game_size as string | null) ?? null);
      this.ctx.storage.sql.exec(`UPDATE replays SET player_count = ? WHERE id = ?`, count, r.id as string);
      this.indexRow(r.id as string, players, settings);
    }
  }

  /** indexRow replaces one replay's rows in the two derived tables. Delete
   * then insert (not upsert) so a roster or settings change can REMOVE an
   * entry — a re-publish that drops a player must not leave the old name
   * matching the filter. */
  private indexRow(
    id: string,
    players: CatalogTeam[] | null,
    settings: Record<string, boolean | string> | null,
  ): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM replay_players WHERE replay_id = ?`, id);
    sql.exec(`DELETE FROM replay_settings WHERE replay_id = ?`, id);
    const seen = new Set<string>();
    for (const g of players ?? []) {
      for (const p of g.players) {
        const lower = p.name.toLowerCase();
        // One row per distinct name: the same person can hold two slots in a
        // game, and the primary key would reject the duplicate.
        if (seen.has(lower)) continue;
        seen.add(lower);
        sql.exec(
          `INSERT INTO replay_players (replay_id, name_lower, name) VALUES (?, ?, ?)`,
          id, lower, p.name,
        );
      }
    }
    for (const [flag, value] of Object.entries(settings ?? {})) {
      // A flag counts as set when it is true or a non-empty string: the
      // string-valued ones (zombies: "akumu") are badges too, and the UI
      // filters on the flag's presence, not its value.
      if (value === true || (typeof value === "string" && value !== "")) {
        sql.exec(`INSERT INTO replay_settings (replay_id, flag) VALUES (?, ?)`, id, flag);
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
    const uploads = mergeUploads(before, e.rid, e.uploaderAlly, {
      version: e.widgetVersion ?? undefined,
      sha: e.widgetSha ?? undefined,
      date: e.widgetDate ?? undefined,
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO replays (id, rid, start_unix, duration_sec, map, game_size, size_bytes, settings, players, player_count, uploader_ally, uploads, view, widget_version, widget_sha, widget_date, updated_unix)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         rid = excluded.rid,
         start_unix = excluded.start_unix,
         duration_sec = excluded.duration_sec,
         map = excluded.map,
         game_size = excluded.game_size,
         size_bytes = excluded.size_bytes,
         settings = excluded.settings,
         players = excluded.players,
         player_count = excluded.player_count,
         uploader_ally = excluded.uploader_ally,
         uploads = excluded.uploads,
         -- Overwritten by a PUT that states a view, KEPT when one doesn't --
         -- unlike uploader_ally above, which a provenance-less re-publish
         -- nulls. A publisher states it only when the capture actually knows
         -- (a live upload's recorder record, or the re-sim declaring "full"),
         -- and that describes the revision the row now points at, so it must
         -- win; silence means "nothing to say", which must never wipe a
         -- hand-marking made through setView.
         view = COALESCE(excluded.view, view),
         -- Like view, and for the same reason: these describe the capture the
         -- row now points at, so a publisher that KNOWS its widget wins, while
         -- one that says nothing must not erase what is there. Silence means
         -- "not an uploader-widget capture, or too old to say" — a re-sim
         -- publish, or a pre-1.7.0 stream — and neither is grounds for
         -- forgetting which widget the game was actually recorded with. The
         -- per-revision truth is kept in uploads[] regardless.
         widget_version = COALESCE(excluded.widget_version, widget_version),
         widget_sha = COALESCE(excluded.widget_sha, widget_sha),
         widget_date = COALESCE(excluded.widget_date, widget_date),
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
      e.playerCount,
      e.uploaderAlly,
      uploads === null ? null : JSON.stringify(uploads),
      e.view,
      e.widgetVersion,
      e.widgetSha,
      e.widgetDate,
      Math.floor(Date.now() / 1000),
    );
    this.indexRow(e.id, e.players, e.settings);
  }

  /** setView records, by hand, whose point of view a replay was recorded from
   * — the admin marking behind the viewer's header control. It exists because
   * most rows carry no recorder provenance at all: their captures predate the
   * GAME record's recorder fields, so nothing can derive this, and a null
   * uploader_ally is ambiguous between "spectator saw everything", "re-sim",
   * and "we have no idea". view states that explicitly.
   *
   * "full" clears uploader_ally (a spectator has no side). "ally" stores the
   * team as well, and refreshes the current revision's uploads entry so the
   * per-revision history agrees with the marking. Returns false for an
   * unknown id. */
  setView(id: string, view: "full" | "ally" | "unknown", ally: number | null): boolean {
    const rows = this.ctx.storage.sql.exec(`SELECT rid, uploads FROM replays WHERE id = ?`, id).toArray();
    if (rows.length === 0) return false;
    const effAlly = view === "ally" ? ally : null;
    const rid = (rows[0].rid as string | null) ?? null;
    const before: UploadRef[] | null = rows[0].uploads != null ? JSON.parse(rows[0].uploads as string) : null;
    // Re-stamp the current revision so uploads[] matches the marking. Marking
    // a game "full" must clear the recorded ally, which mergeUploads cannot do
    // (it deliberately preserves a known ally against a null), so rewrite the
    // entry for this rid directly.
    let uploads = before;
    if (rid !== null) {
      const prior = before ?? [];
      uploads = prior.some((u) => u.rid === rid)
        ? prior.map((u) => (u.rid === rid ? { rid: u.rid, ally: effAlly } : u))
        : [...prior, { rid, ally: effAlly }];
    }
    this.ctx.storage.sql.exec(
      `UPDATE replays SET view = ?, uploader_ally = ?, uploads = ?, updated_unix = ? WHERE id = ?`,
      view,
      effAlly,
      uploads === null ? null : JSON.stringify(uploads),
      Math.floor(Date.now() / 1000),
      id,
    );
    return true;
  }

  /** list returns the replays matching `filter` (every replay when it is
   * omitted), most recently started first (rows with no start time sort last,
   * then by id so the order is stable).
   *
   * The WHERE clause is built from the predicates that are actually set rather
   * than a fixed `(? IS NULL OR col = ?)` chain, because the latter hides the
   * column behind an OR and SQLite then scans the table instead of using an
   * index. Every branch below is index-backed: replays_start for the dates,
   * replays_map, replays_count, and an EXISTS-style IN over the two derived
   * tables' covering indexes for names and flags. */
  list(filter?: ReplayFilter): ReplayEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter) {
      if (filter.from !== null) { where.push(`start_unix >= ?`); args.push(filter.from); }
      if (filter.to !== null) { where.push(`start_unix <= ?`); args.push(filter.to); }
      if (filter.map !== null) { where.push(`map = ?`); args.push(filter.map); }
      if (filter.minPlayers !== null) { where.push(`player_count >= ?`); args.push(filter.minPlayers); }
      if (filter.maxPlayers !== null) { where.push(`player_count <= ?`); args.push(filter.maxPlayers); }
      if (filter.player !== null) {
        // Prefix match as a RANGE, not LIKE: SQLite's LIKE is case-insensitive
        // by default, which disqualifies it from using the index. name_lower is
        // stored folded and the needle arrives folded, so a plain >= / < pair
        // over the covering index does the same job and can seek.
        where.push(`id IN (SELECT replay_id FROM replay_players WHERE name_lower >= ? AND name_lower < ?)`);
        args.push(filter.player, filter.player + "￿");
      }
      for (const flag of filter.settings) {
        // One IN per flag, so the row must carry ALL of them (a single
        // `flag IN (...)` would match any one of them).
        where.push(`id IN (SELECT replay_id FROM replay_settings WHERE flag = ?)`);
        args.push(flag);
      }
    }
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, rid, start_unix, duration_sec, map, game_size, size_bytes, settings, players, player_count, uploader_ally, uploads, view, widget_version, widget_sha, widget_date
         FROM replays
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY start_unix IS NULL, start_unix DESC, id`,
        ...args,
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
      playerCount: r.player_count as number | null,
      uploaderAlly: r.uploader_ally as number | null,
      uploads: r.uploads == null ? null : JSON.parse(r.uploads as string),
      view: (r.view as ReplayEntry["view"]) ?? null,
      widgetVersion: (r.widget_version as string | null) ?? null,
      widgetSha: (r.widget_sha as string | null) ?? null,
      widgetDate: (r.widget_date as string | null) ?? null,
    }));
  }

  /** facets returns the distinct values the filter UI offers as choices, so a
   * map or size that no replay has is never presented. Computed over the WHOLE
   * catalog, not the current result set: a filter bar whose options shrink as
   * you use it cannot be used to change your mind. */
  facets(): ReplayFacets {
    const sql = this.ctx.storage.sql;
    const col = <T>(q: string, key: string): T[] => sql.exec(q).toArray().map((r) => r[key] as T);
    const span = sql.exec(`SELECT MIN(start_unix) AS lo, MAX(start_unix) AS hi FROM replays`).toArray();
    return {
      maps: col<string>(`SELECT DISTINCT map FROM replays WHERE map IS NOT NULL ORDER BY map`, "map"),
      sizes: col<number>(
        `SELECT DISTINCT player_count FROM replays WHERE player_count IS NOT NULL ORDER BY player_count`,
        "player_count",
      ),
      // MIN(name) so a name that two rows spell differently in case still
      // yields one completion; ordered case-insensitively for the datalist.
      players: col<string>(
        `SELECT MIN(name) AS name FROM replay_players GROUP BY name_lower ORDER BY name_lower LIMIT ${FACET_PLAYERS_MAX}`,
        "name",
      ),
      settings: col<string>(`SELECT DISTINCT flag FROM replay_settings ORDER BY flag`, "flag"),
      from: span.length ? ((span[0].lo as number | null) ?? null) : null,
      to: span.length ? ((span[0].hi as number | null) ?? null) : null,
    };
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
    if (cur.rowsWritten === 0) return false;
    // Both derived tables come from exactly the two columns this just
    // rewrote, so they have to be rebuilt with them — otherwise the filters
    // keep matching the roster and badges the refresh replaced. Re-read the
    // row rather than trusting the arguments: a null players means "keep what
    // is there" (the COALESCE above), and the index must follow the stored
    // value, not the omission.
    const row = this.ctx.storage.sql
      .exec(`SELECT game_size, settings, players FROM replays WHERE id = ?`, id)
      .toArray();
    if (row.length === 0) return true;
    const storedPlayers: CatalogTeam[] | null =
      row[0].players == null ? null : JSON.parse(row[0].players as string);
    const storedSettings: Record<string, boolean | string> | null =
      row[0].settings == null ? null : JSON.parse(row[0].settings as string);
    this.ctx.storage.sql.exec(
      `UPDATE replays SET player_count = ? WHERE id = ?`,
      derivePlayerCount(storedPlayers, (row[0].game_size as string | null) ?? null),
      id,
    );
    this.indexRow(id, storedPlayers, storedSettings);
    return true;
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

  /** jobsRecent is the queue as a PERSON reads it (GET /api/queue): everything
   * still in flight first — those are what the view exists to answer for —
   * then the most recently finished jobs, newest first. Unlike jobsPending it
   * does not hide a fresh "processing" job: a daemon working right now is
   * exactly what the viewer wants to see, even though it is not work to hand
   * out. Bounded by `limit`, since the table only grows. */
  jobsRecent(limit: number): IngestJob[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT id, stream_key, game_id, state, error, created_unix, updated_unix FROM jobs
         ORDER BY CASE WHEN state IN ('pending', 'processing') THEN 0 ELSE 1 END,
                  updated_unix DESC, id
         LIMIT ?`,
        limit,
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
