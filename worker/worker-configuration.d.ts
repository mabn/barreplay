// Placeholder ambient types for the Worker's `Env` bindings. Regenerate from wrangler.jsonc
// with `npm run cf-typegen` (wraps `wrangler types`), which overwrites this file with the
// full Cloudflare runtime + binding types.

interface Env {
  // Static-asset binding declared in wrangler.jsonc; used for the SPA fallback.
  ASSETS: Fetcher;
}
