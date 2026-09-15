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
  /** Cloudflare Access, the admin login (src/worker/access.ts): the Zero
   * Trust team domain ("<team>.cloudflareaccess.com" or just "<team>") and
   * the Access application's Audience (AUD) tag. Set both (`wrangler secret
   * put`, or a `vars` block — neither is secret) or every admin route
   * answers 401: unconfigured is CLOSED. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Local dev only (.dev.vars): "true" opens the admin routes with no
   * login at all. Never set it on a deployment. */
  ADMIN_OPEN?: string;
}
