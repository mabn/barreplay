// Hand-maintained Env additions that `wrangler types` cannot generate:
// secrets are not declared in wrangler.jsonc. Merges into the generated
// `interface Env` in worker-configuration.d.ts.
interface Env {
  /** Optional shared secret guarding PUT /api/replays/<id>
   * (`wrangler secret put REPLAY_PUT_TOKEN`). Absent in local dev. */
  REPLAY_PUT_TOKEN?: string;
  /** Teiserver account for the cron's lobby poll (`wrangler secret put
   * TEISERVER_EMAIL` / `TEISERVER_PASSWORD`). When either is absent the
   * lobby step is skipped entirely — the games mirror runs regardless. */
  TEISERVER_EMAIL?: string;
  TEISERVER_PASSWORD?: string;
  /** Dev/test override of the teiserver web base URL, so a local mock can
   * stand in for server4.beyondallreason.info. Never set in production. */
  TEISERVER_BASE?: string;
}
