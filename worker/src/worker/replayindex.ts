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

import type { GameEntry, GameListRow, GamesCursor } from "./games";
import { APP_JOB_STALE_SEC, parseJobErrorKind, parseJobProgress, parseJobStats } from "./jobs";
import type {
  IngestJob,
  JobErrorKind,
  JobKind,
  JobPublish,
  JobProgress,
  JobSample,
  JobStats,
  QueueGame,
  QueueJob,
} from "./jobs";
import { LOBBY_MATCH_EARLY_SLACK_SEC, LOBBY_MATCH_WINDOW_SEC, lobbyNearMisses, pickLobbyMatches } from "./teiserver";
import type { LobbyDetails, LobbyEndUpdate, LobbyMatchResult, LobbyNearMiss, LobbyObservation, MatchGame, MatchLobby, OpenLobby } from "./teiserver";
import {
  LAVA_GAME_SIZE,
  SETTINGS_LAVA_FLAG,
  SETTINGS_MODS_FLAG,
  derivePlayerCount,
  emptyFilter,
  isMainRid,
  mergeUploads,
  wantsFullView,
} from "./replayentry";
import type { CatalogTeam, ReplayEntry, ReplayFilter, UploadRef } from "./replayentry";

export type {
  IngestJob,
  JobErrorKind,
  JobKind,
  JobProgress,
  JobSample,
  JobStats,
  QueueGame,
  QueueJob,
} from "./jobs";

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

/** How many of the most recently ENDED eligible mirrored games the backfill
 * chooses from. It picks the best game in that window (modded first, then
 * biggest), not the newest one: an 8v8 is worth far more to have than the 1v1
 * that happened to finish a minute later, and re-simulating either costs the
 * same hour of somebody's machine.
 *
 * END time, not start time, because a game can only be mirrored once it is
 * over: ordered by start, an hour-long game entered the mirror already buried
 * under everything that started after it — on BAR's rate that was ~80 games,
 * which put a 59-minute modded 16-player FFA permanently outside a small
 * window while three-minute duels sailed through it. Ordered by when they
 * ended, every game is born at the head of the walk.
 *
 * 200 rather than 20 for the same reason: the preference ranking is only as
 * good as the window it ranks over, and a daemon that finishes one job an
 * hour faces ~80 new games each time it looks — a 20-game window meant "the
 * last 15 minutes", which no rare game survives. 200 is a couple of hours of
 * BAR's output: wide enough that a modded game stays electable for the whole
 * gap between two polls, still a bounded walk (see the rowcost test).
 *
 * The window is over CANDIDATES, not over the mirror's last 200 rows. Those
 * would drain: every game handed out gains a job row and stops being eligible,
 * so after two hundred of them a window over raw recency would be permanently
 * empty and the daemon would idle with thousands of games still to do. */
const BACKFILL_WINDOW = 200;

/** How long the backfill rests after coming up EMPTY. The daemon polls every
 * 10 seconds and this scan is the only expensive thing on that path, so the
 * state to bound is the one it can sit in indefinitely: nothing to hand out,
 * asked again ten seconds later, with the mirror no different than it was.
 *
 * Only the empty answer rests. A scan that QUEUES a game is not repeated —
 * the daemon takes the job and stops asking for the length of the run, and
 * the polls in between are answered by jobsPending out of an index — so
 * resting after one buys nothing and costs exactly what it saves: the host
 * sits idle until the grid ticks. That was measured on the deployment, where
 * jobs landing on a strict five-minute spacing each took ninety seconds; the
 * assumption behind the first version of this — that a queued job is an hour
 * of work, so five minutes of granularity is invisible — is not true of a
 * host running the patched engine over ordinary games.
 *
 * A MINUTE, which is the cron's own period: an empty scan can only start
 * finding something again when the mirror gains a game, and that is the
 * fastest it can happen. Waiting longer just leaves an engine host idle in
 * front of work that has arrived. It costs ~1440 scans a day in the idle
 * case, which at the size bound above is a fraction of the daily rows-read
 * allowance — see ROW BUDGET in CLAUDE.md. */
const BACKFILL_COOLDOWN_SEC = 60;

/** The re-sim backfill's PRIORITY lookup: how far back it will reach for an
 * 8v8 lava game, and how long it rests when there is none.
 *
 * WHY A SECOND LOOKUP AT ALL. The general backfill ranks over the
 * BACKFILL_WINDOW most recently ended candidates, and that window is the whole
 * problem: a host that publishes one game an hour against a mirror gaining
 * ~2000 a day never empties the head of the list, so a game that is not among
 * the 200 newest candidates when it is looked at is never looked at again.
 * Measured on the deployment, the two 8v8 lava games with no capture sat at
 * candidate ranks 1621 and 1634 — eight windows deep, and unreachable by any
 * amount of waiting. Preferring lava inside the existing ranking would not
 * have found them either, for the same reason: the ranking only ever sees the
 * window. So this is a lookup of its own, over a window defined by TIME rather
 * than by rank, asked FIRST.
 *
 * 24 HOURS because that is the horizon over which a lava game is still worth
 * the hour of engine time, and because a day of BAR's output is a walk of
 * fixed size (~2000 games) — one that does not grow as the mirror does, unlike
 * a seek through every lava game ever mirrored, which is the shape the ROW
 * BUDGET rules out for anything on the 10-second poll path.
 *
 * FIVE MINUTES of rest on the empty answer, where the general backfill rests
 * one. The empty answer is the common one — an 8v8 lava game finishes a couple
 * of times an hour, not a couple of times a minute — and it is the answer that
 * repeats: an idle daemon would otherwise walk a day of the mirror every ten
 * seconds to be told the same thing. Five minutes costs nothing anyone can
 * see (the job it is looking for takes an hour to run) and keeps the idle case
 * to ~288 walks a day. As with the general backfill, ONLY the empty answer
 * rests: a walk that queues a game is not repeated, because the daemon leaves
 * with it. */
/** gamesPage's filters (see its note): the rows one filtered page may read
 * before it answers short with a cursor to keep searching; the player counts
 * and the duration minutes walked one branch each (the rest is one branch);
 * and the id prefix long enough to walk the primary key rather than check
 * each row (4 hex characters = 1/65536 of the mirror). */
const GAMES_SCAN_MAX = 2000;
const GAMES_COUNT_BRANCH_MAX = 32;
const GAMES_DURMIN_BRANCH_MAX = 90;
const GAMES_ID_WALK_MIN = 4;

const LAVA_WINDOW_SEC = 24 * 3600;
const LAVA_COOLDOWN_SEC = 300;

/** The lava RETRY lookup (lavaRetryCandidate): how far back a failed job
 * still counts, and how long the lookup rests on an empty answer.
 *
 * A failed re-sim is never offered again by the scans above — a game that
 * cannot re-simulate would otherwise come back every poll — which is right
 * for a game that is broken and wrong for one that ran out of MEMORY: "oom"
 * says the HOST was too small (an 8v8 lava game wants ~6 GB resident, and a
 * 16 GB box runs what an 8 GB one cannot), so the same job is worth handing
 * to a daemon with more memory than the one that failed. On 2026-10-17 that
 * was 19 of the 29 lava 8v8s of four days with no capture: every one of them
 * queued within the hour, run first, and lost for good on the one 8 GB host
 * that was running. (The other 10 failed on BAR's widget sandbox before
 * widget 1.11.1; failures other than "oom" are not retried automatically.)
 *
 * Two weeks bounds what the lookup reads (failed jobs, through jobs_failed),
 * and is also past the point where a late capture still matters to anyone.
 * The rest is per MEMORY SIZE (a GiB bucket) because the answer is: a small
 * host finding nothing it can retry says nothing about a big one. */
const LAVA_RETRY_WINDOW_SEC = 14 * 24 * 3600;
const LAVA_RETRY_COOLDOWN_SEC = 300;

/** How far back the lava sync will still offer a game it has never offered
 * (see gamesLavaPending). Its whole job is to bound that query, and the first
 * run after lava_offered_unix was added — when every lava game in the mirror
 * is unoffered and nearly all of them are long since stored on the other side.
 * A week is well past the point where lavabalance could rate a late arrival
 * anyway: its fold is forward-only, so a game behind the head is stored
 * unranked whenever it turns up. */
const LAVA_OFFER_HORIZON_SEC = 7 * 24 * 3600;

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
  "id, stream_key, game_id, kind, state, error, error_kind, stats, progress, disabled, note, " +
  "install_id, parent_id, created_unix, updated_unix";

/** The same columns qualified to `j`, for the one query that joins the jobs
 * table against the two that know anything about a game. Derived from JOB_COLS
 * rather than written out again, so the two cannot drift — and SQLite names a
 * result column after the column, not the qualifier, so jobRow still finds
 * every one of them. */
const JOB_COLS_J = JOB_COLS.split(", ")
  .map((c) => `j.${c}`)
  .join(", ");

/** One job plus what the catalog or the games mirror knows about its game
 * (queuePage, jobsByInstall; queueJobRow reads it). */
const QUEUE_SELECT = `
      SELECT ${JOB_COLS_J},
             COALESCE(r.duration_sec, g.duration_sec) AS game_duration_sec,
             COALESCE(r.game_size, g.game_size)       AS game_size,
             COALESCE(r.start_unix, g.start_unix)     AS game_start_unix,
             COALESCE(r.map, g.map)                   AS game_map,
             g.map_file                               AS game_map_file,
             COALESCE(r.settings, g.settings)         AS game_settings,
             -- Whether there is a replay to OPEN: a catalog row that is not a
             -- placeholder for work in flight. The queue's Game cell links
             -- only then (the page's own replay list is a filtered page and
             -- cannot answer this for an arbitrary job).
             (r.id IS NOT NULL AND r.placeholder = 0) AS game_published,
             -- The publish of an app run's .brp (the upload job naming this
             -- one as its parent), shown INSIDE the app's row rather than as
             -- a row of its own. A seek on jobs_parent; the newest if the app
             -- ever sent two.
             (SELECT json_object('id', c.id, 'state', c.state, 'error', c.error,
                                 'stats', json(c.stats), 'updatedUnix', c.updated_unix)
              FROM jobs c WHERE c.parent_id = j.id
              ORDER BY c.created_unix DESC LIMIT 1)   AS publish
      FROM jobs j
      LEFT JOIN replays r ON r.id = j.game_id
      LEFT JOIN games   g ON g.id = j.game_id`;

/** What came of asking for a job: a fresh row, the one that already covers the
 * game, or a refusal. "disabled" and "in-catalog" are both "nothing will
 * happen", said precisely enough for the caller to explain it. */
export type JobEnqueue = {
  status: "queued" | "duplicate" | "disabled" | "in-catalog";
  job: IngestJob | null;
  /** "in-catalog" only: the revision holding the game's full view, so the
   * caller can read which .brp format version it was simulated at. */
  rid?: string | null;
};

/** What came of a public re-sim request (resimRequest). */
export type ResimRequest = {
  status: "queued" | "duplicate" | "disabled" | "published" | "full";
  job: IngestJob | null;
};

/** How long a MATCHED lobby observation is kept before pruning. Its payload
 * — the name — lives on the games row by then, so the observation is only a
 * record of how the match was made. Unmatched observations are kept forever,
 * by request: they are the evidence for why a game never got its name. A
 * game reaches rts-api within the hour of ending, so 48h is generous slack,
 * not the expected wait. */
const LOBBY_MATCHED_KEEP_SEC = 48 * 3600;

/** How far back the FIRST match run after a restart looks for arrivals. It
 * exists only to give lobbiesMatch's watermark a starting value: with none, a
 * fresh deployment would either consider the whole mirror or nothing at all.
 * An hour is comfortably more than the minute the cron would have covered and
 * far less than the window a full scan implies. */
const LOBBY_MATCH_BACKLOG_SEC = 3600;

/** progressPercent reads a whole-number 0-100 out of a jobs row's progress
 * JSON, for the catalog pill. Anything else — no progress reported yet, a
 * phase with nothing to measure, malformed JSON — is null, never a guess:
 * the pill then says "processing" without a number. */
function progressPercent(progressJSON: unknown): number | null {
  if (typeof progressJSON !== "string") return null;
  try {
    const p = JSON.parse(progressJSON) as { percent?: unknown };
    return typeof p.percent === "number" && Number.isFinite(p.percent)
      ? Math.max(0, Math.min(100, Math.round(p.percent)))
      : null;
  } catch {
    return null;
  }
}

/** Version of the DERIVED data (player_count + the replay_settings index
 * table). Rows carry no derivation of their own — it is recomputed from the
 * replays row — so bumping this runs a one-time pass on the next wake
 * (ensureDerived holds the CURRENT bump's work; a new version replaces that
 * block with its own — CUMULATIVELY, when the versions between never shipped
 * separately, since a deployed database jumps straight from its stamp to the
 * current one). v1 backfilled rows that predate the derived data; v2 seeded
 * unique_values('maps') from the catalog's existing rows; v3 added the
 * jobs_count seed (and re-runs the v2 seed, which never deployed on its own —
 * both are idempotent recomputes). */
const DERIVED_VERSION = 3;

/** Version of the SCHEMA itself, stamped into the schema_version table by the
 * migration that produced it. schemaCurrent reads this one row to decide
 * whether the DDL needs to run at all — a read, where the DDL statements are
 * write-classified even as no-ops. BUMP THIS whenever SCHEMA_DDL, INDEX_DDL
 * or ADDED_COLUMNS change, or the change never reaches a deployed database. */
const SCHEMA_VERSION = 10;

/** Everything migrateSchema creates, split from the code so schemaCurrent can
 * scan the same text it executes (one source, nothing to drift). */
const SCHEMA_DDL = `
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
        error_kind   TEXT,
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

      -- Derived index table behind the settings filter. Rebuilt from the
      -- replays row on every write, never edited in place, so it cannot
      -- drift from the JSON column it comes from. Filtering on a flag means
      -- "does this row have one", an EXISTS answered by its index. (Its
      -- sibling replay_players is GONE: keeping the mirror's rosters indexed
      -- cost ~48 rows written per mirrored game — the write half of the
      -- 2026-08-23 outage — and the player filter and facets now read the
      -- roster JSON on the catalog rows directly, a bounded scan of a small
      -- table on a human-initiated query.)
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
      -- Small maintained lists, one row per kind, each value a JSON array.
      -- The one row today is key='maps': every distinct map in the CATALOG
      -- (mirror games deliberately excluded — their maps have nothing
      -- listable behind them). Maintained by upsert as replays are published
      -- and served by mapNames() behind a one-minute in-memory cache, so the
      -- filter bar's combobox costs one row read a minute where the facets
      -- endpoint it replaces ran DISTINCT over the whole catalog per call.
      CREATE TABLE IF NOT EXISTS unique_values (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- One row: the SCHEMA_VERSION the last completed migration stamped.
      -- Its absence is itself the signal (schemaCurrent): a database from
      -- before the stamp, or a fresh one, answers "no such table" to a read
      -- and that means "migrate". Deliberately its own table rather than a
      -- schema_meta key so that first read needs no other table to exist.
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
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
      -- Nothing reads this yet. It is here because the query the mirror exists
      -- to answer is "the newest games of this kind", and adding it now costs
      -- one line where adding it to a full table later costs a rebuild.
      CREATE INDEX IF NOT EXISTS games_preset ON games (preset, start_unix DESC);

      -- The teiserver web session behind the lobby poll (teiserver.ts): the
      -- cookie jar as JSON, exactly one row, so a cron tick reuses the
      -- Guardian token instead of logging in every minute. The CREDENTIALS
      -- are not here — they stay wrangler secrets; this is only the session
      -- they buy, which teiserver invalidates on its own schedule.
      CREATE TABLE IF NOT EXISTS teiserver_session (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        cookies      TEXT NOT NULL,
        updated_unix INTEGER NOT NULL
      );
      -- One row per OBSERVED lobby-game: opened the first tick a lobby is
      -- seen in progress (started_unix back-dated by the page's running
      -- clock), closed when it stops being — OR when it matches, whichever
      -- comes first: a matched game has certainly ended, and retiring the row
      -- then is what lets the next tick open a fresh one for the game the
      -- lobby is running by now, even when back-to-back games never let it
      -- leave the in-progress set. Eventually each row matches the rts-api
      -- game it was — which is the only place a lobby NAME can come from,
      -- since BAR's published history does not carry one. Keyed by
      -- (lobby_id, started_unix) because lobby ids are reused game after
      -- game: the row is the GAME as this lobby hosted it, so name, map,
      -- roster and matched_game_id are all per-game, and a lobby renamed
      -- between games contributes each game's then-current name.
      -- players holds the non-spectator roster captured at the start
      -- (spectators churn too much to be a matching signal); NULL means the
      -- roster page could not be fetched at that moment, which never comes
      -- back.
      CREATE TABLE IF NOT EXISTS lobbies (
        lobby_id        INTEGER NOT NULL,
        started_unix    INTEGER NOT NULL,
        name            TEXT NOT NULL,
        map             TEXT,
        players         TEXT,
        player_count    INTEGER,
        ended_unix      INTEGER,
        matched_game_id TEXT,
        PRIMARY KEY (lobby_id, started_unix)
      );
      CREATE INDEX IF NOT EXISTS lobbies_started ON lobbies (started_unix);
    `;

// // Filter indexes. Created after the ALTERs because one of them indexes a
// column the ALTERs may have just added.
const INDEX_DDL = `
      CREATE INDEX IF NOT EXISTS replays_map   ON replays (map);
      CREATE INDEX IF NOT EXISTS replays_count ON replays (player_count);
      CREATE INDEX IF NOT EXISTS replays_dur   ON replays (duration_sec);
      CREATE INDEX IF NOT EXISTS jobs_kind     ON jobs (kind, state, updated_unix);
      -- Every catalog read asks "is a job processing this game", once per row.
      CREATE INDEX IF NOT EXISTS jobs_game     ON jobs (game_id, state);

      -- The cron's reads, all three of which used to be full table scans a
      -- minute (see the note on BACKFILL_COOLDOWN_SEC: rows read are the
      -- currency here, and these tables only grow).
      --
      -- games_synced is what makes the lobby match ARRIVAL-DRIVEN: it looks at
      -- the games mirrored since the last run instead of every game inside the
      -- oldest open observation's time window.
      CREATE INDEX IF NOT EXISTS games_synced   ON games (synced_unix);
      -- The END-TIME order every games walk reads in (the Games listing, the
      -- re-sim backfill, the lava lookups): most recently ENDED first, which is
      -- ARRIVAL order — a game is mirrored only once it is over. player_count
      -- rides along so the backfill's walk never touches the games table and
      -- the id tiebreak needs no sort. It replaces games_backfill_end, the same
      -- index over the EXPRESSION start_unix + COALESCE(duration_sec, 0),
      -- which end_unix now stores.
      CREATE INDEX IF NOT EXISTS games_end ON games (end_unix DESC, id, player_count);
      -- The Games listing's filters, each an equality the walk can seek on and
      -- then read in end order (gamesPage): one map; one player count per
      -- branch of a range; one MINUTE of duration per branch of a range (the
      -- filter's own granularity — a range over raw seconds could not be read
      -- in end order without sorting every game in it).
      CREATE INDEX IF NOT EXISTS games_map_end    ON games (map, end_unix DESC, id);
      CREATE INDEX IF NOT EXISTS games_count_end  ON games (player_count, end_unix DESC, id);
      CREATE INDEX IF NOT EXISTS games_durmin_end ON games ((duration_sec / 60), end_unix DESC, id);
      DROP INDEX IF EXISTS games_backfill_end;
      DROP INDEX IF EXISTS games_backfill;
      DROP INDEX IF EXISTS games_start;
      -- See the replay_settings note in SCHEMA_DDL: the roster index table is
      -- gone, and dropping it here (one schema statement) is what sheds the
      -- ~100k mirror roster rows a row-by-row DELETE could not afford.
      DROP TABLE IF EXISTS replay_players;
      -- queuePage's settled half: every job no longer in flight, most
      -- recently updated first. PARTIAL, and deliberately over exactly the
      -- rows a heartbeat never touches: an active job's updated_unix moves
      -- every 10 seconds, so indexing it here would cost an index rewrite
      -- per beat, where a settled job lands in this index once, when it
      -- ends. The settled query's WHERE must repeat this clause TEXTUALLY —
      -- the planner only takes a partial index when the query's own WHERE
      -- provably implies the index's, and an identical expression is the
      -- proof it accepts (the rowcost test is the guard).
      CREATE INDEX IF NOT EXISTS jobs_settled ON jobs (updated_unix DESC, id)
        WHERE state NOT IN ('pending', 'processing') OR disabled != 0;
      -- PARTIAL indexes, because the two questions asked of the lobbies
      -- table every minute are about the handful of rows in a state, over
      -- a table that keeps every unmatched observation forever: which
      -- observations are still open, and which matched ones are old
      -- enough to drop.
      -- The lava retry lookup (lavaRetryCandidate): failed jobs, newest
      -- first. PARTIAL, over the only rows the lookup can want, so its walk
      -- costs the failures in its window and not the whole queue; its WHERE
      -- repeats this clause textually, like jobs_settled's.
      CREATE INDEX IF NOT EXISTS jobs_failed ON jobs (created_unix DESC)
        WHERE state = 'error';
      -- Every job one FogOfWar.exe install made (GET /api/admin/queue?install=),
      -- newest first. PARTIAL: only the app's jobs carry an install id.
      CREATE INDEX IF NOT EXISTS jobs_install ON jobs (install_id, created_unix DESC)
        WHERE install_id IS NOT NULL;
      -- The upload job publishing an app run's .brp, found from the run's
      -- row (QUEUE_SELECT's publish). PARTIAL: only those uploads have one.
      CREATE INDEX IF NOT EXISTS jobs_parent ON jobs (parent_id, created_unix DESC)
        WHERE parent_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS lobbies_open    ON lobbies (lobby_id, started_unix)
        WHERE ended_unix IS NULL;
      CREATE INDEX IF NOT EXISTS lobbies_matched ON lobbies (started_unix)
        WHERE matched_game_id IS NOT NULL;
    `;

/** Columns added to tables that already existed in deployments (SQLite has no
 * ADD COLUMN IF NOT EXISTS; a duplicate-column error just means the schema is
 * already current). schemaCurrent checks each entry's column name against the
 * table's stored CREATE statement (an ALTER rewrites it), so the name must not
 * also appear in a comment inside that table's CREATE. */
const ADDED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  // The jobs table predates the re-sim requests, so its rows are all
  // uploads; the DEFAULT is what says so, for the existing rows and for
  // every daemon that still POSTs without naming a kind.
  ["jobs", "kind TEXT NOT NULL DEFAULT 'upload'"],
  // Nullable, unlike kind: a job finished before the daemon reported stats
  // has none, and there is nothing to infer.
  ["jobs", "stats TEXT"],
  // The running job's live self-report. Nullable and, unlike stats,
  // deliberately EMPTY most of the time: jobUpdate clears it the moment the
  // job reaches a terminal state, because progress describes work in flight
  // and a finished row showing "simulating, 43%" would be a lie.
  ["jobs", "progress TEXT"],
  // Held back by hand from the queue page. NOT NULL with a default, so every
  // row that predates it reads as enabled, which is what they all were.
  ["jobs", "disabled INTEGER NOT NULL DEFAULT 0"],
  // What kind of failure, for the failures the daemon can name. Nullable: it
  // is null for every job that has not failed and for every failure with no
  // name, which is most of them.
  ["jobs", "error_kind TEXT"],
  // A word from the worker about why the row looks the way it does, e.g. a
  // pasted re-sim of a game already simulated, recorded disabled. Nullable:
  // almost no job has one.
  ["jobs", "note TEXT"],
  // The FogOfWar.exe install behind an "app" job and the upload of its .brp.
  // Nullable: nothing bringest does has one.
  ["jobs", "install_id TEXT"],
  // The "app" job whose .brp an upload job publishes. Such an upload is part
  // of that run: the queue shows it inside the app's row, not as its own.
  ["jobs", "parent_id TEXT"],
  // Added after the other sample columns: a run's remaining-time estimate was
  // reported from the start but only ever overwritten in place, so the rows
  // written before this have none and chart as a gap.
  ["job_samples", "eta_sec REAL"],
  // Same story: reported from the start of the healthcheck but only ever
  // shown live, so rows written before this chart as a gap.
  ["job_samples", "swap_bytes INTEGER"],
  // The lobby the game was played under (lobbiesMatch below). Deliberately
  // NOT in gamesInsert's upsert list: a later re-sync of the game knows
  // nothing about lobbies and must not erase what the match wrote.
  ["games", "lobby_name TEXT"],
  ["games", "lobby_id INTEGER"],
  // The full lobby detail at observation time (teiserver.ts LobbyDetails
  // JSON: locked/passworded/counts from the index page, the per-player
  // team/party/rating/bonus/faction roster from the show page). One blob
  // like jobs.stats — consumer-facing, nothing filters on it in SQL. On
  // lobbies it is what the observation recorded; on games it is COPIED by
  // lobbiesMatch in the same write-once UPDATE as lobby_name, because a
  // matched observation is pruned after 48h and match time is the only
  // chance. Like the two above, NOT in gamesInsert's upsert list.
  ["lobbies", "lobby_details TEXT"],
  // lobbySig (map | player count) of the index row as last recorded for an
  // OPEN observation; a tick that sees a different one re-reads the show page
  // and stores the lobby's state as lobby_details.end (lobbiesUpdate). NULL
  // on observations from before it, which then count as changed once.
  ["lobbies", "seen_sig TEXT"],
  ["games", "lobby_details TEXT"],
  // When this game was handed to lavabalance (lavaMarkOffered), NULL until it
  // has been. It is the lava sync's whole memory, and the reason the sync now
  // has any: the watermark it derived instead came from lavabalance's newest
  // STORED game, so games lavabalance declines — most modded ones, since its
  // classifier wants lava tweaks — sat in front of the queue forever. See
  // gamesLavaPending. Like the lobby columns, NOT in gamesInsert's upsert list:
  // a re-sync of a game says nothing about whether it was offered.
  ["games", "lava_offered_unix INTEGER"],
  // When the game ENDED: start_unix + COALESCE(duration_sec, 0), NULL with no
  // start. Stored rather than derived per read because it is what the Games
  // listing sorts and filters by, and a plain column is what composite indexes
  // (games_map_end, games_count_end, games_durmin_end) can lead with or
  // follow. gamesInsert writes it with the two it comes from; migrateSchema
  // backfills the rows from before it.
  ["games", "end_unix INTEGER"],
  ["replays", "settings TEXT"],
  ["replays", "rid TEXT"],
  ["replays", "players TEXT"],
  ["replays", "uploader_ally INTEGER"],
  ["replays", "uploads TEXT"],
  ["replays", "view TEXT"],
  ["replays", "player_count INTEGER"],
  // The uploader-widget build behind the current revision. Three columns
  // rather than one JSON blob because the whole point is to be able to ask
  // "which widget builds are in the wild" / "which replays came from the
  // build with that bug" in SQL, over the catalog, without opening a blob
  // per row. The per-revision history lives in uploads[] (mergeUploads).
  ["replays", "widget_version TEXT"],
  ["replays", "widget_sha TEXT"],
  ["replays", "widget_date TEXT"],
  // 1 = this row is a PIPELINE placeholder: it exists so a game being
  // worked on shows up in the list, and nothing has been published for it
  // yet. It is what makes a row un-openable in the viewer, and the only
  // kind of row the pipeline ever deletes.
  ["replays", "placeholder INTEGER NOT NULL DEFAULT 0"],
];

/** How long mapNames' in-memory copy of the maps list is served before the
 * unique_values row is read again. Every write path refreshes the copy, so
 * the TTL is a backstop against anything else touching the table, not the
 * consistency mechanism. */
const MAPS_CACHE_MS = 60_000;

/** The schema_meta key holding how many rows the jobs table has. Maintained —
 * incremented by jobInsert, seeded once by the derived backfill — because a
 * COUNT(*) is O(table) in rows read even over an index, the jobs table only
 * grows (nothing ever deletes a job row; the dedupe rules depend on the
 * history), and queuePage needs the number on every read. Sound precisely
 * BECAUSE nothing deletes: the count is monotonic, so one seed plus an
 * increment per insert can never drift. */
const JOBS_COUNT_KEY = "jobs_count";

/** Escape a string for use inside a LIKE pattern with ESCAPE '\\':
 * backslash first covers the escapes it is about to add, then the wildcards. */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A single call reading or writing more rows than this logs itself (see
 * installSqlAccounting). Set well above every bound the rowcost test asserts,
 * so a warning means a cost that suite would fail on — a new scan, live. */
const SQL_WARN_ROWS_READ = 5000;
const SQL_WARN_ROWS_WRITTEN = 200;

export class ReplayIndex extends DurableObject<Env> {
  /** How many samples each live job has, so a healthcheck does not have to
   * COUNT them to find out. IN MEMORY on purpose: it is a cache of something
   * the table already knows, it costs nothing to lose (an evicted object
   * counts once and carries on), and the thing it replaces — one COUNT(*) over
   * a job's whole series, ten seconds apart, for an hour — reads several
   * hundred rows a beat to answer "not yet" every single time.
   *
   * It is allowed to drift (a beat retried inside one second upserts the same
   * row while this counts two), which is why crossing the cap re-counts for
   * real before thinning anything. Entries are dropped when the job ends. */
  private sampleCounts = new Map<string, number>();

  /** mapNames' in-memory copy of the maps list (MAPS_CACHE_MS). Refreshed by
   * every write to the row, so like sampleCounts it is a cache of something
   * the table already knows and costs nothing to lose. */
  private mapsCache: { at: number; maps: string[] } | null = null;

  /** What each method has cost in SQLite rows since this instance started —
   * the live counterpart of tests/do/rowcost.test.ts, served by
   * sqlStatsReport (GET /api/sqlstats). IN MEMORY like sampleCounts, and
   * doubly so: persisting a measurement of the write budget would spend it.
   * The cron keeps the instance warm, so the tally spans hours to days;
   * sqlStatsSince says how long, since a deploy or eviction resets both. */
  private sqlStats = new Map<string, { calls: number; rowsRead: number; rowsWritten: number }>();
  private readonly sqlStatsSince = Date.now();
  /** The public method currently executing — what installSqlAccounting's exec
   * shim attributes each statement to. Outermost wins: a helper a method
   * calls bills its caller, which is the endpoint's-eye view. */
  private sqlOp: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.installSqlAccounting();
    // The schema DDL is write-classified by the storage layer even when it
    // changes nothing (CREATE TABLE IF NOT EXISTS on an existing table), and
    // this constructor runs for every request — so the DDL runs only when the
    // read-only schema_version stamp says something is actually missing
    // (ensureSchema); the steady-state constructor reads one row and
    // writes nothing. And no failure here may kill the request: the free
    // tier's overage enforcement gates EVERY SQL statement once a daily
    // budget is spent, reads included (observed live: the sqlite_master
    // SELECT threw "Exceeded allowed rows written"), so a throwing
    // constructor turns one exhausted budget into a dead object with an
    // unattributable error. Both steps log their own failure with what they
    // were doing and serve on; the request then fails — if it fails — in the
    // route's own query, which is the error the worker log ties to a method
    // and path.
    this.ensureSchema();
    this.ensureDerived();
  }

  /** installSqlAccounting wraps sql.exec so every statement bills its
   * rowsRead / rowsWritten to the method named by sqlOp (stamped by the
   * prototype wrappers installed below the class). Installed before the
   * constructor runs any SQL, so ensureSchema/ensureDerived appear in the
   * tally too. Consuming each cursor eagerly is safe because every caller in
   * this class takes .toArray() or reads .rowsWritten (the rowcost test's
   * shim relies on the same fact) — and the counters are only final once a
   * cursor is consumed. The wrapper is installed on the sql OBJECT, and
   * callers look exec up per call, so a test that wraps exec again
   * afterwards measures through this one. */
  private installSqlAccounting(): void {
    const sql = this.ctx.storage.sql;
    const real = sql.exec.bind(sql);
    (sql as unknown as { exec: unknown }).exec = (q: string, ...args: unknown[]) => {
      const cur = real(q, ...(args as string[]));
      const rows = cur.toArray();
      const t = this.sqlTally(this.sqlOp ?? "(outside any method)");
      t.rowsRead += cur.rowsRead;
      t.rowsWritten += cur.rowsWritten;
      return { toArray: () => rows, rowsRead: cur.rowsRead, rowsWritten: cur.rowsWritten };
    };
  }

  /** sqlTracked runs one method under its name for the exec shim to bill.
   * Outermost wins — a helper a method calls bills its caller, the
   * endpoint's-eye view — and methods are synchronous, so a plain
   * try/finally holds the stamp. A single call crossing SQL_WARN_ROWS_READ /
   * SQL_WARN_ROWS_WRITTEN logs itself: that is how a new scan announces
   * itself in the live logs without an event per poll. */
  private sqlTracked(name: string, fn: (...a: unknown[]) => unknown, args: unknown[]): unknown {
    if (this.sqlOp !== null) return fn.apply(this, args);
    const t = this.sqlTally(name);
    t.calls += 1;
    const read = t.rowsRead;
    const written = t.rowsWritten;
    this.sqlOp = name;
    try {
      return fn.apply(this, args);
    } finally {
      this.sqlOp = null;
      const dRead = t.rowsRead - read;
      const dWritten = t.rowsWritten - written;
      if (dRead > SQL_WARN_ROWS_READ || dWritten > SQL_WARN_ROWS_WRITTEN) {
        console.warn(`sql cost: ${name} read=${dRead} written=${dWritten} rows in one call`);
      }
    }
  }

  private sqlTally(op: string): { calls: number; rowsRead: number; rowsWritten: number } {
    let t = this.sqlStats.get(op);
    if (t === undefined) {
      t = { calls: 0, rowsRead: 0, rowsWritten: 0 };
      this.sqlStats.set(op, t);
    }
    return t;
  }

  /** sqlStatsReport serves the tally: per method — most expensive first — and
   * in total, with when the counting started and how long that is, since the
   * numbers mean nothing without their window. */
  sqlStatsReport(): {
    since: number;
    elapsedSec: number;
    ops: { op: string; calls: number; rowsRead: number; rowsWritten: number }[];
    totals: { rowsRead: number; rowsWritten: number };
  } {
    const ops = [...this.sqlStats.entries()]
      .map(([op, t]) => ({ op, ...t }))
      .sort((a, b) => b.rowsRead + b.rowsWritten - (a.rowsRead + a.rowsWritten));
    const totals = { rowsRead: 0, rowsWritten: 0 };
    for (const o of ops) {
      totals.rowsRead += o.rowsRead;
      totals.rowsWritten += o.rowsWritten;
    }
    return {
      since: this.sqlStatsSince,
      elapsedSec: Math.round((Date.now() - this.sqlStatsSince) / 1000),
      ops,
      totals,
    };
  }

  /** ensureSchema migrates when a read-only check says something is missing,
   * and serves on regardless when the check or the migration cannot run. The
   * live case for the migration: with the free tier's daily rows-written
   * allowance spent, creating an index over the whole games mirror is a real
   * write and throws — but the previous schema still answers every query (at
   * worst without the new index), so failing the construction would take
   * every read down for a performance optimization. Logged loudly instead,
   * and every fresh instantiation retries, so the migration lands on the
   * first construction after the budget resets. */
  private ensureSchema(): void {
    let current: boolean;
    try {
      current = this.schemaCurrent();
    } catch (e) {
      // Even the read-only check can throw — the overage gate above spares
      // no statement. Skip the migration rather than guess: an unmigrated
      // schema serves, a half-guessed one might not.
      console.error(`schema check failed, skipping migration: ${e}`);
      return;
    }
    if (current) return;
    try {
      this.migrateSchema();
    } catch (e) {
      console.error(`schema migration failed, serving with the previous schema: ${e}`);
    }
  }

  /** ensureDerived runs the one-time derived-table rebuild when
   * DERIVED_VERSION says one is due, guarded exactly like the schema
   * migration and for the same reason: the version row is only written after
   * a rebuild that succeeded, so a failed one logs, serves on, and is retried
   * on every construction until it lands. */
  private ensureDerived(): void {
    try {
      const have = this.ctx.storage.sql
        .exec(`SELECT value FROM schema_meta WHERE key = 'derived_version'`)
        .toArray();
      if ((have.length > 0 ? (have[0].value as number) : 0) >= DERIVED_VERSION) return;
      // v2+v3, together because neither shipped before the other: seed the
      // maps list from the rows already in the catalog (upsert maintains it
      // for every publish from here on), and seed the jobs counter from the
      // table (jobInsert increments it from here on). Both are idempotent
      // recomputes, so re-running them on a database that somehow ran one
      // is harmless; a fresh database derives an empty list and a zero
      // count, which is equally right.
      this.rebuildMapsList();
      const jobs = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM jobs`).toArray();
      this.metaPut(JOBS_COUNT_KEY, Number(jobs[0].n));
      this.ctx.storage.sql.exec(
        `INSERT INTO schema_meta (key, value) VALUES ('derived_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        DERIVED_VERSION,
      );
    } catch (e) {
      console.error(`derived rebuild failed (version ${DERIVED_VERSION} pending): ${e}`);
    }
  }

  /** schemaCurrent reports whether the last completed migration stamped the
   * current SCHEMA_VERSION — one row read, no writes. "No such table" is the
   * answer, not an error: a database from before the stamp (and a fresh one)
   * must migrate. Anything else a read can throw — the overage gate — is the
   * caller's to log. */
  private schemaCurrent(): boolean {
    try {
      const r = this.ctx.storage.sql.exec(`SELECT version FROM schema_version`).toArray();
      return r.length > 0 && (r[0].version as number) >= SCHEMA_VERSION;
    } catch (e) {
      if (String(e).includes("no such table")) return false;
      throw e;
    }
  }

  /** migrateSchema brings the database to the current schema: the base DDL,
   * the late-added columns, then the indexes (after the ALTERs, because one of
   * them indexes a column the ALTERs may have just added). Idempotent — every
   * statement tolerates what already exists — but never a no-op to the write
   * meter, which is why the constructor gates it on schemaCurrent. The
   * version is stamped LAST, so a migration that died halfway is retried
   * whole rather than believed. */
  private migrateSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(SCHEMA_DDL);
    for (const [table, col] of ADDED_COLUMNS) {
      try {
        sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      } catch (e) {
        if (!String(e).includes("duplicate column")) throw e;
      }
    }
    // end_unix for the rows from before it (see ADDED_COLUMNS). Before
    // INDEX_DDL, so the indexes on it are built once over filled rows rather
    // than rewritten row by row; WHERE end_unix IS NULL keeps a re-run cheap.
    sql.exec(
      `UPDATE games SET end_unix = start_unix + COALESCE(duration_sec, 0)
        WHERE end_unix IS NULL AND start_unix IS NOT NULL`,
    );
    sql.exec(INDEX_DDL);
    sql.exec(`DELETE FROM schema_version`);
    sql.exec(`INSERT INTO schema_version (version) VALUES (?)`, SCHEMA_VERSION);
  }

  /** metaGet / metaPut are the schema_meta table used as a scratchpad for the
   * few numbers this object has to remember BETWEEN calls — the derived-table
   * version, and the watermarks that keep the periodic sweeps from redoing
   * work they already did. One indexed row each; the alternative, re-deriving
   * them from the tables, is exactly the full scan they exist to avoid. */
  private metaGet(key: string): number | null {
    const r = this.ctx.storage.sql.exec(`SELECT value FROM schema_meta WHERE key = ?`, key).toArray();
    return r.length === 0 ? null : (r[0].value as number);
  }

  private metaPut(key: string, value: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }



  /** indexSettings replaces one game's rows in replay_settings. Delete then
   * insert (not upsert) so a settings change can REMOVE an entry — a
   * re-publish that drops a flag must not leave it matching the filter.
   *
   * Both the catalog and the games mirror index into this table, under the
   * same gameId, so exactly ONE of them owns an id's entries: the catalog row
   * if there is one (its flags come from the capture that was actually
   * published), the games row otherwise. gamesInsert enforces that by not
   * touching an id the catalog holds — without it, the two would take turns
   * deleting each other's entries. */
  private indexSettings(id: string, settings: Record<string, boolean | string> | null): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM replay_settings WHERE replay_id = ?`, id);
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
   * game, not just the current one.
   *
   * It also QUEUES THE GAME'S RE-SIMULATION when the publish leaves it
   * one-sided (wantsFullView over the merged list) and the caller supplied an
   * id for the job. A capture from a playing client only ever saw its own
   * side, so the game is worth re-simulating headlessly for the spectator's
   * view — and a publish is the only moment that can become true, which is why
   * it is announced here rather than looked for. The re-sim daemon used to
   * find these by listing the whole catalog every ten seconds and applying the
   * same predicate to every row; this is that, done once, by the thing that
   * knows.
   *
   * jobAnnounce rather than resimEnqueue: the game is IN the catalog by
   * definition here (this call is what puts it there), which resimEnqueue
   * refuses — rightly, for a person pasting a link. It dedupes on an active
   * job, so a second teammate's upload of the same game adds nothing, and a
   * held-back job is left held back. The publish is not rolled back if the
   * announce finds nothing to do; there is simply no new row.
   *
   * The job id comes from the CALLER, like every other job creator here, so
   * the object stays deterministic under test. Omitting it opts out entirely,
   * which is what an internal caller with no re-sim intent does. */
  upsert(e: ReplayEntry, resimJobId?: string): void {
    const prior = this.ctx.storage.sql
      .exec(`SELECT rid, uploads, uploader_ally FROM replays WHERE id = ?`, e.id)
      .toArray();
    const before: UploadRef[] | null =
      prior.length > 0 && prior[0].uploads != null ? JSON.parse(prior[0].uploads as string) : null;
    const uploads = mergeUploads(
      before,
      e.rid,
      e.uploaderAlly,
      {
        version: e.widgetVersion ?? undefined,
        sha: e.widgetSha ?? undefined,
        date: e.widgetDate ?? undefined,
      },
      e.rev,
    );
    // A game with a MAIN replay (its unsuffixed, full-view one) keeps it as
    // the row's current revision: a later suffixed upload — a player's
    // one-sided capture, or a second full view — joins the uploads list as an
    // alt link and changes nothing else, since every other column describes
    // the revision the row points at.
    const priorRid = prior.length > 0 ? (prior[0].rid as string | null) : null;
    if (priorRid !== null && isMainRid(priorRid, e.id) && e.rid !== null && !isMainRid(e.rid, e.id)) {
      this.ctx.storage.sql.exec(
        `UPDATE replays SET uploads = ?, updated_unix = ? WHERE id = ?`,
        uploads === null ? null : JSON.stringify(uploads),
        Math.floor(Date.now() / 1000),
        e.id,
      );
      const rowAlly = prior[0].uploader_ally as number | null;
      if (resimJobId !== undefined && wantsFullView(rowAlly, uploads)) {
        this.jobAnnounce(resimJobId, e.id, "resim");
      }
      return;
    }
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
    this.indexSettings(e.id, e.settings);
    this.noteMap(e.map);
    if (resimJobId !== undefined && wantsFullView(e.uploaderAlly, uploads)) {
      this.jobAnnounce(resimJobId, e.id, "resim");
    }
  }

  /** gameStartUnix is when the games mirror says a game started, or null
   * when it does not know the game: a primary-key seek, for filing an
   * uploaded stream under its month. */
  gameStartUnix(id: string): number | null {
    const rows = this.ctx.storage.sql.exec(`SELECT start_unix FROM games WHERE id = ?`, id).toArray();
    return rows.length > 0 ? ((rows[0].start_unix as number | null) ?? null) : null;
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
        ? prior.map((u) => (u.rid === rid ? { rid: u.rid, ally: effAlly, ...(u.rev ? { rev: u.rev } : {}) } : u))
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
      // The same >= / < range the player prefix uses, here over the primary
      // key: a full id is a seek, a partial one reads only its own span.
      if (filter.id !== null) {
        where.push(`id >= ? AND id < ?`);
        args.push(filter.id, filter.id + "\uffff");
      }
      if (filter.minPlayers !== null) { where.push(`player_count >= ?`); args.push(filter.minPlayers); }
      if (filter.maxPlayers !== null) { where.push(`player_count <= ?`); args.push(filter.maxPlayers); }
      // NULL duration compares false either way, which is the intent: a row
      // that never recorded how long the game ran cannot be said to fall
      // inside a length the user asked for.
      if (filter.minDuration !== null) { where.push(`duration_sec >= ?`); args.push(filter.minDuration); }
      if (filter.maxDuration !== null) { where.push(`duration_sec <= ?`); args.push(filter.maxDuration); }
      if (filter.player !== null) {
        // Prefix match over the roster JSON the row already stores. The
        // replay_players table this used to seek is gone (see SCHEMA_DDL):
        // its upkeep was the write budget's biggest line, and a LIKE over
        // the catalog's own rows reads at most the catalog — a few hundred
        // rows, on a human-initiated query, never on a polled path. LIKE's
        // ASCII case folding stands in for the old name_lower column. The
        // needle is JSON-encoded exactly as the stored roster is (so a
        // quote or backslash in a name matches its stored escape) and then
        // LIKE-escaped (so a wildcard in a name cannot widen the match);
        // JSON.stringify's opening quote is kept — it is the roster's own
        // name delimiter.
        where.push(`players LIKE ? ESCAPE '\\'`);
        args.push(`%"name":${likeEscape(JSON.stringify(filter.player).slice(0, -1))}%`);
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
    // answers. An omitted limit means the whole listing — the ROUTE never
    // omits it any more (it defaults to CATALOG_LIMIT_MAX, so no HTTP client
    // can ask for everything at once); only direct callers (tests) still may.
    let window = "";
    if (limit !== undefined && limit > 0) {
      window = `LIMIT ? OFFSET ?`;
      args.push(limit, offset !== undefined && offset > 0 ? offset : 0);
    }
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, rid, start_unix, duration_sec, map, game_size, size_bytes, settings, players, player_count, uploader_ally, uploads, view, widget_version, widget_sha, widget_date, placeholder,
                -- Both jobs subqueries are PINNED to the (game_id, state)
                -- index: left to itself the planner answered the progress
                -- subselect's ORDER BY from jobs_state instead, which reads
                -- every processing job PER LISTED ROW — 50 rows x the number
                -- of daemons at work, on every landing-page load (the rowcost
                -- test's in-flight seed is what caught it). Seeked by game,
                -- each costs the game's own jobs, i.e. almost always 0-1.
                EXISTS (SELECT 1 FROM jobs j INDEXED BY jobs_game
                        WHERE j.game_id = replays.id AND j.state = 'processing') AS processing,
                (SELECT j.progress FROM jobs j INDEXED BY jobs_game
                 WHERE j.game_id = replays.id AND j.state = 'processing'
                 ORDER BY j.updated_unix DESC LIMIT 1) AS processing_progress,
                (SELECT lobby_name FROM games g WHERE g.id = replays.id) AS lobby_name,
                (SELECT map_file FROM games g WHERE g.id = replays.id) AS map_file
         FROM replays
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         -- NULLs sort last here because SQL says so — NULL is smaller than
         -- every value, so DESC puts them at the end — and NOT because of a
         -- leading start_unix-IS-NULL term, which used to be written out and
         -- said the same thing at a price: an EXPRESSION as the first sort key
         -- disqualifies replays_start, so every listing sorted the whole table
         -- in a temp b-tree and a LIMIT saved nothing. Measured over 3000 rows
         -- asked for 50: 6000 rows read, against 101 with the index driving.
         ORDER BY start_unix DESC, id
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
      // JOINED per read from the games mirror (the teiserver poll's landing
      // spot), so a name that arrives after the replay was published shows
      // up without anyone touching the replays row. map_file rides the same
      // join: the mirror is the one place the map's ARCHIVE name is known,
      // and the list's terrain thumbnail keys on it.
      lobbyName: (r.lobby_name as string | null) ?? null,
      mapFile: (r.map_file as string | null) ?? null,
      // DERIVED, never stored: a flag would have to be cleared by whoever
      // finishes the job, and every path that forgets — a crash, a stale
      // daemon, a job deleted by hand — would leave a row saying "processing"
      // forever. Asked of the jobs table it is simply true while a job is
      // running and false the moment one is not.
      processing: r.processing === 1,
      processingPercent: progressPercent(r.processing_progress),
    }));
  }

  /** mapNames serves the catalog's distinct map names, sorted — the choices
   * behind the filter bar's map combobox, and the one filter list that cannot
   * be hardcoded. It reads the maintained unique_values row (see SCHEMA_DDL)
   * through a one-minute in-memory copy, so the recurring cost is one row a
   * minute however often the landing page loads; the facets() this replaces
   * ran DISTINCT scans over the whole catalog on every call. */
  mapNames(): string[] {
    if (this.mapsCache !== null && Date.now() - this.mapsCache.at < MAPS_CACHE_MS) {
      return this.mapsCache.maps;
    }
    const maps = this.storedMaps();
    this.mapsCache = { at: Date.now(), maps };
    return maps;
  }

  /** storedMaps reads the maps list off its unique_values row: one row, or
   * none on a database from before the table was seeded (an empty list — the
   * next publish or the derived backfill fills it in). */
  private storedMaps(): string[] {
    const r = this.ctx.storage.sql
      .exec(`SELECT value FROM unique_values WHERE key = 'maps'`)
      .toArray();
    if (r.length === 0) return [];
    try {
      const parsed = JSON.parse(r[0].value as string) as unknown;
      return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
    } catch {
      return [];
    }
  }

  /** noteMap folds one published replay's map into the maps list, if it is
   * new: a membership check against the stored row (one read), a write only
   * when the catalog actually gained a map — which is almost never, maps
   * being a small fixed pool next to the games played on them. The in-memory
   * copy is refreshed with the write, so a new map is offered immediately. */
  private noteMap(map: string | null): void {
    if (map === null || map === "") return;
    const maps = this.storedMaps();
    if (maps.includes(map)) return;
    const next = [...maps, map].sort();
    this.ctx.storage.sql.exec(
      `INSERT INTO unique_values (key, value) VALUES ('maps', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(next),
    );
    this.mapsCache = { at: Date.now(), maps: next };
  }

  /** rebuildMapsList recomputes the maps row from the whole catalog — the
   * derived backfill (one-time, see ensureDerived), never a serving path. */
  private rebuildMapsList(): void {
    const maps = this.ctx.storage.sql
      .exec(`SELECT DISTINCT map FROM replays WHERE map IS NOT NULL ORDER BY map`)
      .toArray()
      .map((r) => r.map as string);
    this.ctx.storage.sql.exec(
      `INSERT INTO unique_values (key, value) VALUES ('maps', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(maps),
    );
    this.mapsCache = { at: Date.now(), maps };
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
    // The settings index comes from exactly the column this just rewrote, so
    // it has to be rebuilt with it — otherwise the filter keeps matching the
    // badges the refresh replaced (the roster needs no reindex: the player
    // filter reads the JSON itself). Re-read the
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
    this.indexSettings(id, storedSettings);
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
    // Chunked because the games sync now passes a whole 2h window of ids (~150+
    // when the mirror is behind), past SQLite's per-statement bind-param cap;
    // each chunk's IN is PK-index-backed, so the reads stay ~the id count.
    const CHUNK = 90;
    const known = new Set<string>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      for (const r of this.ctx.storage.sql
        .exec(`SELECT id FROM games WHERE id IN (${batch.map(() => "?").join(",")})`, ...batch)
        .toArray()) {
        known.add(r.id as string);
      }
    }
    return ids.filter((id) => !known.has(id));
  }

  /** gamesLavaPending lists the lava sync's candidates: the mirror's
   * LAVA-SHAPED games — the lava flag in replay_settings (map_waterislava) and
   * an 8v8 roster — that have never been offered to lavabalance and ended
   * inside LAVA_OFFER_HORIZON_SEC, OLDEST-STARTED first, `limit` at a time.
   * Each row also carries the game's matched lobby info (null when no lobby was
   * ever matched), which the lava sync attaches to what it submits.
   *
   * Three deliberate choices, all of them repairs of the version that stalled
   * from 2026-09-11 to 09-14 (see lavasync.ts for the shape it replaces):
   *
   * NEVER OFFERED, not "after a watermark". The watermark was lavabalance's
   * newest STORED game, and it only stores what its classifier accepts, so a
   * game it declines stayed ahead of the mark and was re-offered forever. One
   * night of zombie and noob-friendly lobbies put 33 such games in front of the
   * queue, MAX_LAVA_BATCH is 20, and the sync spent three days re-offering the
   * same 20 rejects while 72 real lava games queued up behind them. Offer state
   * belongs to the side doing the offering.
   *
   * LAVA-SHAPED, not merely modded. The old pre-filter was the mods flag, on
   * the theory that tweaked games are rare (~0 in 24) and lavabalance's
   * classifier could reject the rest. They are not rare — 405 modded games in
   * three days — and rejects were exactly what jammed the queue. These two
   * facts are what lavabalance itself requires of every game it stores, so a
   * candidate is now plausible rather than merely unusual; its classifier stays
   * the authority on the tweak stack, which is the part only it can judge.
   *
   * OLDEST-STARTED, not oldest-ended. lavabalance folds ratings forward from a
   * (startTime, id) head and stores anything behind it unranked, permanently.
   * Start order is therefore the order it wants; end order is what the mirror
   * happens to learn games in. The two agree for the lava lobby's own
   * back-to-back games and diverge when two lobbies overlap.
   *
   * Driven by the (flag, replay_id) covering index, so the cost is the number of
   * lava-flagged games ever mirrored plus a PK seek each, NOT the mirror's size;
   * and it runs only on a fresh-candidate trigger or the hourly sweep, never the
   * every-minute path (rowcost.test.ts bounds it). If that count ever grows
   * enough to matter, the shape that fixes it is a pending-work table, not a
   * wider index: what this asks for is a queue. */
  gamesLavaPending(
    limit: number,
    now = Math.floor(Date.now() / 1000),
  ): {
    id: string;
    startUnix: number;
    endUnix: number;
    lobbyName: string | null;
    lobbyDetails: LobbyDetails | null;
  }[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT g.id AS id, g.start_unix AS start_unix,
                g.end_unix AS end_unix,
                g.lobby_name, g.lobby_details
           FROM replay_settings rs JOIN games g ON g.id = rs.replay_id
          WHERE rs.flag = ? AND g.game_size = ? AND g.start_unix IS NOT NULL
            AND g.lava_offered_unix IS NULL
            AND g.end_unix >= ?
          ORDER BY g.start_unix ASC, g.id LIMIT ?`,
        SETTINGS_LAVA_FLAG,
        LAVA_GAME_SIZE,
        now - LAVA_OFFER_HORIZON_SEC,
        limit,
      )
      .toArray()
      .map((r) => ({
        id: r.id as string,
        startUnix: Number(r.start_unix),
        endUnix: Number(r.end_unix),
        lobbyName: (r.lobby_name as string | null) ?? null,
        lobbyDetails: parseStored(r.lobby_details as string | null, (v) => v as LobbyDetails),
      }));
  }

  /** lavaMarkOffered records that these games have been handed to lavabalance,
   * so gamesLavaPending stops proposing them. Called with the ids of a batch
   * lavabalance ANSWERED — a POST that threw marks nothing and the next run
   * re-offers the lot, which is the old stateless design's one good property
   * kept.
   *
   * A verdict is not a reason to re-offer: classification is deterministic, so
   * a game lavabalance rejected or skipped will be rejected or skipped again.
   * The one thing that does change is lobby info arriving late, and lobbiesMatch
   * clears this column when it fills it. Returns the rows marked.
   *
   * Un-chunked, unlike gamesByIds: callers mark one batch, and MAX_LAVA_BATCH
   * is 20 ids — two orders of magnitude under the bind limit. */
  lavaMarkOffered(ids: string[], now = Math.floor(Date.now() / 1000)): number {
    if (ids.length === 0) return 0;
    return this.ctx.storage.sql.exec(
      `UPDATE games SET lava_offered_unix = ?
        WHERE id IN (${ids.map(() => "?").join(",")}) AND lava_offered_unix IS NULL`,
      now,
      ...ids,
    ).rowsWritten;
  }

  /** gamesInsert records mirrored games and indexes their settings into
   * replay_settings (their rosters stay JSON on the row — see the note at the
   * indexSettings call). Upsert rather than plain insert so re-syncing a game (a
   * backfill, a later re-read) refreshes it instead of failing.
   *
   * The derived rows are written only for ids the CATALOG does not hold — see
   * indexSettings: a published replay's entries are rebuilt from the capture that
   * was actually published, and a mirror row must not overwrite them with the
   * API's account of the same game. Returns the number of rows written. */
  gamesInsert(games: GameEntry[]): number {
    const sql = this.ctx.storage.sql;
    const now = Math.floor(Date.now() / 1000);
    for (const g of games) {
      sql.exec(
        `INSERT INTO games (id, start_unix, duration_sec, end_unix, map, map_file, game_size, preset, player_count, players, settings, engine_version, game_version, synced_unix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           start_unix = excluded.start_unix,
           duration_sec = excluded.duration_sec,
           end_unix = excluded.end_unix,
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
        g.startUnix === null ? null : g.startUnix + (g.durationSec ?? 0),
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
      // Settings only: the backfill's modded-first ranking reads them, and
      // they are a couple of rows. The roster stays JSON on the games row —
      // indexing it (48 rows written per game) is what once spent the whole
      // write allowance; see the replay_settings note in SCHEMA_DDL.
      if (!owned) this.indexSettings(g.id, g.settings);
    }
    return games.length;
  }

  /** gamesPage lists the mirror for the Games section: one page of mirrored
   * games, latest-ENDED first, narrowed by the same filters as the replay list
   * (minus the player name — see below), each with whether this site has a
   * replay of it and what its last job did, plus the cursor of the page after
   * it (null on the last page).
   *
   * End time is ARRIVAL order (the mirror learns a game once it is over), and
   * end_unix is what every games index is built on. KEYSET, not OFFSET:
   * `after` is the order key of the previous page's last row and the walk
   * resumes strictly after it, so a page deep in the mirror costs what the
   * first does and never repeats a row as games keep landing.
   *
   * HOW A FILTER STAYS CHEAP. Each filter has an index it can WALK in end
   * order, and the one walked is the most selective set:
   *   - id prefix (4+ hex characters): the primary key, its few matches sorted;
   *   - map: games_map_end, an equality seek read in end order;
   *   - players: games_count_end, one branch per count in the range, merged;
   *   - duration: games_durmin_end, one branch per MINUTE in the range, merged
   *     (the filter's own step; the exact seconds are checked per row);
   *   - otherwise games_end itself. Dates bound every walk's range.
   * Everything not walked — and settings flags always — is checked per row
   * (a flag is a replay_settings primary-key seek). Walking even a rare flag
   * beats driving from the flag index: that would sort every game ever
   * flagged on each click, where the walk stops at the page edge.
   * Each branch reads at most GAMES_SCAN_MAX / branches rows when anything is
   * checked per row, so a filter that matches almost nothing costs a bounded
   * read and answers with a SHORT page whose `next` resumes where the search
   * stopped (`partial`), rather than reading the whole mirror for it.
   *
   * No player-name filter (Marcin's call): a name is inside the roster JSON
   * and indexing it is the replay_players table the 2026-08-23 outage
   * dropped. Undated games (no start) are not listed: the API has never
   * returned one. */
  gamesPage(
    limit: number,
    after: GamesCursor | null,
    f: ReplayFilter = emptyFilter(),
  ): { games: GameListRow[]; next: GamesCursor | null; partial: boolean } {
    const want = limit + 1; // the extra row is "there is a next page"

    // The range every walk reads: end_unix bounded by the dates and resumed
    // after the cursor (the tie rows already shown — same second, id at or
    // before the cursor's — filtered off).
    const base: string[] = ["g.end_unix IS NOT NULL"];
    const baseArgs: unknown[] = [];
    if (f.from !== null) { base.push("g.end_unix >= ?"); baseArgs.push(f.from); }
    if (f.to !== null) { base.push("g.end_unix <= ?"); baseArgs.push(f.to); }
    if (after !== null && after.endUnix !== null) {
      base.push("g.end_unix <= ?", "NOT (g.end_unix = ? AND g.id <= ?)");
      baseArgs.push(after.endUnix, after.endUnix, after.id);
    }

    // The per-row checks, as one boolean column. Each filter the chosen walk
    // does not answer exactly lands here.
    const checks: string[] = [];
    const checkArgs: unknown[] = [];
    const branches: { where: string; args: unknown[] }[] = [];
    const idPrefix = f.id ?? "";
    const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
    if (idPrefix.length >= GAMES_ID_WALK_MIN) {
      branches.push({ where: "g.id >= ? AND g.id < ?", args: [idPrefix, idPrefix + "g"] });
    } else if (f.map !== null) {
      branches.push({ where: "g.map = ?", args: [f.map] });
    } else if (f.minPlayers !== null || f.maxPlayers !== null) {
      const lo = Math.max(f.minPlayers ?? 1, 1);
      const hi = Math.min(f.maxPlayers ?? GAMES_COUNT_BRANCH_MAX, GAMES_COUNT_BRANCH_MAX);
      for (const n of range(lo, hi)) branches.push({ where: "g.player_count = ?", args: [n] });
      if (f.maxPlayers === null || f.maxPlayers > GAMES_COUNT_BRANCH_MAX) {
        branches.push({
          where: "g.player_count > ?" + (f.maxPlayers === null ? "" : " AND g.player_count <= ?"),
          args: f.maxPlayers === null ? [GAMES_COUNT_BRANCH_MAX] : [GAMES_COUNT_BRANCH_MAX, f.maxPlayers],
        });
      }
    } else if (f.minDuration !== null || f.maxDuration !== null) {
      const lo = Math.floor((f.minDuration ?? 0) / 60);
      const hiMin = f.maxDuration === null ? null : Math.floor(f.maxDuration / 60);
      const hi = Math.min(hiMin ?? GAMES_DURMIN_BRANCH_MAX, GAMES_DURMIN_BRANCH_MAX);
      for (const m of range(lo, hi)) branches.push({ where: "(g.duration_sec / 60) = ?", args: [m] });
      if (hiMin === null || hiMin > GAMES_DURMIN_BRANCH_MAX) {
        branches.push({ where: "(g.duration_sec / 60) > ?", args: [GAMES_DURMIN_BRANCH_MAX] });
      }
    } else {
      branches.push({ where: "1", args: [] });
    }
    // Every filter is re-checked here except the one walked exactly; a
    // redundant check is a comparison on a row already read.
    if (idPrefix !== "" && idPrefix.length < GAMES_ID_WALK_MIN) {
      checks.push("substr(g.id, 1, ?) = ?");
      checkArgs.push(idPrefix.length, idPrefix);
    }
    if (f.map !== null) { checks.push("g.map = ?"); checkArgs.push(f.map); }
    if (f.minPlayers !== null) { checks.push("g.player_count >= ?"); checkArgs.push(f.minPlayers); }
    if (f.maxPlayers !== null) { checks.push("g.player_count <= ?"); checkArgs.push(f.maxPlayers); }
    if (f.minDuration !== null) { checks.push("g.duration_sec >= ?"); checkArgs.push(f.minDuration); }
    if (f.maxDuration !== null) { checks.push("g.duration_sec <= ?"); checkArgs.push(f.maxDuration); }
    for (const flag of f.settings) {
      checks.push("EXISTS (SELECT 1 FROM replay_settings s WHERE s.replay_id = g.id AND s.flag = ?)");
      checkArgs.push(flag);
    }
    const hit = checks.length === 0 ? "1" : checks.join(" AND ");
    // With nothing checked per row every row read is a match, so a page's
    // worth per branch is enough; otherwise the scan budget is shared out.
    const perBranch =
      checks.length === 0 ? want : Math.max(want, Math.floor(GAMES_SCAN_MAX / branches.length));

    type Key = { id: string; end: number; hit: boolean };
    const before = (a: Key, b: Key) => a.end > b.end || (a.end === b.end && a.id < b.id);
    let rows: Key[] = [];
    let frontier: Key | null = null; // the earliest point a cut-off branch stopped at
    for (const br of branches) {
      const got = this.ctx.storage.sql
        .exec(
          `SELECT g.id AS id, g.end_unix AS end_unix, (${hit}) AS hit FROM games g
            WHERE ${base.join(" AND ")} AND ${br.where}
            ORDER BY g.end_unix DESC, g.id LIMIT ?`,
          ...checkArgs,
          ...baseArgs,
          ...br.args,
          perBranch,
        )
        .toArray()
        .map((r) => ({ id: r.id as string, end: Number(r.end_unix), hit: Number(r.hit) === 1 }));
      if (got.length === perBranch) {
        const last = got[got.length - 1];
        if (frontier === null || before(last, frontier)) frontier = last;
      }
      rows = rows.concat(got);
    }
    rows.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
    // Past the frontier a cut-off branch may still hold rows it never read,
    // so the merged order is only complete up to it.
    if (frontier !== null) {
      const fr = frontier;
      rows = rows.filter((r) => !before(fr, r));
    }
    const hits = rows.filter((r) => r.hit);
    let pageKeys: Key[];
    let next: GamesCursor | null;
    let partial = false;
    if (hits.length > limit) {
      pageKeys = hits.slice(0, limit);
      const last = pageKeys[limit - 1];
      next = { endUnix: last.end, id: last.id };
    } else if (frontier !== null) {
      pageKeys = hits;
      next = { endUnix: frontier.end, id: frontier.id };
      partial = true;
    } else {
      pageKeys = hits;
      next = null;
    }
    return { games: this.gamesByIds(pageKeys.map((k) => k.id)), next, partial };
  }

  /** gamesByIds answers GET /api/games?id=: the named mirrored games, in the
   * order they were asked for (ids the mirror does not hold are simply absent
   * — to the caller an unmirrored game and a nonexistent one are the same).
   * The rows are GAMES_LIST_SELECT rows, identical to a listing page's.
   *
   * Chunked IN(...) like gamesUnknown — the route caps the list at 100 ids,
   * over SQLite's default bind-param headroom once the other reads are counted
   * — and each chunk is a PK-index seek per id, so the cost is the id count
   * plus the per-row join seeks, never the mirror's size (rowcost.test.ts
   * bounds it: this is an open route). */
  gamesByIds(ids: string[]): GameListRow[] {
    if (ids.length === 0) return [];
    const CHUNK = 90;
    const byId = new Map<string, GameListRow>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      for (const r of this.ctx.storage.sql
        .exec(`${GAMES_LIST_SELECT} WHERE g.id IN (${batch.map(() => "?").join(",")})`, ...batch)
        .toArray()) {
        const row = gameListRow(r);
        byId.set(row.id, row);
      }
    }
    const found: GameListRow[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (row !== undefined) found.push(row);
    }
    return found;
  }

  /** teiserverCookies reads the persisted teiserver web-session jar, or null
   * when no login has ever succeeded. The lobby sync seeds its session from
   * this, which is what makes the steady state one authed GET per tick with
   * no login round-trip. */
  teiserverCookies(): Record<string, string> | null {
    const rows = this.ctx.storage.sql.exec(`SELECT cookies FROM teiserver_session WHERE id = 1`).toArray();
    return rows.length === 0 ? null : JSON.parse(rows[0].cookies as string);
  }

  /** teiserverCookiesPut persists the session jar (the whole jar, replacing
   * what was stored — the caller's is always the newer one). One row by
   * construction: the CHECK plus the fixed id make a second row impossible. */
  teiserverCookiesPut(jar: Record<string, string>): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO teiserver_session (id, cookies, updated_unix) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET cookies = excluded.cookies, updated_unix = excluded.updated_unix`,
      JSON.stringify(jar),
      Math.floor(Date.now() / 1000),
    );
  }

  /** lobbiesOpen lists the observations still open — the lobbies that were in
   * progress last tick. The sync diffs the current page against this to tell
   * a game newly started (observe it) from one still running (nothing to do)
   * from one finished (close it). */
  lobbiesOpen(): OpenLobby[] {
    return this.ctx.storage.sql
      .exec(`SELECT lobby_id, started_unix, seen_sig FROM lobbies WHERE ended_unix IS NULL`)
      .toArray()
      .map((r) => ({
        lobbyId: r.lobby_id as number,
        startedUnix: r.started_unix as number,
        seenSig: (r.seen_sig as string | null) ?? null,
      }));
  }

  /** lobbiesObserve opens an observation per newly started lobby-game.
   * started_unix is back-dated by the page's own running clock (elapsedSec)
   * so a game already minutes in when first seen — a fresh deployment, an
   * outage — still records when it actually began, which is what the match's
   * time gate compares against. DO NOTHING on conflict: the same second
   * cannot hold two different games of one lobby. */
  lobbiesObserve(obs: LobbyObservation[]): void {
    const now = Math.floor(Date.now() / 1000);
    for (const o of obs) {
      this.ctx.storage.sql.exec(
        `INSERT INTO lobbies (lobby_id, started_unix, name, map, players, player_count, lobby_details, seen_sig, ended_unix, matched_game_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(lobby_id, started_unix) DO NOTHING`,
        o.lobbyId,
        now - Math.max(0, o.elapsedSec ?? 0),
        o.name,
        o.map,
        o.players === null ? null : JSON.stringify(o.players),
        o.playerCount,
        o.details == null ? null : JSON.stringify(o.details),
        o.sig ?? null,
      );
    }
  }

  /** lobbiesUpdate records a running lobby's changed state as
   * lobby_details.end (teiserver.ts LobbyEndState) and remembers the
   * signature that triggered it, so the next change overwrites it and the
   * last one standing is the lobby as it was just before the game ended.
   * Only open observations: a closed one describes a game that is over. */
  lobbiesUpdate(updates: LobbyEndUpdate[]): void {
    for (const u of updates) {
      this.ctx.storage.sql.exec(
        `UPDATE lobbies SET seen_sig = ?,
           lobby_details = json_set(COALESCE(lobby_details, '{}'), '$.end', json(?))
         WHERE lobby_id = ? AND started_unix = ? AND ended_unix IS NULL`,
        u.sig,
        JSON.stringify(u.end),
        u.lobbyId,
        u.startedUnix,
      );
    }
  }

  /** lobbiesEnd closes the open observations of lobbies no longer in
   * progress — which is what frees the lobby id to open a fresh observation
   * for its next game. */
  lobbiesEnd(lobbyIds: number[]): void {
    if (lobbyIds.length === 0) return;
    this.ctx.storage.sql.exec(
      `UPDATE lobbies SET ended_unix = ?
       WHERE ended_unix IS NULL AND lobby_id IN (${lobbyIds.map(() => "?").join(",")})`,
      Math.floor(Date.now() / 1000),
      ...lobbyIds,
    );
  }

  /** lobbiesMatch pairs unmatched observations with mirrored games and writes
   * the lobby name onto the games row. The signals and thresholds live in
   * pickLobbyMatches (teiserver.ts); this method is the SQL around it: the
   * candidate reads — the games mirrored since the last run, and the
   * observations that started around them — the two writes per match, and the
   * pruning of matched observations whose name has long since moved to its
   * games row.
   *
   * A match usually lands tens of minutes after the observation: rts-api only
   * learns a game when it ends, so every tick in between finds no arrival at
   * all, which costs one indexed SELECT and stops there. */
  lobbiesMatch(): LobbyMatchResult {
    const sql = this.ctx.storage.sql;
    const now = Math.floor(Date.now() / 1000);
    // ARRIVAL-DRIVEN, from the games side: the candidates are the games
    // MIRRORED since the last run, not every unnamed game inside some open
    // observation's window.
    //
    // The two are the same set, reached from opposite ends, and the difference
    // is what they cost. A match becomes possible when the GAME arrives — the
    // observation is always older, opened while the lobby was still playing
    // it — so a game that failed to match on the tick it landed will not match
    // on the next one either: nothing about either row changes afterwards.
    // Re-asking every minute therefore re-read a widening slice of the mirror
    // forever (the window is as old as the oldest observation, and unmatched
    // observations are kept for good) to re-derive an answer that could not
    // have changed. This reads the last minute's arrivals off games_synced,
    // which on a normal tick is one or two rows.
    const from = this.metaGet("lobby_match_synced") ?? now - LOBBY_MATCH_BACKLOG_SEC;
    this.metaPut("lobby_match_synced", now);
    const games: MatchGame[] = sql
      .exec(
        `SELECT id, start_unix, map, players FROM games
         WHERE synced_unix >= ? AND lobby_name IS NULL AND start_unix IS NOT NULL`,
        from,
      )
      .toArray()
      .map((r) => {
        const teams: CatalogTeam[] = r.players == null ? [] : JSON.parse(r.players as string);
        return {
          id: r.id as string,
          startUnix: r.start_unix as number,
          map: (r.map as string | null) ?? null,
          players: teams.flatMap((t) => t.players.map((p) => p.name)),
        };
      });
    let matched = 0;
    // Non-null by the query's own predicate; flatMap rather than a cast so the
    // guard below is the type narrowing too.
    const starts = games.flatMap((g) => (g.startUnix === null ? [] : [g.startUnix]));
    if (starts.length > 0) {
      // The gate is startedUnix - startUnix in [-EARLY_SLACK, +WINDOW]; this
      // is that inequality solved for started_unix, over the arrivals — a few
      // minutes of observations off lobbies_started.
      const lobbies: MatchLobby[] = sql
        .exec(
          `SELECT lobby_id, started_unix, map, players,
                  json_extract(lobby_details, '$.end.map') AS end_map,
                  json_extract(lobby_details, '$.end.players') AS end_players
           FROM lobbies
           WHERE matched_game_id IS NULL AND started_unix BETWEEN ? AND ?`,
          Math.min(...starts) - LOBBY_MATCH_EARLY_SLACK_SEC,
          Math.max(...starts) + LOBBY_MATCH_WINDOW_SEC,
        )
        .toArray()
        .map((r) => ({
          lobbyId: r.lobby_id as number,
          startedUnix: r.started_unix as number,
          map: (r.map as string | null) ?? null,
          players: r.players == null ? null : JSON.parse(r.players as string),
          ...lobbyEnd(r),
        }));
      for (const m of pickLobbyMatches(lobbies, games)) {
        // lobby_details rides the same write-once UPDATE: the observation is
        // pruned 48h after a match, so this copy is the detail's only route
        // to permanence. A pre-column observation copies NULL harmlessly.
        //
        // The match also RE-OPENS the game to the lava sync (lava_offered_unix
        // back to NULL), which matters in exactly one order of events: the game
        // was submitted before its lobby was matched, so lavabalance stored it
        // with no parties. Re-offering it once carries them (its upload fills a
        // NULL lobby column on a duplicate and answers "duplicate" otherwise),
        // and because this UPDATE is write-once on lobby_name it cannot loop.
        sql.exec(
          `UPDATE games SET
             lobby_name    = (SELECT name FROM lobbies WHERE lobby_id = ? AND started_unix = ?),
             lobby_id      = ?,
             lobby_details = (SELECT lobby_details FROM lobbies WHERE lobby_id = ? AND started_unix = ?),
             lava_offered_unix = NULL
           WHERE id = ? AND lobby_name IS NULL`,
          m.lobbyId,
          m.startedUnix,
          m.lobbyId,
          m.lobbyId,
          m.startedUnix,
          m.gameId,
        );
        // Matching also RETIRES the observation (ended_unix, if the page diff
        // had not closed it already): the matched game has certainly ended,
        // even when the lobby never left the in-progress set — the
        // back-to-back-games case, where the next game started inside one
        // cron gap. With the old observation retired, the next sync tick sees
        // the lobby in progress with no open entry and opens a FRESH
        // observation for the game now running (started back-dated by the
        // page's own clock), which is what lets one lobby name game after
        // game.
        sql.exec(
          `UPDATE lobbies SET matched_game_id = ?, ended_unix = COALESCE(ended_unix, ?)
           WHERE lobby_id = ? AND started_unix = ?`,
          m.gameId,
          now,
          m.lobbyId,
          m.startedUnix,
        );
        matched++;
      }
    }
    const pruned = sql.exec(
      `DELETE FROM lobbies WHERE matched_game_id IS NOT NULL AND started_unix < ?`,
      now - LOBBY_MATCHED_KEEP_SEC,
    ).rowsWritten;
    return { matched, pruned };
  }

  /** lobbyMisses is the admin report on games the lobby match left unnamed:
   * every game that ENDED in the last `hours` (capped at 48, the matched
   * observations' retention) with no lobby, each with the observations near
   * its start — same map or a shared player, started within an hour either
   * way — and the verdict of every gate pickLobbyMatches applies
   * (lobbyNearMisses). Read-only and on demand, so its cost is a window of
   * the mirror off games_end plus the lobbies two hours wide around it off
   * lobbies_started — a few thousand rows, never a table. */
  lobbyMisses(hours = 24): {
    from: number;
    to: number;
    games: number;
    unmatched: { id: string; map: string | null; startUnix: number; durationSec: number | null; gameSize: string | null; nearest: LobbyNearMiss[] }[];
  } {
    const sql = this.ctx.storage.sql;
    const to = Math.floor(Date.now() / 1000);
    const from = to - Math.max(1, Math.min(48, Math.floor(hours))) * 3600;
    const all = sql
      .exec(
        `SELECT id, start_unix, duration_sec, map, game_size, players, lobby_name FROM games
         WHERE end_unix BETWEEN ? AND ? AND start_unix IS NOT NULL`,
        from,
        to,
      )
      .toArray();
    const miss = all.filter((r) => r.lobby_name == null);
    if (miss.length === 0) return { from, to, games: all.length, unmatched: [] };
    const starts = miss.map((r) => r.start_unix as number);
    const lobbies = sql
      .exec(
        `SELECT lobby_id, started_unix, name, map, players, matched_game_id, ended_unix,
                json_extract(lobby_details, '$.end.map') AS end_map,
                json_extract(lobby_details, '$.end.players') AS end_players
         FROM lobbies
         WHERE started_unix BETWEEN ? AND ?`,
        Math.min(...starts) - 3600,
        Math.max(...starts) + 3600,
      )
      .toArray()
      .map((r) => ({
        lobbyId: r.lobby_id as number,
        startedUnix: r.started_unix as number,
        name: r.name as string,
        map: (r.map as string | null) ?? null,
        players: r.players == null ? null : (JSON.parse(r.players as string) as string[]),
        ...lobbyEnd(r),
        matchedGameId: (r.matched_game_id as string | null) ?? null,
        endedUnix: (r.ended_unix as number | null) ?? null,
      }));
    const unmatched = miss.map((r) => {
      const startUnix = r.start_unix as number;
      const teams: CatalogTeam[] = r.players == null ? [] : JSON.parse(r.players as string);
      const game: MatchGame = {
        id: r.id as string,
        startUnix,
        map: (r.map as string | null) ?? null,
        players: teams.flatMap((t) => t.players.map((p) => p.name)),
      };
      const near = lobbies.filter((l) => Math.abs(l.startedUnix - startUnix) <= 3600);
      return {
        id: game.id,
        map: game.map,
        startUnix,
        durationSec: (r.duration_sec as number | null) ?? null,
        gameSize: (r.game_size as string | null) ?? null,
        nearest: lobbyNearMisses(game, near),
      };
    });
    unmatched.sort((a, b) => b.startUnix - a.startUnix);
    return { from, to, games: all.length, unmatched };
  }

  /** jobInsert records fresh work as a pending ingest job. A "resim" carries
   * no streamKey (pass ""); it is queued through resimEnqueue below, which is
   * where the refusals live. */
  jobInsert(
    id: string,
    streamKey: string,
    gameId: string,
    kind: JobKind = "upload",
    installId: string | null = null,
    note: string | null = null,
    parentId: string | null = null,
  ): void {
    const now = Math.floor(Date.now() / 1000);
    // A parent is taken only when it is an "app" job of the same game: the
    // id comes from an open route, and a wrong one would hide this job
    // inside somebody else's row.
    if (parentId !== null) {
      const parent = this.jobGet(parentId);
      if (parent === null || parent.kind !== "app" || parent.gameId !== gameId) parentId = null;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO jobs (id, stream_key, game_id, kind, state, error, install_id, parent_id, note, created_unix, updated_unix)
       VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?)`,
      id,
      streamKey,
      gameId,
      kind,
      installId,
      parentId,
      note,
      now,
      now,
    );
    // The maintained count of the rows queuePage lists (JOBS_COUNT_KEY): one
    // meta row touched per insert, against the COUNT(*) per page view it
    // replaces, whose cost was the table. A job with a parent is not listed
    // (it shows inside its parent's row), so it is not counted either.
    if (parentId !== null) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO schema_meta (key, value) VALUES (?, 1)
       ON CONFLICT(key) DO UPDATE SET value = value + 1`,
      JOBS_COUNT_KEY,
    );
  }

  /** resimEnqueue takes a re-simulation request for one game. Both checks and
   * the insert happen in here, in one RPC, so two people pasting the same link
   * at the same moment cannot both queue an hour of engine time.
   *
   * "in-catalog": the game already has a FULL VIEW published (a re-sim or a
   * spectator's capture), so re-simulating it would mostly repeat it. The
   * request is not thrown away: it lands as a DISABLED job carrying `note`,
   * so it is on the queue page and an admin who wants it anyway enables it.
   * The answer carries the full view's rid, for the caller to name the .brp
   * format version in the note (jobSetNote). A game published only from a
   * playing client's side still wants its full view and is queued normally.
   * "duplicate"/"disabled": a re-sim of this game is already queued or
   * running (or held back) — the caller gets that job back, which makes
   * re-pasting a link harmless. */
  resimEnqueue(id: string, gameId: string, note = "Already simulated"): JobEnqueue {
    // `placeholder = 0`: a row that only exists because the game is being
    // worked on right now is not a reason to refuse — "already published" would
    // be a lie, and the duplicate check in jobAnnounce is the honest answer,
    // which hands back the job doing the work.
    const known = this.ctx.storage.sql
      .exec(`SELECT rid, uploads, uploader_ally FROM replays WHERE id = ? AND placeholder = 0`, gameId)
      .toArray();
    if (known.length === 0) return this.jobAnnounce(id, gameId, "resim");
    const uploads: UploadRef[] | null = known[0].uploads != null ? JSON.parse(known[0].uploads as string) : null;
    if (wantsFullView(known[0].uploader_ally as number | null, uploads)) return this.jobAnnounce(id, gameId, "resim");
    const res = this.jobAnnounce(id, gameId, "resim");
    if (res.status !== "queued") return res;
    this.ctx.storage.sql.exec(`UPDATE jobs SET disabled = 1, note = ? WHERE id = ?`, note, id);
    const full = (uploads ?? []).filter((u) => u.ally === null).pop();
    return { status: "in-catalog", job: this.jobGet(id), rid: full?.rid ?? (known[0].rid as string | null) ?? gameId };
  }

  /** resimRequest is the PUBLIC door: the "not simulated yet" page's request
   * button, open to anyone who lands on a game nobody has published. It is
   * resimEnqueue's dedupe with two stricter refusals, because the admin
   * paste box's gate is what it lacks:
   *
   * - "published": a playable replay exists, so there is nothing to request
   *   (no disabled job is recorded either — that note is for an admin).
   * - "full": at most `maxPending` public requests wait at once. This is what
   *   bounds what the open route can cost: a script asking for every game
   *   fills the cap and is refused past it, instead of queueing hours of
   *   engine time per minute (it happened to /api/admin/resim when that was
   *   open). Counted over the pending rows of jobs_state, so the read is the
   *   size of the waiting queue, never of the table.
   *
   * A game already queued or running hands back that job ("duplicate"), so
   * the button can follow it instead of adding another. */
  resimRequest(id: string, gameId: string, note: string, maxPending: number): ResimRequest {
    const known = this.ctx.storage.sql
      .exec(`SELECT 1 FROM replays WHERE id = ? AND placeholder = 0`, gameId)
      .toArray();
    if (known.length > 0) return { status: "published", job: null };
    const active = this.ctx.storage.sql
      .exec(
        `SELECT ${JOB_COLS} FROM jobs
         WHERE game_id = ? AND kind = 'resim' AND state IN ('pending', 'processing')
         ORDER BY created_unix, id LIMIT 1`,
        gameId,
      )
      .toArray();
    if (active.length > 0) {
      const job = jobRow(active[0]);
      return { status: job.disabled ? "disabled" : "duplicate", job };
    }
    const waiting = Number(
      this.ctx.storage.sql
        .exec(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'pending' AND note = ?`, note)
        .toArray()[0].n,
    );
    if (waiting >= maxPending) return { status: "full", job: null };
    this.jobInsert(id, "", gameId, "resim", null, note);
    return { status: "queued", job: this.jobGet(id) };
  }

  /** jobSetNote replaces one job's note (null clears it). */
  jobSetNote(id: string, note: string | null): void {
    this.ctx.storage.sql.exec(`UPDATE jobs SET note = ? WHERE id = ?`, note, id);
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

  /** jobRetry queues the same work again under a fresh id: the queue page's
   * "Retry" for a job that failed (or finished, when a re-run is wanted).
   * Null when the id is unknown.
   *
   * Nothing is retried in place. The old row is the record of what happened
   * — its error, its stats, its samples — and a state flipped back to pending
   * would lose that, while a fresh row keeps both attempts side by side. A
   * re-sim goes through jobAnnounce, so a job already pending or running for
   * the game is handed back instead of doubled ("duplicate"), and a held-back
   * one says so ("disabled"). An upload is re-queued against the SAME archived
   * stream, which is still in the bucket (the archive is append-only), with
   * the same guard on an active job for that stream. */
  jobRetry(newId: string, id: string): JobEnqueue | null {
    const job = this.jobGet(id);
    if (job === null) return null;
    // An app run is retried as an ordinary re-sim: the app that ran it is not
    // something the worker can ask, a daemon is.
    if (job.kind === "resim" || job.kind === "app") return this.jobAnnounce(newId, job.gameId, "resim");
    const active = this.ctx.storage.sql
      .exec(
        `SELECT ${JOB_COLS} FROM jobs
         WHERE stream_key = ? AND kind = 'upload' AND state IN ('pending', 'processing')
         ORDER BY created_unix, id LIMIT 1`,
        job.streamKey,
      )
      .toArray();
    if (active.length > 0) {
      const cur = jobRow(active[0]);
      return { status: cur.disabled ? "disabled" : "duplicate", job: cur };
    }
    this.jobInsert(newId, job.streamKey, job.gameId, "upload", job.installId, job.note);
    return { status: "queued", job: this.jobGet(newId) };
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
    // TWO branches over jobs_kind (kind, state, updated_unix) rather than one
    // `state = 'pending' OR (state = 'processing' AND ...)`: the OR hides the
    // state column and SQLite answers it by reading the whole jobs table —
    // which two daemons poll every ten seconds, over a table that gains a row
    // per upload and per re-sim and never loses one. Each branch here is a
    // seek, so the read is the size of the ANSWER, not of the table.
    return this.ctx.storage.sql
      .exec(
        `SELECT ${JOB_COLS} FROM jobs
           WHERE kind = ? AND state = 'pending' AND disabled = 0
         UNION ALL
         SELECT ${JOB_COLS} FROM jobs
           WHERE kind = ? AND state = 'processing' AND disabled = 0 AND updated_unix < ?
         ORDER BY created_unix, id`,
        kind,
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
   * inferring it from a missing rid would be wrong, since unrevisioned rows
   * have none and are perfectly playable. A publish clears the mark
   * (upsert writes placeholder = 0), and a job that ends without one takes the
   * row away again, so a failed re-sim leaves no dead entry behind.
   *
   * It seeds what it can from the games mirror — a row showing the map and the
   * players beats one showing five dashes — and re-indexes the derived tables
   * from that same data, because the catalog row it just made now OWNS those
   * entries (see indexSettings). With nothing to seed from it indexes nothing:
   * the alternative, indexing null, would DELETE whatever the mirror had put
   * there. */
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
      this.indexSettings(gameId, g.settings == null ? null : JSON.parse(g.settings as string));
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

  /** lavaCandidate is the backfill's PRIORITY lookup: the most recently ended
   * 8v8 lava game of the last LAVA_WINDOW_SEC that nothing has captured and
   * nothing has queued, or null.
   *
   * It exists because the general backfill cannot reach these games. That one
   * ranks over the newest BACKFILL_WINDOW candidates, which on a mirror the
   * daemon cannot keep up with is the last couple of hours — so a lava game
   * that is not among them by the time a host is free is not merely
   * outranked, it is invisible, and stays invisible as the head of the list
   * refills ahead of it forever. Ranking lava higher inside that query would change nothing:
   * a rank the window never reads is not a rank. What this needs, and has, is
   * a window measured in TIME.
   *
   * WHY THESE GAMES FIRST. A lava game is the mode's own tweakdefs, and a
   * spectator view of it is most of what the capture is for — the sibling
   * lavabalance worker rates exactly these, and an 8v8 is the shape it wants
   * (the general backfill already prefers modded and prefers bigger, for the
   * same reasons; this is those two preferences made reachable rather than a
   * new opinion).
   *
   * CANDIDATE means the same thing here as it does there: a mirrored game with
   * no catalog row and NO JOB ROW AT ALL, done and errored ones included, or a
   * lava game that fails to re-simulate would be handed straight back out on
   * the next poll, an hour of engine time at a time. Pasting its link stays the
   * retry.
   *
   * THE WALK is games_end, latest-ended-first, stopped at the window's
   * edge — a range over the index, so its cost is a day of BAR's output (~2000
   * rows) whatever the mirror has grown to, and it stops at the FIRST match, so
   * a lava game near the head costs a handful. The flag test is a seek into replay_settings' (flag, replay_id) index, and a
   * mirrored game always owns its own entries there (see indexSettings), so the
   * flag read is the game's own.
   *
   * No ranking beyond recency: every 8v8 is sixteen players, so within one
   * shape and one window the newest is simply the one someone might still be
   * asking about. */
  private lavaCandidate(now: number): { id: string; end: number } | null {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT g.id AS id, g.end_unix AS end_unix FROM games g
          WHERE g.end_unix >= ?
            AND g.game_size = ?
            AND EXISTS (SELECT 1 FROM replay_settings s
                        WHERE s.replay_id = g.id AND s.flag = ?)
            AND NOT EXISTS (SELECT 1 FROM replays r WHERE r.id = g.id)
            AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.game_id = g.id)
          ORDER BY g.end_unix DESC, g.id
          LIMIT 1`,
        now - LAVA_WINDOW_SEC,
        LAVA_GAME_SIZE,
        SETTINGS_LAVA_FLAG,
      )
      .toArray();
    return rows.length === 0 ? null : { id: rows[0].id as string, end: rows[0].end_unix as number };
  }

  /** lavaEnds maps each of gameIds that is an 8v8 lava game to when it ENDED
   * — what jobsOffer orders the waiting lava work by. One primary-key seek
   * and one flag seek per id, over a pending list that is a handful long. */
  private lavaEnds(gameIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const id of new Set(gameIds)) {
      const r = this.ctx.storage.sql
        .exec(
          `SELECT g.end_unix AS end_unix FROM games g
            WHERE g.id = ? AND g.game_size = ? AND g.start_unix IS NOT NULL
              AND EXISTS (SELECT 1 FROM replay_settings s
                          WHERE s.replay_id = g.id AND s.flag = ?)`,
          id,
          LAVA_GAME_SIZE,
          SETTINGS_LAVA_FLAG,
        )
        .toArray();
      if (r.length > 0) out.set(id, r[0].end_unix as number);
    }
    return out;
  }

  /** lavaRetryCandidate is the lava lookup's SECOND chance: an 8v8 lava game
   * whose re-simulation FAILED and that the asking host might still finish,
   * or null. See LAVA_RETRY_WINDOW_SEC for why failures need one.
   *
   * A game qualifies when its jobs are ALL failures (none active, none done,
   * none disabled — a disabled job is how a person says "leave it"), nothing
   * is in the catalog for it, it ran out of memory, and no host with at least
   * the asker's memory ever did on it (memBytes is the failing host's total
   * RAM, which bringest reports with every job; an older daemon's failure
   * carries none and counts as a small host's). Any other failure is never
   * retried automatically (Marcin's call); the queue page's Retry is the door.
   * Each retry is a fresh job (the old row stays the record of the attempt),
   * so a retry that runs out of memory again is a failure on THIS host's
   * memory, and only a bigger one will try after it.
   *
   * THE WALK is jobs_failed, newest failure first, stopped at the window's
   * edge: its cost is the failures of two weeks (a few hundred) and a few
   * seeks each, and it rests per memory size on the empty answer. */
  private lavaRetryCandidate(now: number, memBytes: number): string | null {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT g.id AS id FROM jobs j JOIN games g ON g.id = j.game_id
          WHERE j.state = 'error'
            AND j.created_unix >= ?
            AND j.kind = 'resim'
            AND g.game_size = ?
            AND EXISTS (SELECT 1 FROM replay_settings s
                        WHERE s.replay_id = g.id AND s.flag = ?)
            AND NOT EXISTS (SELECT 1 FROM replays r WHERE r.id = g.id)
            AND NOT EXISTS (SELECT 1 FROM jobs k WHERE k.game_id = g.id
                            AND (k.state != 'error' OR k.disabled != 0))
            AND NOT EXISTS (SELECT 1 FROM jobs k WHERE k.game_id = g.id
                            AND k.state = 'error' AND k.error_kind = 'oom'
                            AND COALESCE(json_extract(k.stats, '$.host.memBytes'), 0) >= ?)
            AND j.error_kind = 'oom'
          ORDER BY j.created_unix DESC
          LIMIT 1`,
        now - LAVA_RETRY_WINDOW_SEC,
        LAVA_GAME_SIZE,
        SETTINGS_LAVA_FLAG,
        memBytes,
      )
      .toArray();
    return rows.length === 0 ? null : (rows[0].id as string);
  }

  /** jobsOffer is what the daemon's poll actually gets: the pending work of
   * its kind and, when a re-sim daemon would otherwise go home empty-handed,
   * one job queued on the spot from the games mirror.
   *
   * TWO scans make that job, asked in order. First lavaCandidate — an 8v8 lava
   * game of the last day — which is a priority and, more to the point, is the
   * one class of game the second scan structurally cannot reach; see its own
   * note. Then the ranked window below, which is everything else.
   *
   * Of the BACKFILL_WINDOW most recently ENDED candidates it takes the one
   * with the MOST PLAYERS: an hour of engine time buys an 8v8 as cheaply as a
   * duel, so within a window of games that are all recent, size is what
   * decides. End time rather than start time because that is the order games
   * ARRIVE in — a game is mirrored only once it is over, so ordering by start
   * buried every long game under the shorter ones that started after it (see
   * BACKFILL_WINDOW).
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
   * A MODDED game — any tweakdefs/tweakunits slot set, which is exactly what
   * the settings' `mods` flag records — is taken FIRST, ahead of a bigger one.
   * It is the rarer thing and the less replaceable: an 8v8 nobody re-simulates
   * today is one of forty played this hour, where a game running somebody's
   * tweaks is the only one of its kind, and the tweaks are most of what a
   * spectator view of it would be for. The same rule prefers the modes that
   * SHIP as tweak blobs — lava, zombies — which is the same thing said twice
   * rather than an accident.
   *
   * This was a REFUSAL until it was measured: modded games are ~0 in 24 of
   * BAR's output, so excluding them bought nothing and cost the only games in
   * the mirror that are not interchangeable.
   *
   * The ranked window backfills only into an EMPTY pending list (the lava
   * lookup alone may add to a non-empty one, and only a game that ended later
   * than every queued lava game), so at most one auto-queued job is ever
   * waiting: the next poll finds that job rather than making
   * another. The check and the insert are one RPC — the DO is single-threaded,
   * so two daemons polling together cannot both queue the same game.
   *
   * The scan is cheap because it STOPS EARLY, not because it looks at a slice:
   * it walks games_end latest-ended-first and quits at the 200th
   * candidate, which on a mirror this daemon cannot keep up with is the first
   * two hundred rows it touches. That distinction is the whole design. A fixed
   * window over the newest N games reads the same rows in the good case and then LIES
   * in the bad one — with the newest N all taken it reports an empty mirror
   * while thousands of older candidates sit behind the window, and the daemon
   * goes to sleep in front of a queue it cannot see. An empty answer here has
   * to mean the mirror is empty.
   *
   * What it costs when the head IS stale is one index entry and one row per
   * game stepped over (measured: 861 rows to walk past 400 taken games), and
   * that only happens after the daemon has published its way through the
   * recent past — the state where being handed older work is exactly right.
   * The RATE bound (BACKFILL_COOLDOWN_SEC) covers the genuinely-empty case,
   * where this does scan the whole table before giving up.
   *
   * This makes a GET write, which is the deliberate cost of leaving the
   * daemon's protocol alone: a poll that returns a job it just created is
   * indistinguishable, to the daemon, from one that returns a job a person
   * queued a minute ago. */
  jobsOffer(kind: JobKind, newJobId: string, hostMemBytes = 0): IngestJob[] {
    const pending = this.jobsPending(kind);
    if (kind !== "resim") return pending;
    // Everything below the lava lookups is a scan whose cost is measured in
    // the size of the mirror, and an idle daemon asks 8640 times a day. So a
    // scan that comes up EMPTY rests — that is the state a poll can repeat
    // forever with nothing changing. A scan that finds a game does not: the
    // daemon leaves with it and stops asking.
    const now = Math.floor(Date.now() / 1000);

    // LAVA FIRST, NEWEST FIRST (Marcin, 2026-10-17): of every 8v8 lava game
    // waiting — queued by hand, announced, or finished a minute ago and not
    // queued yet — the one that ENDED most recently is the most relevant and
    // runs first, and no other game runs while one is waiting. So the pending
    // list is reordered with its lava games at the head, latest-ended first,
    // and the newest unqueued lava game (lavaCandidate, on its own rest)
    // jumps that list when it ended later than everything on it. The daemon
    // takes one job per poll, so a game that finishes while another runs is
    // what the NEXT poll is handed.
    const ends = this.lavaEnds(pending.map((p) => p.gameId));
    const lavaPending = pending.filter((p) => ends.has(p.gameId));
    lavaPending.sort((a, b) => ends.get(b.gameId)! - ends.get(a.gameId)!);
    const ordered = [...lavaPending, ...pending.filter((p) => !ends.has(p.gameId))];
    const newestQueued = lavaPending.length > 0 ? ends.get(lavaPending[0].gameId)! : null;

    // The unqueued lava lookup, rested on its own key: its empty answer is
    // both the common one and much more expensive than jobsPending, and
    // sharing the general backfill's rest would let either one silence the
    // other. It is also the one class of game the ranked window below cannot
    // see at all (see lavaCandidate).
    const lavaRest = this.metaGet("lava_after");
    if (lavaRest === null || now >= lavaRest) {
      const lava = this.lavaCandidate(now);
      if (lava !== null) {
        if (newestQueued === null || lava.end > newestQueued) {
          return [...this.offerBackfilled(newJobId, lava.id), ...ordered];
        }
      } else {
        this.metaPut("lava_after", now + LAVA_COOLDOWN_SEC);
      }
    }
    if (ordered.length > 0) return ordered;

    // Then the lava games that FAILED and this host might finish (see
    // lavaRetryCandidate) — still ahead of everything that is not lava. Only
    // for a daemon that says how much memory it has: without that, an oom
    // retry could go straight back to a host as small as the one it failed on.
    if (hostMemBytes > 0) {
      const restKey = `lava_retry_after_${Math.floor(hostMemBytes / 2 ** 30)}`;
      const retryRest = this.metaGet(restKey);
      if (retryRest === null || now >= retryRest) {
        const retry = this.lavaRetryCandidate(now, hostMemBytes);
        if (retry !== null) return this.offerBackfilled(newJobId, retry);
        this.metaPut(restKey, now + LAVA_RETRY_COOLDOWN_SEC);
      }
    }

    const restUntil = this.metaGet("backfill_after");
    if (restUntil !== null && now < restUntil) return [];
    const candidate = this.ctx.storage.sql
      .exec(
        `SELECT id FROM (
           SELECT g.id AS id, g.player_count AS player_count,
                  g.end_unix AS end_unix,
                  -- Ranked on below, not filtered on: a modded game is the
                  -- one this pipeline is most worth spending an hour of engine
                  -- time on, since it is the one nobody else can look at.
                  -- Read from the derived table rather than the row's settings
                  -- JSON: the flag index (flag, replay_id) makes it a seek,
                  -- and a mirrored game always owns its own entries there.
                  EXISTS (SELECT 1 FROM replay_settings s
                          WHERE s.replay_id = g.id AND s.flag = ?) AS modded
           FROM games g
           WHERE NOT EXISTS (SELECT 1 FROM replays r WHERE r.id = g.id)
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.game_id = g.id)
           -- Walks games_end latest-ended-first and STOPS at the
           -- BACKFILL_WINDOWth candidate, which is what makes the scan cost
           -- the size of its answer instead of the size of the mirror. No
           -- leading IS-NULL term: it would hide the column from the index
           -- and sort the whole mirror; NULL is smaller than every value, so
           -- DESC puts the start-less rows last by itself.
           -- The trailing id only block-sorts each equal-timestamp group, so
           -- early termination survives it.
           ORDER BY g.end_unix DESC, g.id
           LIMIT ${BACKFILL_WINDOW}
         )
         -- MODDED first, then the biggest; a game whose roster the API never
         -- gave goes last, and an exact tie goes to the latest-ended one.
         -- Modded beats bigger because it is rarer and less replaceable: an
         -- 8v8 that nobody re-simulates today is one of forty played this
         -- hour, where the game with tweakdefs in it is the only one of its
         -- kind, and it is the mode's own tweaks that a spectator view is
         -- worth having of.
         ORDER BY modded DESC, player_count IS NULL, player_count DESC, end_unix DESC, id
         LIMIT 1`,
        SETTINGS_MODS_FLAG,
      )
      .toArray();
    if (candidate.length === 0) {
      this.metaPut("backfill_after", now + BACKFILL_COOLDOWN_SEC);
      return [];
    }
    return this.offerBackfilled(newJobId, candidate[0].id as string);
  }

  /** offerBackfilled queues a game one of jobsOffer's two scans just picked and
   * hands the daemon the row, which is what makes an auto-queued job
   * indistinguishable from one a person pasted a link for a minute earlier. */
  private offerBackfilled(newJobId: string, gameId: string): IngestJob[] {
    this.jobInsert(newJobId, "", gameId, "resim");
    const job = this.jobGet(newJobId);
    return job === null ? [] : [job];
  }

  /** queuePage is the queue as a PERSON reads it (GET /api/queue): one page of
   * jobs, everything still in flight first — those are what the view exists to
   * answer for — then the most recently settled, newest first. Unlike
   * jobsPending it does not hide a fresh "processing" job: a daemon working
   * right now is exactly what the viewer wants to see, even though it is not
   * work to hand out.
   *
   * `total` and `active` are counted over the WHOLE table, not the page, so a
   * pager can say how much it is paging through and the menu's in-flight count
   * stays true on any page.
   *
   * TWO queries plus a meta row, assembled here, instead of the one query this
   * used to be. That one led its ORDER BY with the unfinished-first CASE, which
   * no index can satisfy, so every read joined and sorted the WHOLE jobs table
   * into a temp b-tree and the LIMIT saved nothing — measured at 2122 rows to
   * return one, on a 451-job table that only ever grows (the ROW BUDGET
   * pattern this codebase keeps refusing, this time on an admin click instead
   * of a timer). Split at exactly the CASE's boundary, each half is index
   * work: the in-flight jobs come off jobs_state and are read IN FULL (bounded
   * by work actually in flight, which drains — never by the table, which
   * doesn't), the settled ones walk the jobs_settled partial index in display
   * order and stop at the page edge, and the joins run only for rows actually
   * paged. Deep pages still pay O(offset), like the catalog list. */
  queuePage(limit: number, offset: number): { jobs: QueueJob[]; total: number; active: number } {
    // The jobs table knows a gameId and nothing else about the game, so the
    // duration, team spec, start, map and settings are joined on from whichever table knows
    // them: the catalog first (what was captured), the games mirror second
    // (what BAR published), which is what covers the re-sim of a game
    // nobody has uploaded — most of this queue.
    //
    // EVERY column in the ORDER BY is qualified, and has to be: `id` is in
    // all three tables and `updated_unix` is in two of them, so an
    // unqualified one is an ambiguous-column error rather than a wrong
    // answer.
    const select = QUEUE_SELECT;
    const active = this.ctx.storage.sql
      .exec(
        `${select}
         WHERE j.state IN ('pending', 'processing') AND j.disabled = 0 AND j.parent_id IS NULL
         ORDER BY j.updated_unix DESC, j.id`,
      )
      .toArray()
      .map(queueJobRow);
    const fromActive = active.slice(offset, offset + limit);
    // The settled half fills what the page has left, its offset shifted by
    // the actives that precede it in the combined order. The WHERE repeats
    // jobs_settled's clause TEXTUALLY — that identity is what lets the
    // planner take the partial index, walk it in display order, and stop at
    // the page edge instead of sorting the table (see INDEX_DDL).
    let settled: QueueJob[] = [];
    if (fromActive.length < limit) {
      settled = this.ctx.storage.sql
        .exec(
          `${select}
           WHERE (j.state NOT IN ('pending', 'processing') OR j.disabled != 0) AND j.parent_id IS NULL
           ORDER BY j.updated_unix DESC, j.id
           LIMIT ? OFFSET ?`,
          limit - fromActive.length,
          Math.max(0, offset - active.length),
        )
        .toArray()
        .map(queueJobRow);
    }
    // The maintained count (see JOBS_COUNT_KEY). The COUNT(*) fallback is
    // only reachable while the derived seed has not landed — a database
    // serving through a budget overage — and self-heals with the seed.
    let total = this.metaGet(JOBS_COUNT_KEY);
    if (total === null) {
      total = Number(this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM jobs`).toArray()[0].n);
    }
    // `active` is the rows already in hand — reading them all is what made
    // the count free.
    return { jobs: [...fromActive, ...settled], total, active: active.length };
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
    // The cap is checked against the CACHED count and confirmed against the
    // table only when that count says the series is full — so the ordinary
    // beat reads nothing at all, and the exact count is paid once per job (and
    // once per thin), instead of once per beat.
    const cached = this.sampleCounts.get(jobId);
    const n = cached === undefined ? this.jobSampleCount(jobId) : cached + 1;
    this.sampleCounts.set(jobId, n);
    if (n > MAX_JOB_SAMPLES) {
      const exact = this.jobSampleCount(jobId);
      if (exact > MAX_JOB_SAMPLES) {
        this.jobSampleThin(jobId);
        this.sampleCounts.set(jobId, this.jobSampleCount(jobId));
      } else {
        this.sampleCounts.set(jobId, exact);
      }
    }
  }

  private jobSampleCount(jobId: string): number {
    return this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS n FROM job_samples WHERE job_id = ?`, jobId)
      .toArray()[0].n as number;
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

  /** jobSamplePrune drops the history of the jobs that finished before
   * `before`. Called from the cron; the table would otherwise be the one thing
   * here that grows without a rule. Returns how many rows it removed.
   *
   * Driven from the JOBS table, over a BAND of finishing times, which is two
   * deliberate narrowings of the obvious query.
   *
   * Jobs-first, because `SELECT DISTINCT job_id FROM job_samples` reads every
   * sample ever recorded — tens of thousands of rows, every time it is asked,
   * to name a few dozen jobs the jobs table can name from an index. (That also
   * gives up finding samples whose job row is GONE: nothing in this worker
   * deletes a job, so there are none, and hunting for them was the entire cost
   * of the query.)
   *
   * The band, because a job that finished a year ago is 'done' forever: asked
   * for everything older than the cutoff, this would re-probe every job it has
   * already pruned, for as long as the deployment lives. The watermark is the
   * cutoff of the last run, so each finished job is visited exactly once, on
   * the run after it ages out. */
  jobSamplePrune(before: number): number {
    const from = this.metaGet("samples_pruned_before") ?? 0;
    this.metaPut("samples_pruned_before", before);
    if (before <= from) return 0;
    const cur = this.ctx.storage.sql.exec(
      // One branch per terminal state so both are seeks on jobs_state
      // (state, updated_unix); `state IN (...)` over a range is not.
      `DELETE FROM job_samples WHERE job_id IN (
         SELECT id FROM jobs WHERE state = 'done'  AND updated_unix >= ? AND updated_unix < ?
         UNION ALL
         SELECT id FROM jobs WHERE state = 'error' AND updated_unix >= ? AND updated_unix < ?
       )`,
      from,
      before,
      from,
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
    errorKind: JobErrorKind | null = null,
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
      `UPDATE jobs SET state = ?, error = ?, error_kind = ?, stats = COALESCE(?, stats),
              progress = CASE WHEN ? = 'processing' THEN COALESCE(?, progress) ELSE NULL END,
              updated_unix = ?
       WHERE id = ?`,
      state,
      error,
      // Follows `error` exactly, not COALESCEd like the stats: it is a property
      // OF that message, so a transition that clears the message and keeps its
      // classification would be describing a failure that is no longer there.
      errorKind,
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
    // A finished job beats no more, so its cached sample count is dead weight
    // (and would be wrong if the row were ever revived by a claim, which
    // clears nothing here — the count is rebuilt from the table on the next
    // beat either way).
    else if (state !== "processing") this.sampleCounts.delete(id);
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

  /** appJobStart records a re-simulation FogOfWar.exe has just started on
   * somebody's PC: an "app" job, created already "processing" (nothing hands
   * it out — the app is doing the work), with the run's opening stats (the
   * app, its install, the host). Like any job entering "processing" it puts
   * the game into the catalog as work in progress. */
  appJobStart(id: string, gameId: string, installId: string, stats: JobStats | null): IngestJob | null {
    this.jobInsert(id, "", gameId, "app", installId);
    this.jobUpdate(id, "processing", null, stats, null);
    return this.jobGet(id);
  }

  /** appJobUpdate is jobUpdate for the app's open route, which may touch only
   * "app" jobs: every other job is a daemon's, reported over the guarded
   * route. "unknown" when the id names no job, "not-app" for a daemon's. */
  appJobUpdate(
    id: string,
    state: "processing" | "done" | "error",
    error: string | null,
    stats: JobStats | null,
    progress: JobProgress | null,
    errorKind: JobErrorKind | null,
  ): "ok" | "unknown" | "not-app" {
    const job = this.jobGet(id);
    if (job === null) return "unknown";
    if (job.kind !== "app") return "not-app";
    this.jobUpdate(id, state, error, stats, progress, errorKind);
    return "ok";
  }

  /** appJobsExpire fails the "app" jobs that stopped reporting (see
   * APP_JOB_STALE_SEC) and takes their games' placeholders out of the
   * catalog. Called from the cron. A seek on jobs_kind (kind, state,
   * updated_unix) bounded by the app jobs in flight. Returns how many. */
  appJobsExpire(now = Math.floor(Date.now() / 1000)): number {
    const stale = this.ctx.storage.sql
      .exec(
        `SELECT id, game_id FROM jobs
         WHERE kind = 'app' AND state = 'processing' AND updated_unix < ?`,
        now - APP_JOB_STALE_SEC,
      )
      .toArray();
    for (const r of stale) {
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET state = 'error', error = ?, progress = NULL, updated_unix = ? WHERE id = ?`,
        "The app stopped reporting (closed, crashed, or the PC went to sleep).",
        now,
        r.id as string,
      );
      this.sampleCounts.delete(r.id as string);
      this.dropCatalogPlaceholder(r.game_id as string);
    }
    return stale.length;
  }

  /** jobsByInstall is one FogOfWar.exe install's jobs, newest first: the
   * queue page filtered to an install id. A seek on jobs_install. */
  jobsByInstall(installId: string, limit: number, offset: number): { jobs: QueueJob[]; total: number } {
    const jobs = this.ctx.storage.sql
      .exec(
        `${QUEUE_SELECT}
         WHERE j.install_id = ? AND j.parent_id IS NULL
         ORDER BY j.created_unix DESC
         LIMIT ? OFFSET ?`,
        installId,
        limit,
        offset,
      )
      .toArray()
      .map(queueJobRow);
    const total = Number(
      this.ctx.storage.sql
        .exec(`SELECT COUNT(*) AS n FROM jobs WHERE install_id = ? AND parent_id IS NULL`, installId)
        .toArray()[0].n,
    );
    return { jobs, total };
  }
}

/** queueJobRow is jobRow plus what the join found out about the game. The
 * `game` field is null only when NEITHER table knows the id — a drag&drop
 * upload of a private lobby the BAR API never indexed, say. */
function queueJobRow(r: Record<string, unknown>): QueueJob {
  const game: QueueGame = {
    durationSec: (r.game_duration_sec as number | null) ?? null,
    gameSize: (r.game_size as string | null) ?? null,
    startUnix: (r.game_start_unix as number | null) ?? null,
    map: (r.game_map as string | null) ?? null,
    mapFile: (r.game_map_file as string | null) ?? null,
    settings: parseStored(r.game_settings as string | null, (v) => v as Record<string, boolean | string>),
  };
  // Null when neither table knows the game (an upload from a private lobby).
  const known = Object.values(game).some((v) => v !== null);
  return {
    ...jobRow(r),
    game: known ? game : null,
    publish: parsePublish(r.publish as string | null),
    published: Number(r.game_published) === 1,
  };
}

/** parsePublish reads QUEUE_SELECT's publish column: the upload job that
 * publishes an app run's .brp, or null for every other job. */
function parsePublish(raw: string | null): JobPublish | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      id: v.id as string,
      state: v.state as IngestJob["state"],
      error: (v.error as string | null) ?? null,
      stats: v.stats == null ? null : parseJobStats(v.stats),
      updatedUnix: v.updatedUnix as number,
    };
  } catch {
    return null;
  }
}

/** The Games listing's SELECT — one mirrored game plus the per-row joins
 * saying what this deployment has done about it. Shared by gamesPage and
 * gamesByIds so the two reads cannot disagree on what a row carries; every
 * subquery is a seek, so a row costs the same however it was reached. */
const GAMES_LIST_SELECT = `
  SELECT g.id, g.start_unix, g.duration_sec, g.map, g.map_file, g.game_size, g.preset,
         g.player_count, g.players, g.settings, g.engine_version, g.game_version,
         g.synced_unix, g.lobby_name, g.lobby_details,
         -- A primary-key seek per row. placeholder = 0 because a
         -- placeholder is a re-sim in flight, not a replay to play.
         EXISTS (SELECT 1 FROM replays r WHERE r.id = g.id AND r.placeholder = 0) AS published,
         -- Pinned to jobs_game like list()'s subqueries: seeked by
         -- game, it costs the game's own jobs, almost always 0-1.
         (SELECT j.state FROM jobs j INDEXED BY jobs_game
          WHERE j.game_id = g.id ORDER BY j.created_unix DESC LIMIT 1) AS job_state
  FROM games g`;

function gameListRow(r: Record<string, unknown>): GameListRow {
  return {
    id: r.id as string,
    startUnix: (r.start_unix as number | null) ?? null,
    durationSec: (r.duration_sec as number | null) ?? null,
    map: (r.map as string | null) ?? null,
    mapFile: (r.map_file as string | null) ?? null,
    gameSize: (r.game_size as string | null) ?? null,
    preset: (r.preset as string | null) ?? null,
    playerCount: (r.player_count as number | null) ?? null,
    players: r.players == null ? null : JSON.parse(r.players as string),
    settings: r.settings == null ? null : JSON.parse(r.settings as string),
    engineVersion: (r.engine_version as string | null) ?? null,
    gameVersion: (r.game_version as string | null) ?? null,
    syncedUnix: r.synced_unix as number,
    lobbyName: (r.lobby_name as string | null) ?? null,
    lobbyDetails: parseStored(r.lobby_details as string | null, (v) => v as LobbyDetails),
    published: r.published === 1,
    jobState: (r.job_state as string | null) ?? null,
  };
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
    errorKind: parseJobErrorKind(r.error_kind),
    // Stored as JSON text. A row written before the column, or one whose
    // daemon never reported, has none — and a blob that somehow does not parse
    // is not worth failing a queue read over.
    stats: parseStored(r.stats as string | null, parseJobStats),
    // Only ever set while the job is running (jobUpdate clears it on the
    // terminal state), so null here is the normal case, not a gap.
    progress: parseStored(r.progress as string | null, parseJobProgress),
    disabled: (r.disabled as number | null) === 1,
    note: (r.note as string | null) ?? null,
    installId: (r.install_id as string | null) ?? null,
    parentId: (r.parent_id as string | null) ?? null,
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

// ---- SQL attribution: wrap the prototype, once, at module load -------------
// Attribution has to live on the PROTOTYPE. The first version shadowed each
// method with an instance property, and the deployed runtime REFUSED those
// RPC calls outright — "The RPC receiver does not implement the method
// \"jobsOffer\"" took every job poll down — while the local dev runtime
// silently bypassed the shadow (attribution read "(outside any method)"), so
// neither tests nor vite dev caught it. Wrapped here the methods stay
// ordinary class methods in RPC's eyes; a test that patches a prototype
// method replaces the wrapper slot and still takes effect, because the
// original bodies reach their helpers through `this`.
{
  const proto = ReplayIndex.prototype as unknown as Record<string, unknown>;
  // The accounting's own pieces stay unwrapped, or stamping would recurse.
  const skip = new Set(["constructor", "installSqlAccounting", "sqlTally", "sqlTracked"]);
  for (const name of Object.getOwnPropertyNames(ReplayIndex.prototype)) {
    if (skip.has(name) || typeof proto[name] !== "function") continue;
    const fn = proto[name] as (...a: unknown[]) => unknown;
    proto[name] = function (this: ReplayIndex, ...args: unknown[]) {
      return (
        this as unknown as { sqlTracked(n: string, f: (...a: unknown[]) => unknown, a: unknown[]): unknown }
      ).sqlTracked(name, fn, args);
    };
  }
}

/** The end-state half of a MatchLobby, from a row selecting end_map and
 * end_players (json_extract of lobby_details.end). */
function lobbyEnd(r: Record<string, SqlStorageValue>): { endMap: string | null; endPlayers: string[] | null } {
  const roster = r.end_players == null ? null : (JSON.parse(r.end_players as string) as { name: string }[]);
  return {
    endMap: (r.end_map as string | null) ?? null,
    endPlayers: roster === null ? null : roster.map((p) => p.name),
  };
}
