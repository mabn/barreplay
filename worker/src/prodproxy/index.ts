// The READ-ONLY PRODUCTION PROXY: the deployed half of `npm run dev:prod`
// (see src/worker/readonly.ts for the whole picture, and the README's
// "Local development against production data").
//
// Deployed on its own (`npm run deploy:prodproxy`, wrangler.prodproxy.jsonc)
// as the Worker "replay-prod-readonly". It binds production's ReplayIndex
// Durable Object (script_name "replay") and the production bucket, and
// answers only the reads handleReadOnly allows. It has NO public route — no
// workers.dev hostname, no custom domain — so the only way in is a service
// binding from this account, which is what a local dev server holding your
// `wrangler login` uses.
import { handleReadOnly } from "../worker/readonly";

interface ProxyEnv {
  REPLAY_INDEX: DurableObjectNamespace;
  BUCKET: R2Bucket;
}

export default {
  async fetch(req: Request, env: ProxyEnv): Promise<Response> {
    const index = env.REPLAY_INDEX.get(env.REPLAY_INDEX.idFromName("index")) as unknown as Record<string, unknown>;
    try {
      return await handleReadOnly(req, { index, bucket: env.BUCKET });
    } catch (e) {
      console.error(`prod proxy: ${req.method} ${new URL(req.url).pathname}: ${e}`);
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<ProxyEnv>;
