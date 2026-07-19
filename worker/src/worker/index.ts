// Worker entry point. The routes live in app.ts (kept free of workerd-only
// imports so the node tests can exercise them); this file adds the Durable
// Object class export wrangler's migration binding requires.
import app from "./app";
import { ReplayIndex } from "./replayindex";

export { ReplayIndex };

export default app;
