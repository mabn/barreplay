// Worker entry point: a Hono app that serves the JSON API. Static assets (the Vite client
// bundle) are served by the runtime before this Worker runs; unmatched requests fall
// through to here. Non-API navigations are handed back to the static-asset SPA fallback.
//
// This is scaffolding only — the real endpoints (listing captures, serving a capture's
// wire payload, proxying map textures) still live in the Go `internal/viz` server and are
// intended to be ported here incrementally.

import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

// Liveness/readiness probe.
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Stub: list of available replays. Port `internal/viz/server.go` `/api/replays` here.
app.get("/api/replays", (c) => c.json({ replays: [] }));

// Anything else under /api is not implemented yet.
app.all("/api/*", (c) => c.json({ error: "not implemented" }, 501));

// Non-API requests reach the Worker only when no static asset matched. Delegate to the
// assets binding so the SPA fallback (index.html) is returned.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
