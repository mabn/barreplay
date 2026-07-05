import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin runs the Worker (src/worker/index.ts, per wrangler.jsonc) inside
// the real workerd runtime during `vite dev`, and builds both the client bundle and the
// Worker on `vite build`. No React/JSX plugin: the UI is plain TypeScript + Canvas/DOM.
export default defineConfig({
  plugins: [cloudflare()],
});
