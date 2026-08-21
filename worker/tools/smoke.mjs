// Smoke-tests the BUILT worker against the real runtime, the way `npm run
// deploy` does before it ships anything.
//
// Why this exists as a separate harness. The node tests (tests/*.test.ts)
// drive the Hono routes with a fake ASSETS binding that answers whatever path
// it is handed, and `vite dev` serves public/ through plain static middleware.
// Neither is the asset LAYER, and the asset layer is where this project's
// deploy bugs live: it redirects .html URLs to their extensionless form
// (auto-trailing-slash), it answers unmatched paths with index.html
// (single-page-application), and it is the only thing that applies
// public/_headers. Every one of those has already shipped a page that looked
// fine locally — /setup as an infinite redirect loop, /favicon.ico as the
// whole HTML document.
//
// `vite preview` runs the built Worker in workerd with the real asset server,
// so it reproduces all three. This script boots it, asserts the contract
// below, and tears it down.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const here = new URL(".", import.meta.url);
const widgetSrc = readFileSync(new URL("../../assets/lua/replay_uploader.lua", here), "utf8");
/** The placeholder the repo's widget carries where its git SHA is stamped in
 * (worker/tools/sync-assets.mjs). */
const SHA_TOKEN = "__WIDGET_SHA__";

const BOOT_TIMEOUT_MS = 90_000;

/** freePort asks the OS for a port nobody is using, so a stray dev server (or
 * a second smoke run) cannot make this fail for an unrelated reason. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(base, child) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`vite preview exited (${child.exitCode}) before serving`);
    try {
      const r = await fetch(base + "/api/health", { redirect: "manual" });
      if (r.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`vite preview did not answer within ${BOOT_TIMEOUT_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

// Every request is `redirect: "manual"`: a 3xx must fail the check rather than
// be quietly followed. The /setup loop was a chain of 307s that curl -L and a
// browser both reported as something else entirely.
async function get(base, path) {
  const r = await fetch(base + path, { redirect: "manual" });
  return { status: r.status, headers: r.headers, body: await r.text() };
}

// This smokes what is on disk in dist/, so a missing build has to be an error
// rather than a boot failure to squint at. `npm run deploy` always builds
// first; a bare `npm run smoke` needs `npm run build` in front of it.
if (!existsSync(new URL("../dist/client/index.html", here))) {
  console.error("smoke: no dist/client — run `npm run build` first");
  process.exit(1);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
console.log(`smoke: booting the built worker on ${base}`);

const child = spawn(
  process.execPath,
  // --host pins the interface the checks below actually probe. Left to
  // itself vite preview binds "localhost", which on a host whose /etc/hosts
  // resolves that to ::1 first is an IPv6-ONLY listener — the server boots,
  // prints its URL, and every 127.0.0.1 request in this file fails to
  // connect, which surfaces as the boot timeout rather than as an address
  // mismatch.
  [
    fileURLToPath(new URL("../node_modules/vite/bin/vite.js", here)),
    "preview",
    "--port", String(port),
    "--strictPort",
    "--host", "127.0.0.1",
  ],
  { cwd: fileURLToPath(new URL("..", here)), stdio: ["ignore", "pipe", "pipe"], detached: true },
);
const log = [];
child.stdout.on("data", (b) => log.push(String(b)));
child.stderr.on("data", (b) => log.push(String(b)));

let code = 0;
try {
  await waitForServer(base, child);

  // The Worker is actually routed. If run_worker_first ever stops covering
  // /api/*, the asset layer's single-page-application handling answers this
  // with index.html — a 200 carrying the whole viewer.
  const health = await get(base, "/api/health");
  check("GET /api/health is the Worker, not the SPA", health.status === 200 && health.body.includes('"ok"'),
    `${health.status} ${health.body.slice(0, 60)}`);

  // The SPA entry, its fingerprinted subresources, and the banner link.
  const home = await get(base, "/");
  check("GET / serves the viewer", home.status === 200, String(home.status));
  check("index.html has no unsubstituted placeholders",
    !home.body.includes("__ASSET_REV__") && !home.body.includes("__DATA_ORIGIN__"));
  check("the dropzone banner links to /setup", home.body.includes('href="/setup"'));
  for (const ref of home.body.match(/\/(?:app|style)\.[0-9a-f]{8}\.(?:js|css)/g) ?? []) {
    const sub = await get(base, ref);
    check(`GET ${ref}`, sub.status === 200 && sub.body.length > 0, String(sub.status));
  }

  // The guide. A 3xx here is the redirect loop: the asset layer bounces
  // /setup.html back to /setup, so a route that rewrites the path serves its
  // own bounce forever.
  const setup = await get(base, "/setup");
  check("GET /setup is a page, not a redirect", setup.status === 200, `status ${setup.status}`);
  check("/setup is the guide", setup.body.includes('href="/replay_uploader.lua"'));
  check("/setup revalidates", setup.headers.get("cache-control") === "no-cache",
    String(setup.headers.get("cache-control")));

  // The widget the guide hands out: the bytes players install, so they have to
  // be the repo's copy — a stale public/ sync is exactly what this catches.
  // The published copy differs from the repo's in exactly one way: its
  // __WIDGET_SHA__ token is stamped with the widget's git SHA (sync-assets),
  // which is what lets a capture name the exact bytes that produced it.
  const widget = await get(base, "/replay_uploader.lua");
  check("GET /replay_uploader.lua", widget.status === 200, String(widget.status));
  const stamp = /^local widgetSha = "([^"]*)"$/m.exec(widget.body)?.[1];
  check("the served widget is assets/lua/replay_uploader.lua, stamped",
    stamp !== undefined && widget.body === widgetSrc.replaceAll(SHA_TOKEN, stamp),
    "the published copy differs from the repo by more than its SHA stamp");
  // A deploy that publishes an unstamped widget loses the provenance for every
  // capture recorded with it, and nothing downstream can recover it. The sync
  // refuses to stamp a widget with uncommitted changes, so this means: commit
  // the widget first.
  check("the published widget carries its git SHA", /^[0-9a-f]{40}$/.test(stamp ?? ""),
    `widgetSha = ${JSON.stringify(stamp)} — commit assets/lua/replay_uploader.lua, then re-run the sync`);
  // Served by the ASSET LAYER (excluded from run_worker_first), which is the
  // only way public/_headers applies to it at all.
  check("the widget revalidates (public/_headers applied)",
    widget.headers.get("cache-control") === "no-cache", String(widget.headers.get("cache-control")));

  // The favicon must resolve to the real object: left to the catch-all it was
  // answered with index.html, labelled text/html, as the tab icon.
  const ico = await get(base, "/favicon.ico");
  check("GET /favicon.ico is an icon, not index.html",
    ico.status === 200 && !ico.headers.get("content-type")?.includes("text/html"),
    `${ico.status} ${ico.headers.get("content-type")}`);

  // A vendored unit icon: the other _headers rule, and the exclusion that
  // keeps a cold replay's 300-650 icon requests off the Worker. Named from the
  // synced directory rather than hardcoded — the bitmap set is BAR's, and a
  // re-sync may drop any particular file.
  const sample = readdirSync(new URL("../public/icons", here)).find((f) => f.endsWith(".png"));
  check("the vendored icons are synced into public/", Boolean(sample));
  if (sample) {
    const icon = await get(base, `/icons/${sample}`);
    check("GET /icons/* is cached by the asset layer",
      icon.status === 200 && (icon.headers.get("cache-control") ?? "").includes("max-age=604800"),
      `${icon.status} ${icon.headers.get("cache-control")}`);
  }
} catch (e) {
  console.error(`smoke: ${e.message}`);
  console.error(log.join("").split("\n").slice(-15).join("\n"));
  code = 1;
} finally {
  // vite preview spawns workerd; kill the whole group or it outlives us.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGKILL");
  }
}

if (failures.length) {
  console.error(`\nsmoke: ${failures.length} check(s) failed: ${failures.join(", ")}`);
  code = 1;
} else if (code === 0) {
  console.log("smoke: the built worker serves everything it is supposed to");
}
process.exit(code);
