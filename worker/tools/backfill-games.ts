// One-off recovery for the games mirror: re-add games the mirror missed while
// the cron only read a single page (see the GAMES MIRROR notes in the repo
// CLAUDE.md). Run from a trusted machine — it needs the write token.
//
//   REPLAY_PUT_TOKEN=... npx tsx tools/backfill-games.ts [--hours 48] \
//       [--base https://replay.fogofwar.dev] [--batch 100] [--dry]
//
// What it does, all from HERE (the Worker makes no outbound calls of its own on
// this path, so no per-invocation subrequest cap applies):
//   1. page api.bar-rts.com's listing (the mirror's own filter) back --hours,
//   2. page the deployed mirror to see which of those it already has,
//   3. fetch the /replays/<id> detail for only the MISSING ones,
//   4. POST them to the guarded /api/games/backfill in batches; gamesUnknown
//      dedups server-side, so a re-run or an overlap is a no-op.
//
// It writes NOTHING with --dry: it just reports how many are missing.
import process from "node:process";

const BAR = "https://api.bar-rts.com";
const FILTER = "hasBots=false&endedNormally=true"; // the mirror's eligibility

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
const HOURS = Number(arg("hours", "48"));
const BASE = arg("base", "https://replay.fogofwar.dev").replace(/\/$/, "");
const BATCH = Number(arg("batch", "100"));
const DRY = process.argv.includes("--dry");
const TOKEN = process.env.REPLAY_PUT_TOKEN ?? "";

async function getJSON(url: string, init?: RequestInit): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, init);
      if (r.ok) return await r.json();
      // A 4xx is not worth retrying; a 5xx might be transient.
      if (r.status < 500) throw new Error(`HTTP ${r.status} ${url} ${await r.text().catch(() => "")}`);
    } catch (e) {
      if (attempt === 2) throw e;
    }
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  throw new Error(`gave up on ${url}`);
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - HOURS * 3600;
  console.log(`window: last ${HOURS}h (start >= ${new Date(cutoff * 1000).toISOString()}); base ${BASE}`);

  // 1. BAR ground truth: eligible games whose START is in the window.
  const truth = new Set<string>();
  for (let page = 1; page <= 200; page++) {
    const d = await getJSON(`${BAR}/replays?limit=100&${FILTER}&page=${page}`);
    const rows: any[] = Array.isArray(d?.data) ? d.data : [];
    if (rows.length === 0) break;
    let done = false;
    for (const r of rows) {
      const s = r?.startTime ? Math.floor(Date.parse(r.startTime) / 1000) : NaN;
      if (!Number.isFinite(s)) continue;
      if (s >= cutoff) truth.add(r.id);
      else done = true;
    }
    process.stdout.write(`\rBAR listing: page ${page}, ${truth.size} eligible in window`);
    if (done || rows.length < 100) break;
  }
  console.log(`\nBAR eligible in window: ${truth.size}`);

  // 2. What the mirror already has (end-ordered; stop once even the end is
  //    before the cutoff, since then start is too).
  const have = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 200; page++) {
    const url = `${BASE}/api/games?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const d = await getJSON(url);
    const games: any[] = Array.isArray(d?.games) ? d.games : [];
    if (games.length === 0) break;
    let done = false;
    for (const g of games) {
      const s = g?.startUnix ?? null;
      if (s === null) continue;
      if (s >= cutoff) have.add(g.id);
      if (s + (g.durationSec || 0) < cutoff) done = true;
    }
    after = d?.next ?? null;
    if (done || !after) break;
  }
  const missing = [...truth].filter((id) => !have.has(id));
  console.log(`mirror already has ${have.size} of them; MISSING ${missing.length}`);
  if (missing.length === 0) return;
  if (DRY) {
    console.log("--dry: not fetching details or writing.");
    return;
  }

  // 3. Fetch the detail for only the missing games.
  const details: unknown[] = [];
  let fetched = 0;
  await pool(missing, 6, async (id) => {
    try {
      details.push(await getJSON(`${BAR}/replays/${encodeURIComponent(id)}`));
    } catch (e) {
      console.error(`\n  detail ${id} failed: ${(e as Error).message}`);
    }
    process.stdout.write(`\rfetching details: ${++fetched}/${missing.length}`);
  });
  console.log(`\nfetched ${details.length} details`);

  // 4. Post in batches to the guarded backfill route.
  if (!TOKEN) throw new Error("REPLAY_PUT_TOKEN is not set — the backfill route is guarded");
  let inserted = 0;
  for (let i = 0; i < details.length; i += BATCH) {
    const batch = details.slice(i, i + BATCH);
    const res = await getJSON(`${BASE}/api/games/backfill`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(batch),
    });
    inserted += res.inserted ?? 0;
    console.log(`  batch ${i / BATCH + 1}: received=${res.received} fresh=${res.fresh} inserted=${res.inserted}`);
  }
  console.log(`\ndone: ${inserted} games inserted into the mirror.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
