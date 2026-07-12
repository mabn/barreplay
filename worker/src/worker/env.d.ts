// Hand-maintained Env additions that `wrangler types` cannot generate:
// secrets are not declared in wrangler.jsonc. Merges into the generated
// `interface Env` in worker-configuration.d.ts.
interface Env {
  /** Optional shared secret guarding PUT /api/replays/<id>
   * (`wrangler secret put REPLAY_PUT_TOKEN`). Absent in local dev. */
  REPLAY_PUT_TOKEN?: string;
}
