// The replay index: a SQLite-backed Durable Object that owns the catalog of
// uploaded replays. One instance (idFromName("index")) holds a single small
// table; the Worker's /api/replays routes are thin wrappers over its RPC
// methods. The R2 bucket remains the source of the replay DATA — this table is
// only the picker metadata (when the game started, how long it ran, which map,
// the team-size spec like "8v8"), which the bucket listing cannot provide
// because it lives inside each .brp's meta record.
import { DurableObject } from "cloudflare:workers";

import type { ReplayEntry } from "./replayentry";

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
    `);
    // In-place upgrade for a table created before the settings column existed
    // (SQLite has no ADD COLUMN IF NOT EXISTS; a duplicate-column error just
    // means the schema is already current).
    try {
      ctx.storage.sql.exec(`ALTER TABLE replays ADD COLUMN settings TEXT`);
    } catch (e) {
      if (!String(e).includes("duplicate column")) throw e;
    }
  }

  /** upsert inserts or fully replaces one replay's catalog row. */
  upsert(e: ReplayEntry): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO replays (id, start_unix, duration_sec, map, game_size, size_bytes, settings, updated_unix)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         start_unix = excluded.start_unix,
         duration_sec = excluded.duration_sec,
         map = excluded.map,
         game_size = excluded.game_size,
         size_bytes = excluded.size_bytes,
         settings = excluded.settings,
         updated_unix = excluded.updated_unix`,
      e.id,
      e.startUnix,
      e.durationSec,
      e.map,
      e.gameSize,
      e.sizeBytes,
      e.settings === null ? null : JSON.stringify(e.settings),
      Math.floor(Date.now() / 1000),
    );
  }

  /** list returns every replay, most recently started first (rows with no
   * start time sort last, then by id so the order is stable). */
  list(): ReplayEntry[] {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, start_unix, duration_sec, map, game_size, size_bytes, settings
         FROM replays
         ORDER BY start_unix IS NULL, start_unix DESC, id`,
      )
      .toArray();
    return rows.map((r) => ({
      id: r.id as string,
      startUnix: r.start_unix as number | null,
      durationSec: r.duration_sec as number | null,
      map: r.map as string | null,
      gameSize: r.game_size as string | null,
      sizeBytes: r.size_bytes as number | null,
      settings: r.settings == null ? null : JSON.parse(r.settings as string),
    }));
  }
}
