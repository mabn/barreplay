// The replay index: a SQLite-backed Durable Object that owns the catalog of
// uploaded replays. One instance (idFromName("index")) holds a handful of
// small tables; the Worker's /api routes are thin wrappers over its RPC
// methods.
// The R2 bucket remains the source of the replay DATA — the replays table is
// only the picker metadata (when the game started, how long it ran, which map,
// the team-size spec like "8v8"), which the bucket listing cannot provide
// because it lives inside each .brp's meta record. The jobs table tracks work
// through the ingest pipeline, of two kinds: POST /api/upload archives a
// dropped .brepstream and inserts a pending "upload" row, and POST /api/resim
// inserts a pending "resim" row for a game nobody recorded, to be re-simulated
// from its demo. A Go daemon (cmd/bringest, plain or -resim) polls the rows of
// its kind, publishes the replay, and reports done/error; the front-end polls
// its job row to know when it landed.
//
// The games table is the mirror of BAR's own history (src/worker/games.ts,
// filled by the every-minute cron): the games that were PLAYED, as opposed to
// the ones somebody captured. Nothing serves it yet — it is the work list the
// re-sim side will pick from.
import { DurableObject } from "cloudflare:workers";

import type { GameEntry } from "./games";
import { parseJobProgress, parseJobStats } from "./jobs";
import type { IngestJob, JobKind, JobProgress, JobSample, JobStats, QueueGame, QueueJob } from "./jobs";
import { FACET_PLAYERS_MAX, SETTINGS_MODS_FLAG, derivePlayerCount, mergeUploads } from "./replayentry";
import type { CatalogTeam, ReplayEntry, ReplayFacets, ReplayFilter, UploadRef } from "./replayentry";

export type { IngestJob, JobKind, JobProgress, JobSample, JobStats, QueueGame, QueueJob } from "./jobs";

/** A "processing" job untouched for this long is presumed crashed and is
 * offered to the daemon again alongside the pending ones. This is why a
 * re-sim — which runs far longer than 15 minutes — HEARTBEATS: the daemon
 * re-reports "processing" on a ticker, so silence for this long keeps meaning
 * "the worker died" rather than "the worker is busy". */
const STALE_PROCESSING_SEC = 15 * 60;

/** The same, for a re-sim. The heartbeat is what really keeps a live job out
 * of the work list; this is the backstop for a daemon too old to send one,
 * and it is generous because the thing it must not interrupt is an hour of
 * engine time that would simply be run twice. */
const STALE_PROCESSING_RESIM_SEC = 90 * 60;

/** How many of the newest ELIGIBLE mirrored games the backfill chooses from.
 * It picks the biggest game in that window, not the newest one: an 8v8 is
 * worth far more to have than the 1v1 that happened to finish a minute later,
 * and re-simulating either costs the same hour of somebody's machine.
 *
 * The window is over CANDIDATES, not over the mirror's last 20 rows. Those
 * would drain: every game handed out gains a job row and stops being eligible,
 * so after twenty of them a window over raw recency would be permanently empty
 * and the daemon would idle with thousands of games still to do. */
const BACKFILL_WINDOW = 20;

/** How many healthchecks one job keeps. At the daemon's 10-second beat that is
 * two hours at full resolution, comfortably past any real re-simulation.
 *
 * Going over does not stop recording and does not drop the start of the run —
 * both would lose the part of the curve worth having. jobSampleThin halves the
 * series instead, keeping its first and last sample and every other one
 * between, so the chart keeps its full time span at half the resolution and
 * the cap cannot be hit again for another half-cap beats. */
const MAX_JOB_SAMPLES = 720;

/** How long a finished job's samples outlive it. They exist to be read AFTER
 * the fact — the memory curve of a run that died is the whole point — so they
 * are not cleared with the live progress; they age out instead. */
export const JOB_SAMPLE_RETENTION_SEC = 30 * 24 * 60 * 60;

/** Columns every jobs SELECT reads, in the order jobRow expects. */
const JOB_COLS =
  "id, stream_key, game_id, kind, state, error, stats, progress, disabled, created_unix, updated_unix";

/** The same columns qualified to `j`, for the one query that joins the jobs
 * table against the two that know anything about a game. Derived from JOB_COLS
 * rather than written out again, so the two cannot drift — and SQLite names a
 * result column after the column, not the qualifier, so jobRow still finds
 * every one of them. */
const JOB_COLS_J = JOB_COLS.split(", ")
  .map((c) => `j.${c}`)
  .join(", ");

/** What came of asking for a job: a fresh row, the one that already covers the
 * game, or a refusal. "disabled" and "in-catalog" are both "nothing will
 * happen", said precisely enough for the caller to explain it. */
export type JobEnqueue = {
  status: "queued" | "duplicate" | "disabled" | "in-catalog";
  job: IngestJob | null;
};

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
        kind         TEXT NOT NULL DEFAULT 'upload',
        state        TEXT NOT NULL,
        error        TEXT,
        stats        TEXT,
        progress     TEXT,
        created_unix INTEGER NOT NULL,
        updated_unix INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state, updated_unix);

      -- Every healthcheck a running job sent, kept as history. The jobs row's
      -- progress column holds only the newest reading and is cleared when the
      -- job ends; this is the series behind the queue page's charts, and it
      -- deliberately OUTLIVES the job (see JOB_SAMPLE_RETENTION_SEC): what the
      -- engine's memory was doing before a run died is worth having precisely
      -- when the live reading is gone.
      -- Keyed by (job, time) so a beat retried inside the same second is the
      -- same reading rather than a second point on the chart.
      CREATE TABLE IF NOT EXISTS job_samples (
        job_id    TEXT NOT NULL,
        at_unix   INTEGER NOT NULL,
        state     TEXT,
        frame     INTEGER,
        percent   REAL,
        eta_sec   REAL,
        rss_bytes INTEGER,
        swap_bytes INTEGER,
        cpu_pct   REAL,
        PRIMARY KEY (job_id, at_unix)
      );

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

      -- Every game BAR published that this worker has seen, captured or not
      -- (the cron in index.ts, via games.ts). Keyed by the SAME gameId as
      -- replays, so a row here and a row there are two views of one game:
      -- what was played, and what was captured of it. The columns deliberately
      -- echo the catalog's vocabulary (map/size/roster/settings) so the two
      -- can be compared without translating, and the JSON columns are kept so
      -- the derived tables below can be rebuilt without re-reading the API.
      CREATE TABLE IF NOT EXISTS games (
        id             TEXT PRIMARY KEY,
        start_unix     INTEGER,
        duration_sec   INTEGER,
        map            TEXT,
        map_file       TEXT,
        game_size      TEXT,
        -- BAR's own bucket for the game: "duel" / "team" / "ffa".
        preset         TEXT,
        player_count   INTEGER,
        players        TEXT,
        settings       TEXT,
        engine_version TEXT,
        game_version   TEXT,
        synced_unix    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS games_start ON games (start_unix DESC);
      -- Nothing reads this yet. It is here because the query the mirror exists
      -- to answer is "the newest games of this kind", and adding it now costs
      -- one line where adding it to a full table later costs a rebuild.
      CREATE INDEX IF NOT EXISTS games_preset ON games (preset, start_unix DESC);
    `);
    // In-place upgrades for tables created before a column existed (SQLite has
    // no ADD COLUMN IF NOT EXISTS; a duplicate-column error just means the
    // schema is already current).
    const addColumn = (table: string, col: string): void => {
      try {
        ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      } catch (e) {
        if (!String(e).includes("duplicate column")) throw e;
      }
    };
    // The jobs table predates the re-sim requests, so its rows are all
    // uploads; the DEFAULT is what says so, for the existing rows and for
    // every daemon that still POSTs without naming a kind.
    addColumn("jobs", "kind TEXT NOT NULL DEFAULT 'upload'");
    // Nullable, unlike kind: a job finished before the daemon reported stats
    // has none, and there is nothing to infer.
    addColumn("jobs", "stats TEXT");
    // The running job's live self-report. Nullable and, unlike stats,
    // deliberately EMPTY most of the time: jobUpdate clears it the moment the
    // job reaches a terminal state, because progress describes work in flight
    // and a finished row showing "simulating, 43%" would be a lie.
    addColumn("jobs", "progress TEXT");
    // Held back by hand from the queue page. NOT NULL with a default, so every
    // row that predates it reads as enabled, which is what they all were.
    addColumn("jobs", "disabled INTEGER NOT NULL DEFAULT 0");
    // Added after the other sample columns: a run's remaining-time estimate was
    // reported from the start but only ever overwritten in place, so the rows
    // written before this have none and chart as a gap.
    addColumn("job_samples", "eta_sec REAL");
    // Same story: reported from the start of the healthcheck but only ever
    // shown live, so rows written before this chart as a gap.
    addColumn("job_samples", "swap_bytes INTEGER");
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
      // 1 = this row is a PIPELINE placeholder: it exists so a game being
      // worked on shows up in the list, and nothing has been published for it
      // yet. It is what makes a row un-openable in the viewer, and the only
      // kind of row the pipeline ever deletes.
      "placeholder INTEGER NOT NULL DEFAULT 0",
    ]) {
      addColumn("replays", col);
    }
    // Filter indexes. Created after the ALTERs because one of them indexes a
    // column the ALTERs may have just added.
    ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS replays_map   ON replays (map);
      CREATE INDEX IF NOT EXISTS replays_count ON replays (player_count);
      CREATE INDEX IF NOT EXISTS replays_dur   ON replays (duration_sec);
      CREATE INDEX IF NOT EXISTS jobs_kind     ON jobs (kind, state, updated_unix);
      -- Every catalog read asks "is a job processing this game", once per row.
      CREATE INDEX IF NOT EXISTS jobs_game     ON jobs (game_id, state);
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
    // The mirrored games index into the same two tables, so a rebuild has to
    // cover them or their entries would be left at whatever an older
    // derivation produced. Only the ones no catalog row owns (see indexRow):
    // an id in both was just rebuilt above, from the capture's own roster.
    const games = this.ctx.storage.sql
      .exec(`SELECT id, settings, players FROM games WHERE id NOT IN (SELECT id FROM replays)`)
      .toArray();
    for (const g of games) {
      this.indexRow(
        g.id as string,
        g.players == null ? null : JSON.parse(g.players as string),
        g.settings == null ? null : JSON.parse(g.settings as string),
      );
    }
  }

  /** indexRow replaces one game's rows in the two derived tables. Delete then
   * insert (not upsert) so a roster or settings change can REMOVE an entry — a
   * re-publish that drops a player must not leave the old name matching the
   * filter.
   *
   * Both the catalog and the games mirror index into these tables, under the
   * same gameId, so exactly ONE of them owns an id's entries: the catalog row
   * if there is one (its roster comes from the capture that was actually
   * published), the games row otherwise. gamesInsert enforces that by not
   * touching an id the catalog holds — without it, the two would take turns
   * deleting each other's entries. */
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
      `INSERT INTO replays (id, rid, start_unix, duration_sec, map, game_size, size_bytes, settings, players, player_count, uploader_ally, uploads, view, widget_version, widget_sha, widget_date, placeholder, updated_unix)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         rid = excluded.rid,
         -- A publish is exactly what a placeholder was waiting for: there are
         -- bytes now, so the row becomes an ordinary, openable catalog entry
         -- and stops being something the pipeline may delete.
         placeholder = 0,
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
  list(filter?: ReplayFilter, limit?: number, offset?: number): ReplayEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter) {
      if (filter.from !== null) { where.push(`start_unix >= ?`); args.push(filter.from); }
      if (filter.to !== null) { where.push(`start_unix <= ?`); args.push(filter.to); }
      if (filter.map !== null) { where.push(`map = ?`); args.push(filter.map); }
      if (filter.minPlayers !== null) { where.push(`player_count >= ?`); args.push(filter.minPlayers); }
      if (filter.maxPlayers !== null) { where.push(`player_count <= ?`); args.push(filter.maxPlayers); }
      // NULL duration compares false either way, which is the intent: a row
      // that never recorded how long the game ran cannot be said to fall
      // inside a length the user asked for.
      if (filter.minDuration !== null) { where.push(`duration_sec >= ?`); args.push(filter.minDuration); }
      if (filter.maxDuration !== null) { where.push(`duration_sec <= ?`); args.push(filter.maxDuration); }
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
    // Paging is plain LIMIT/OFFSET over an ordered, indexed listing. The
    // caller asks for one row more than it means to show and reads "there is
    // a next page" off that row's existence, which is why nothing here counts
    // anything: a COUNT over the whole catalog would be a second query whose
    // cost grows with the archive, to answer a question the extra row already
    // answers. An omitted limit means the whole listing (bringest's catalog
    // scan, and any front-end too old to page).
    let window = "";
    if (limit !== undefined && limit > 0) {
      window = `LIMIT ? OFFSET ?`;
      args.push(limit, offset !== undefined && offset > 0 ? offset : 0);
    }
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, rid, start_unix, duration_sec, map, game_size, size_bytes, settings, players, player_count, uploader_ally, uploads, view, widget_version, widget_sha, widget_date, placeholder,
                EXISTS (SELECT 1 FROM jobs j WHERE j.game_id = replays.id AND j.state = 'processing') AS processing
         FROM replays
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY start_unix IS NULL, start_unix DESC, id
         ${window}`,
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
      placeholder: r.placeholder === 1,
      // DERIVED, never stored: a flag would have to be cleared by whoever
      // finishes the job, and every path that forgets — a crash, a stale
      // daemon, a job deleted by hand — would leave a row saying "processing"
      // forever. Asked of the jobs table it is simply true while a job is
      // running and false the moment one is not.
      processing: r.processing === 1,
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
      //
      // Restricted to ids the CATALOG holds, because the two derived tables
      // also carry the games mirror — thousands of games nothing has published.
      // Those names and flags match no listable replay, and an option that
      // filters to an empty list is worse than an absent one; this endpoint
      // exists precisely to avoid offering them.
      players: col<string>(
        `SELECT MIN(name) AS name FROM replay_players
         WHERE replay_id IN (SELECT id FROM replays)
         GROUP BY name_lower ORDER BY name_lower LIMIT ${FACET_PLAYERS_MAX}`,
        "name",
      ),
      settings: col<string>(
        `SELECT DISTINCT flag FROM replay_settings
         WHERE replay_id IN (SELECT id FROM replays) ORDER BY flag`,
        "flag",
      ),
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

  /** gamesUnknown answers which of `ids` the mirror has never recorded — the
   * question the cron asks before spending a detail fetch on any of them. It
   * is deliberately the games table alone: "known" means "already mirrored",
   * and an id the catalog happens to hold still needs its row here, or every
   * run would re-fetch it forever.
   *
   * One statement with one bound parameter per id; the caller passes a single
   * API page (24), so the list is small by construction. */
  gamesUnknown(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const known = new Set(
      this.ctx.storage.sql
        .exec(`SELECT id FROM games WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids)
        .toArray()
        .map((r) => r.id as string),
    );
    return ids.filter((id) => !known.has(id));
  }

  /** gamesInsert records mirrored games and indexes their players and settings
   * into the two derived tables. Upsert rather than plain insert so re-syncing
   * a game (a backfill, a later re-read) refreshes it instead of failing.
   *
   * The derived rows are written only for ids the CATALOG does not hold — see
   * indexRow: a published replay's entries are rebuilt from the capture that
   * was actually published, and a mirror row must not overwrite them with the
   * API's account of the same game. Returns the number of rows written. */
  gamesInsert(games: GameEntry[]): number {
    const sql = this.ctx.storage.sql;
    const now = Math.floor(Date.now() / 1000);
    for (const g of games) {
      sql.exec(
        `INSERT INTO games (id, start_unix, duration_sec, map, map_file, game_size, preset, player_count, players, settings, engine_version, game_version, synced_unix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           start_unix = excluded.start_unix,
           duration_sec = excluded.duration_sec,
           map = excluded.map,
           map_file = excluded.map_file,
           game_size = excluded.game_size,
           preset = excluded.preset,
           player_count = excluded.player_count,
           players = excluded.players,
           settings = excluded.settings,
           engine_version = excluded.engine_version,
           game_version = excluded.game_version,
           synced_unix = excluded.synced_unix`,
        g.id,
        g.startUnix,
        g.durationSec,
        g.map,
        g.mapFile,
        g.gameSize,
        g.preset,
        g.playerCount,
        g.players === null ? null : JSON.stringify(g.players),
        g.settings === null ? null : JSON.stringify(g.settings),
        g.engineVersion,
        g.gameVersion,
        now,
      );
      const owned = sql.exec(`SELECT 1 FROM replays WHERE id = ?`, g.id).toArray().length > 0;
      if (!owned) this.indexRow(g.id, g.players, g.settings);
    }
    return games.length;
  }

  /** jobInsert records fresh work as a pending ingest job. A "resim" carries
   * no streamKey (pass ""); it is queued through resimEnqueue below, which is
   * where the refusals live. */
  jobInsert(id: string, streamKey: string, gameId: string, kind: JobKind = "upload"): void {
    const now = Math.floor(Date.now() / 1000);
    this.ctx.storage.sql.exec(
      `INSERT INTO jobs (id, stream_key, game_id, kind, state, error, created_unix, updated_unix)
       VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      id,
      streamKey,
      gameId,
      kind,
      now,
      now,
    );
  }

  /** resimEnqueue takes a re-simulation request for one game, refusing it when
   * there is nothing to gain. Both checks and the insert happen in here, in one
   * RPC, so two people pasting the same link at the same moment cannot both
   * queue an hour of engine time.
   *
   * "in-catalog": the game is already published, so re-simulating it would
   * replace a capture that exists with one that mostly repeats it.
   * "duplicate": a re-sim of this game is already queued or running — the
   * caller gets that job back, which makes re-pasting a link harmless. */
  resimEnqueue(id: string, gameId: string): JobEnqueue {
    // `placeholder = 0`: a row that only exists because the game is being
    // worked on right now is not a reason to refuse — "already published" would
    // be a lie, and the duplicate check just below is the honest answer, which
    // hands back the job doing the work.
    const known = this.ctx.storage.sql
      .exec(`SELECT 1 FROM replays WHERE id = ? AND placeholder = 0`, gameId)
      .toArray();
    if (known.length > 0) return { status: "in-catalog", job: null };
    return this.jobAnnounce(id, gameId, "resim");
  }

  /** jobAnnounce records work a DAEMON found for itself, so that it has a job
   * row to be seen and reported on. It is resimEnqueue without the catalog
   * refusal, which is the whole difference and the reason it exists.
   *
   * The daemon's catalog scan looks for games whose only upload is one-sided —
   * a playing client's point of view — and re-simulates them for the full view.
   * Every one of those is IN the catalog by definition, so resimEnqueue would
   * refuse all of them; without this the work simply happened invisibly, an
   * hour at a time, with its progress and its timings going nowhere but the
   * daemon's own log on some other machine.
   *
   * Announcing is not queueing: the daemon is already doing this work, and the
   * row exists to carry its progress, its stats and its outcome. It still
   * dedupes on an ACTIVE job for the game, so two daemons scanning the same
   * catalog hand back the same row and the loser's claim is refused. A job that
   * already finished or failed does not block a fresh one — re-announcing is
   * how a scan retries a game after the daemon restarts. */
  jobAnnounce(id: string, gameId: string, kind: JobKind): JobEnqueue {
    const active = this.ctx.storage.sql
      .exec(
        `SELECT ${JOB_COLS} FROM jobs
         WHERE game_id = ? AND kind = ? AND state IN ('pending', 'processing')
         ORDER BY created_unix, id LIMIT 1`,
        gameId,
        kind,
      )
      .toArray();
    // A held-back job still blocks a new one — that is exactly what "will not
    // be picked up" means, and inserting a fresh row would walk straight around
    // it. It gets its own status so the paste box can say WHY nothing will
    // happen; a daemon treats anything but "queued" as not-its-work either way.
    if (active.length > 0) {
      const job = jobRow(active[0]);
      return { status: job.disabled ? "disabled" : "duplicate", job };
    }
    this.jobInsert(id, "", gameId, kind);
    return { status: "queued", job: this.jobGet(id) };
  }

  jobGet(id: string): IngestJob | null {
    const rows = this.ctx.storage.sql
      .exec(`SELECT ${JOB_COLS} FROM jobs WHERE id = ?`, id)
      .toArray();
    return rows.length === 0 ? null : jobRow(rows[0]);
  }

  /** jobsPending lists what a daemon of this kind should work on: every
   * pending job of that kind, plus "processing" ones whose worker apparently
   * died (no update for the kind's stale window), oldest first.
   *
   * The kind is required rather than defaulted because the two daemons are
   * different machines — a plain bringest needs no engine and could not run a
   * re-sim if it were handed one. */
  jobsPending(kind: JobKind): IngestJob[] {
    const window = kind === "resim" ? STALE_PROCESSING_RESIM_SEC : STALE_PROCESSING_SEC;
    const staleBefore = Math.floor(Date.now() / 1000) - window;
    return this.ctx.storage.sql
      .exec(
        `SELECT ${JOB_COLS} FROM jobs
         WHERE kind = ? AND disabled = 0
           AND (state = 'pending' OR (state = 'processing' AND updated_unix < ?))
         ORDER BY created_unix, id`,
        kind,
        staleBefore,
      )
      .toArray()
      .map(jobRow);
  }

  /** ensureCatalogPlaceholder puts a game that is being WORKED ON into the
   * catalog, so the list shows it while the work runs rather than only after
   * it lands. Called whenever a job enters "processing", by any route in.
   *
   * The row is marked `placeholder`, which says the obvious thing: there is
   * nothing to play yet. That is what the viewer keys "not openable" off —
   * inferring it from a missing rid would be wrong, since the Go server's own
   * rows have none and are perfectly playable. A publish clears the mark
   * (upsert writes placeholder = 0), and a job that ends without one takes the
   * row away again, so a failed re-sim leaves no dead entry behind.
   *
   * It seeds what it can from the games mirror — a row showing the map and the
   * players beats one showing five dashes — and re-indexes the derived tables
   * from that same data, because the catalog row it just made now OWNS those
   * entries (see indexRow). With nothing to seed from it indexes nothing: the
   * alternative, indexing null, would DELETE whatever the mirror had put there. */
  private ensureCatalogPlaceholder(gameId: string): void {
    const sql = this.ctx.storage.sql;
    if (sql.exec(`SELECT 1 FROM replays WHERE id = ?`, gameId).toArray().length > 0) return;
    const seed = sql
      .exec(
        `SELECT start_unix, duration_sec, map, game_size, player_count, players, settings
         FROM games WHERE id = ?`,
        gameId,
      )
      .toArray();
    const g = seed.length > 0 ? seed[0] : null;
    sql.exec(
      `INSERT INTO replays (id, start_unix, duration_sec, map, game_size, player_count, players, settings, placeholder, updated_unix)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      gameId,
      (g?.start_unix as number | null) ?? null,
      (g?.duration_sec as number | null) ?? null,
      (g?.map as string | null) ?? null,
      (g?.game_size as string | null) ?? null,
      (g?.player_count as number | null) ?? null,
      (g?.players as string | null) ?? null,
      (g?.settings as string | null) ?? null,
      Math.floor(Date.now() / 1000),
    );
    if (g !== null) {
      this.indexRow(
        gameId,
        g.players == null ? null : JSON.parse(g.players as string),
        g.settings == null ? null : JSON.parse(g.settings as string),
      );
    }
  }

  /** dropCatalogPlaceholder removes the row again when the work ends without
   * anything published — a failed re-sim, an upload that could not be packed.
   * A row a publisher has since written is not a placeholder any more and is
   * left alone, which is the normal ending: the daemon publishes (upsert
   * clears the mark) and only then reports done.
   *
   * The derived entries are deliberately NOT deleted with it: they were
   * copied from the games row, which is still there and still describes the
   * same game, so removing them would only make the mirror's own entries
   * disappear. */
  private dropCatalogPlaceholder(gameId: string): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM replays
       WHERE id = ? AND placeholder = 1
         AND NOT EXISTS (SELECT 1 FROM jobs WHERE game_id = ? AND state = 'processing')`,
      gameId,
      gameId,
    );
  }

  /** jobsOffer is what the daemon's poll actually gets: the pending work of
   * its kind and, when a re-sim daemon would otherwise go home empty-handed,
   * one job queued on the spot from the games mirror.
   *
   * Of the BACKFILL_WINDOW newest candidates it takes the one with the MOST
   * PLAYERS: an hour of engine time buys an 8v8 as cheaply as a duel, so
   * within a window of games that are all recent, size is what decides.
   *
   * The mirror knows thousands of games nobody has captured (see the games
   * table), and the re-sim daemon's other two work sources cannot reach them:
   * a requested job needs a person to paste a link, and the catalog scan looks
   * for one-sided UPLOADS, which by construction a never-uploaded game has
   * none of. So an idle poll picks the newest such game instead of idling.
   *
   * Only for "resim": an upload job is bytes somebody sent, and there is no
   * stream to invent for a game that was never uploaded.
   *
   * A candidate is a mirrored game with no catalog row AND NO JOB ROW AT ALL —
   * not merely no live one. Excluding done and errored jobs too is what stops
   * a game that fails to re-simulate from being handed out again on the very
   * next poll, forever, an hour of engine time at a time; a person can still
   * force a retry by pasting its link, which is exactly the existing story for
   * a failed request.
   *
   * It must also be UNMODDED: no tweakdefs/tweakunits slot set, which is
   * exactly what the settings' `mods` flag records. Note this rules out the
   * game modes that SHIP as tweak blobs — lava, zombies — which is the same
   * thing said twice, not an accident. A person who wants one of those
   * re-simulated can still paste its link; nothing refuses that.
   *
   * It backfills only into an EMPTY pending list, so at most one auto-queued
   * job is ever waiting: the next poll finds that job rather than making
   * another. The check and the insert are one RPC — the DO is single-threaded,
   * so two daemons polling together cannot both queue the same game.
   *
   * This makes a GET write, which is the deliberate cost of leaving the
   * daemon's protocol alone: a poll that returns a job it just created is
   * indistinguishable, to the daemon, from one that returns a job a person
   * queued a minute ago. */
  jobsOffer(kind: JobKind, newJobId: string): IngestJob[] {
    const pending = this.jobsPending(kind);
    if (pending.length > 0 || kind !== "resim") return pending;
    const candidate = this.ctx.storage.sql
      .exec(
        `SELECT id FROM (
           SELECT g.id AS id, g.player_count AS player_count, g.start_unix AS start_unix
           FROM games g
           WHERE NOT EXISTS (SELECT 1 FROM replays r WHERE r.id = g.id)
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.game_id = g.id)
             AND NOT EXISTS (SELECT 1 FROM replay_settings s WHERE s.replay_id = g.id AND s.flag = ?)
           ORDER BY g.start_unix IS NULL, g.start_unix DESC, g.id
           LIMIT ${BACKFILL_WINDOW}
         )
         -- Biggest game in that window; a game whose roster the API never gave
         -- goes last, and an exact tie goes to the newer one.
         ORDER BY player_count IS NULL, player_count DESC, start_unix DESC, id
         LIMIT 1`,
        // Read from the derived table rather than the row's settings JSON: the
        // flag index (flag, replay_id) makes it a seek, and a mirrored game
        // always owns its own entries there — a game the catalog owns instead
        // is excluded by the first clause anyway.
        SETTINGS_MODS_FLAG,
      )
      .toArray();
    if (candidate.length === 0) return [];
    this.jobInsert(newJobId, "", candidate[0].id as string, "resim");
    const job = this.jobGet(newJobId);
    return job === null ? [] : [job];
  }

  /** queuePage is the queue as a PERSON reads it (GET /api/queue): one page of
   * jobs, everything still in flight first — those are what the view exists to
   * answer for — then the most recently finished, newest first. Unlike
   * jobsPending it does not hide a fresh "processing" job: a daemon working
   * right now is exactly what the viewer wants to see, even though it is not
   * work to hand out.
   *
   * `total` and `active` are counted over the WHOLE table, not the page, so a
   * pager can say how much it is paging through and the menu's in-flight count
   * stays true on any page. */
  queuePage(limit: number, offset: number): { jobs: QueueJob[]; total: number; active: number } {
    const jobs = this.ctx.storage.sql
      .exec(
        // The jobs table knows a gameId and nothing else about the game, so the
        // duration and the team spec are joined on from whichever table knows
        // them: the catalog first (what was captured), the games mirror second
        // (what BAR published), which is what covers the re-sim of a game
        // nobody has uploaded — most of this queue.
        //
        // EVERY column in the ORDER BY is qualified, and has to be: `id` is in
        // all three tables and `updated_unix` is in two of them, so an
        // unqualified one is an ambiguous-column error rather than a wrong
        // answer.
        `SELECT ${JOB_COLS_J},
                COALESCE(r.duration_sec, g.duration_sec) AS game_duration_sec,
                COALESCE(r.game_size, g.game_size)       AS game_size
         FROM jobs j
         LEFT JOIN replays r ON r.id = j.game_id
         LEFT JOIN games   g ON g.id = j.game_id
         ORDER BY CASE WHEN j.state IN ('pending', 'processing') AND j.disabled = 0 THEN 0 ELSE 1 END,
                  j.updated_unix DESC, j.id
         LIMIT ? OFFSET ?`,
        limit,
        offset,
      )
      .toArray()
      .map(queueJobRow);
    // SUM over no rows is NULL, hence the coalesce.
    const counts = this.ctx.storage.sql
      .exec(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN state IN ('pending', 'processing') AND disabled = 0 THEN 1 ELSE 0 END), 0) AS active
         FROM jobs`,
      )
      .toArray()[0];
    return { jobs, total: Number(counts.total), active: Number(counts.active) };
  }

  /** jobClaim takes a job for a worker, refusing when someone else already
   * holds it: it transitions only from "pending", or from a "processing" that
   * has gone stale (the same predicate jobsPending hands work out on).
   *
   * jobUpdate below would do the transition unconditionally, which is right
   * for a completion report and for a heartbeat but not for taking work worth
   * an hour of engine time — two daemons polling the same round would both
   * think they had it. Returns false when the job is unknown or already held. */
  jobClaim(id: string, kind: JobKind): boolean {
    const window = kind === "resim" ? STALE_PROCESSING_RESIM_SEC : STALE_PROCESSING_SEC;
    // progress is cleared with the claim: whatever it says was reported by the
    // previous holder, and taking a stale job over means its last reading — a
    // percentage from a daemon that died — must not be shown as this run's.
    const cur = this.ctx.storage.sql.exec(
      `UPDATE jobs SET state = 'processing', error = NULL, progress = NULL, updated_unix = ?
       WHERE id = ? AND disabled = 0
         AND (state = 'pending' OR (state = 'processing' AND updated_unix < ?))`,
      Math.floor(Date.now() / 1000),
      id,
      Math.floor(Date.now() / 1000) - window,
    );
    if (cur.rowsWritten === 0) return false;
    const job = this.jobGet(id);
    if (job !== null) this.ensureCatalogPlaceholder(job.gameId);
    return true;
  }

  /** jobSamples is one job's whole healthcheck history, oldest first — the
   * series behind the queue page's charts. Empty for a job that never reported
   * (an upload, or anything from a daemon older than the healthcheck). */
  jobSamples(jobId: string): JobSample[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT at_unix, state, frame, percent, eta_sec, rss_bytes, swap_bytes, cpu_pct
         FROM job_samples WHERE job_id = ? ORDER BY at_unix`,
        jobId,
      )
      .toArray()
      .map((r) => ({
        atUnix: r.at_unix as number,
        state: r.state as string | null,
        frame: r.frame as number | null,
        percent: r.percent as number | null,
        etaSec: r.eta_sec as number | null,
        rssBytes: r.rss_bytes as number | null,
        swapBytes: r.swap_bytes as number | null,
        cpuPct: r.cpu_pct as number | null,
      }));
  }

  /** jobSampleRecord appends one healthcheck to the job's history.
   *
   * Every field is COERCED on the way in, which is not belt-and-braces: unlike
   * everything else that has ever been done with a JobProgress, these land in
   * typed SQL columns, and parseJobProgress is deliberately shallow because its
   * fields were only ever displayed. A daemon (or anything else that can reach
   * the open-ish job route) sending `{frame: {}}` would otherwise throw inside
   * the bind and turn a healthcheck into a 500.
   *
   * `at` is the WORKER's clock, taken from the same now the state transition
   * uses, so the time axis cannot be bent by a daemon with a skewed clock. */
  private jobSampleRecord(jobId: string, at: number, p: JobProgress): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO job_samples (job_id, at_unix, state, frame, percent, eta_sec, rss_bytes, swap_bytes, cpu_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, at_unix) DO UPDATE SET
         state = excluded.state, frame = excluded.frame, percent = excluded.percent,
         eta_sec = excluded.eta_sec, rss_bytes = excluded.rss_bytes,
         swap_bytes = excluded.swap_bytes, cpu_pct = excluded.cpu_pct`,
      jobId,
      at,
      typeof p.state === "string" ? p.state.slice(0, 64) : null,
      finite(p.frame),
      finite(p.percent),
      finite(p.etaSec),
      finite(p.rssBytes),
      finite(p.swapBytes),
      finite(p.cpuPct),
    );
    const n = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS n FROM job_samples WHERE job_id = ?`, jobId)
      .toArray()[0].n as number;
    if (n > MAX_JOB_SAMPLES) this.jobSampleThin(jobId);
  }

  /** jobSampleThin halves a job's series in place, keeping the first and last
   * sample and every other one between. The chart keeps its full time span at
   * half the resolution — which is the right thing to lose, unlike the start of
   * the run (dropping the oldest) or the end of it (refusing to record). */
  private jobSampleThin(jobId: string): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM job_samples WHERE job_id = ? AND at_unix IN (
         SELECT at_unix FROM (
           SELECT at_unix, ROW_NUMBER() OVER (ORDER BY at_unix) AS rn,
                  COUNT(*) OVER () AS total
           FROM job_samples WHERE job_id = ?
         ) WHERE rn % 2 = 0 AND rn <> total
       )`,
      jobId,
      jobId,
    );
  }

  /** jobSamplePrune drops the history of jobs that finished before `before`,
   * and of any job row that is gone entirely. Called from the cron, which is
   * the worker's only periodic hook; the table would otherwise be the one thing
   * here that grows without a rule. Returns how many rows it removed. */
  jobSamplePrune(before: number): number {
    const cur = this.ctx.storage.sql.exec(
      `DELETE FROM job_samples WHERE job_id IN (
         SELECT s.job_id FROM (SELECT DISTINCT job_id FROM job_samples) s
         LEFT JOIN jobs j ON j.id = s.job_id
         WHERE j.id IS NULL OR (j.state IN ('done', 'error') AND j.updated_unix < ?)
       )`,
      before,
    );
    return cur.rowsWritten;
  }

  private jobIsDisabled(id: string): boolean {
    const r = this.ctx.storage.sql.exec(`SELECT disabled FROM jobs WHERE id = ?`, id).toArray();
    return r.length > 0 && r[0].disabled === 1;
  }

  /** jobSetDisabled holds a job back, or lets it go again. Returns false when
   * the id is unknown.
   *
   * Disabling does two things, and the second is the one that is easy to miss:
   * nothing will be OFFERED the job (jobsPending, jobClaim and the mirror
   * backfill all skip it, and the backfill's "no job row at all" rule means the
   * game behind it stays out of the auto-queue for good), and a job that was
   * "processing" is RESET to pending. It has to be: disabling cannot reach into
   * a daemon on somebody else's machine and stop its engine, so the row would
   * otherwise sit at "processing" until the stale window expired and then be
   * handed straight back out. Its progress goes with it — a reading from a run
   * nobody is watching for any more describes nothing.
   *
   * The samples are deliberately kept: they are the record of work that really
   * did happen, and the charts are the reason anyone would look at a job they
   * had to turn off. */
  jobSetDisabled(id: string, disabled: boolean): boolean {
    const cur = this.ctx.storage.sql.exec(
      `UPDATE jobs SET disabled = ?,
              state = CASE WHEN ? = 1 AND state = 'processing' THEN 'pending' ELSE state END,
              progress = CASE WHEN ? = 1 THEN NULL ELSE progress END,
              updated_unix = ?
       WHERE id = ?`,
      disabled ? 1 : 0,
      disabled ? 1 : 0,
      disabled ? 1 : 0,
      Math.floor(Date.now() / 1000),
      id,
    );
    if (cur.rowsWritten === 0) return false;
    // A placeholder row exists only because a game is being worked on; with the
    // job stopped there is nothing being worked on and nothing published, so it
    // must not be left in the replay list as an un-openable entry. (The guard
    // inside checks no OTHER job is processing the same game.)
    const job = this.jobGet(id);
    if (job !== null && disabled) this.dropCatalogPlaceholder(job.gameId);
    return true;
  }

  /** jobUpdate transitions a job's state (daemon healthcheck / completion
   * report). Returns false when the job id is unknown.
   *
   * `stats` is COALESCEd, unlike error: a healthcheck reports none and must not
   * wipe what a previous report recorded, and there is nothing a daemon could
   * usefully mean by "the stats are now nothing".
   *
   * `progress` is COALESCEd the same way WHILE the job runs — an older daemon,
   * or a bare claim, simply carries none — and then CLEARED by the terminal
   * state, which is the one place its meaning inverts: progress describes work
   * in flight, so a finished row keeping its last reading would show "43%,
   * 12 minutes left" forever. From then on the stats are the record. */
  jobUpdate(
    id: string,
    state: "processing" | "done" | "error",
    error: string | null,
    stats: JobStats | null = null,
    progress: JobProgress | null = null,
  ): boolean {
    // One clock reading for the row and its sample, so a beat's point on the
    // chart is stamped with the same moment the row says it was updated.
    const now = Math.floor(Date.now() / 1000);
    // A daemon that was mid-run when the job was disabled keeps beating for as
    // long as its engine runs — disabling does not (and cannot) stop it. Its
    // HEARTBEATS are ignored, or they would put the row straight back into
    // "processing" and undo the reset a second after it happened. Its terminal
    // report is still taken: the work happened, and what came of it is worth
    // recording even though nobody wanted it any more.
    if (state === "processing" && this.jobIsDisabled(id)) return true;
    const cur = this.ctx.storage.sql.exec(
      `UPDATE jobs SET state = ?, error = ?, stats = COALESCE(?, stats),
              progress = CASE WHEN ? = 'processing' THEN COALESCE(?, progress) ELSE NULL END,
              updated_unix = ?
       WHERE id = ?`,
      state,
      error,
      stats === null ? null : JSON.stringify(stats),
      state,
      progress === null ? null : JSON.stringify(progress),
      now,
      id,
    );
    if (cur.rowsWritten === 0) return false;
    // The live reading is overwritten in place above; here it is also KEPT, so
    // the run has a history to chart afterwards. Only while the job is running,
    // and only when there is something to record — a terminal report carries no
    // progress, and the beats already recorded are the run's record.
    if (state === "processing" && progress !== null) this.jobSampleRecord(id, now, progress);
    // The catalog follows the job either way: into the list when work starts
    // (this is the other door into "processing" — a daemon that reports it
    // without claiming, and every heartbeat, which is harmless since the row
    // is only ever created once), and out of it when work ends with nothing
    // published.
    const job = this.jobGet(id);
    if (job !== null) {
      if (state === "processing") this.ensureCatalogPlaceholder(job.gameId);
      else this.dropCatalogPlaceholder(job.gameId);
    }
    return true;
  }
}

/** queueJobRow is jobRow plus what the join found out about the game. The
 * `game` field is null only when NEITHER table knows the id — a drag&drop
 * upload of a private lobby the BAR API never indexed, say. */
function queueJobRow(r: Record<string, unknown>): QueueJob {
  const durationSec = (r.game_duration_sec as number | null) ?? null;
  const gameSize = (r.game_size as string | null) ?? null;
  const game: QueueGame | null =
    durationSec === null && gameSize === null ? null : { durationSec, gameSize };
  return { ...jobRow(r), game };
}

function jobRow(r: Record<string, unknown>): IngestJob {
  return {
    id: r.id as string,
    streamKey: r.stream_key as string,
    gameId: r.game_id as string,
    // The ALTER backfills every pre-existing row to 'upload', so this is
    // belt-and-braces — but a job read as kind-less would be handed to the
    // wrong daemon, which is not a failure worth leaving to the schema.
    kind: ((r.kind as JobKind | null) ?? "upload") as JobKind,
    state: r.state as IngestJob["state"],
    error: r.error as string | null,
    // Stored as JSON text. A row written before the column, or one whose
    // daemon never reported, has none — and a blob that somehow does not parse
    // is not worth failing a queue read over.
    stats: parseStored(r.stats as string | null, parseJobStats),
    // Only ever set while the job is running (jobUpdate clears it on the
    // terminal state), so null here is the normal case, not a gap.
    progress: parseStored(r.progress as string | null, parseJobProgress),
    disabled: (r.disabled as number | null) === 1,
    createdUnix: r.created_unix as number,
    updatedUnix: r.updated_unix as number,
  };
}

/** finite coerces one wire-supplied field to something a numeric SQL column
 * will accept. Anything that is not a real number — a string, an object, NaN,
 * a missing field — becomes NULL, which is exactly what "the daemon did not
 * measure this" already means everywhere else here. */
function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** parseStored re-reads one of the jobs table's JSON columns through the same
 * validator the wire goes through. A column that is null, or holds a blob that
 * somehow does not parse, yields null rather than failing the read: these are
 * shown, not computed with, and a queue page is not worth losing over one. */
function parseStored<T>(raw: string | null, parse: (v: unknown) => T | null): T | null {
  if (raw == null) return null;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
