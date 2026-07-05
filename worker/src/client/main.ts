// Client entry — plain TypeScript, no framework. This is scaffolding: it pings the Worker
// API to prove the client ↔ Worker wiring works. The real playback UI (currently
// internal/viz/web/app.js) is intended to be ported here.

const statusEl = document.getElementById("status");

async function init(): Promise<void> {
  try {
    const res = await fetch("/api/health");
    const body = (await res.json()) as { status: string };
    if (statusEl) statusEl.textContent = `API: ${body.status}`;
  } catch (err) {
    if (statusEl) statusEl.textContent = `API unreachable: ${String(err)}`;
  }
}

void init();
