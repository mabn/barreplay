// How often each achievement fires over a set of games, and how that changes
// as its knob turns: the data behind tuning rarity. Reads demos already on
// disk (the browser's own parser, demo.ts), so it is run once over a folder:
//
//   npx tsx tools/achievement-rates.ts <dir> [i/n] > rates.json
//
// i/n judges only every n-th game from the i-th (0-based), so n processes can
// share the work; their outputs add up (the counts are sums).
//
// <dir> holds games.json ([{id, version, map: {w, h} | null}]), demos/<id>.sdfz,
// tables/<version>__<anything>.json (a unit-def id -> name table read off a
// published replay of that version) and props.json (name -> BrpDef: what is
// known of each def). A demo does not say which table it was played with,
// and one game version has several (the def list depends on the lobby's
// modoptions: scavenger units, extra units, ...), so each game takes the
// table its own build orders fit best: a player builds one faction's units,
// and a wrong table scatters them over all three. A game nothing fits is
// judged without one, so its build-order rules skip.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { gunzip, parseDemo, type BrpDef, type Demo } from "../src/summary/demo";
import { gather, unwrap } from "../src/summary/achievements/facts";
import { MIN_GAME_MIN, RULES } from "../src/summary/achievements/rules";

/** The knob values tried, as multiples of the rule's own. */
const STEPS = [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 7, 10];

interface Game { id: string; version: string; map: { w: number; h: number } | null }

const dir = process.argv[2];
if (!dir) throw new Error("usage: achievement-rates.ts <dir>");
const [shard, shards] = (process.argv[3] ?? "0/1").split("/").map(Number);
const games = (JSON.parse(readFileSync(join(dir, "games.json"), "utf8")) as Game[]).filter((_, i) => i % shards === shard);

const props = JSON.parse(readFileSync(join(dir, "props.json"), "utf8")) as Record<string, BrpDef>;
const tables = readdirSync(join(dir, "tables")).map((f) => ({
  version: f.split("__")[0],
  names: new Map(Object.entries(JSON.parse(readFileSync(join(dir, "tables", f), "utf8")) as Record<string, string>).map(([i, n]) => [Number(i), n])),
}));
const defsCache = new Map<(typeof tables)[number], Map<number, BrpDef>>();
function defsOf(t: (typeof tables)[number]): Map<number, BrpDef> {
  if (!defsCache.has(t)) defsCache.set(t, new Map([...t.names].map(([id, name]) => [id, { ...(props[name] ?? { name }), id, name }])));
  return defsCache.get(t)!;
}

/** fit is how well a table explains a demo's build orders: per player, the
 * share of their builds in their most-built faction, weighted by builds. */
function fit(demo: Demo, names: Map<number, string>): number {
  const by = new Map<number, Map<string, number>>();
  let n = 0;
  for (const c0 of demo.commands) {
    const c = unwrap(c0);
    if (c.id >= 0) continue;
    const name = names.get(-c.id);
    const fac = name ? (/^(arm|cor|leg)/.exec(name)?.[1] ?? "other") : "missing";
    const m = by.get(c.player) ?? new Map<string, number>();
    m.set(fac, (m.get(fac) ?? 0) + 1);
    by.set(c.player, m);
    n++;
  }
  if (n < 20) return 0;
  let good = 0;
  for (const m of by.values()) good += Math.max(...[...m].filter(([f]) => f !== "missing" && f !== "other").map(([, v]) => v), 0);
  return good / n;
}

function pickDefs(demo: Demo, version: string): { defs: Map<number, BrpDef> | null; score: number } {
  let best: (typeof tables)[number] | null = null, score = 0;
  for (const t of tables) {
    const s = fit(demo, t.names) + (t.version === version ? 0.001 : 0);
    if (s > score) { best = t; score = s; }
  }
  return best && score >= 0.85 ? { defs: defsOf(best), score } : { defs: null, score };
}

/** Each rule's values: the knob values tried, deduplicated after rounding. */
const ladders = new Map(RULES.map((r) => {
  const kn = r.knob;
  if (!kn) return [r.id, [NaN]];
  // A knob at zero (a rank) cannot be scaled: try small whole steps instead.
  const ks = kn.value === 0 ? [0, 1, 2, 3, 4, 5, 7, 10] : STEPS.map((m) => (kn.int ? Math.max(1, Math.round(kn.value * m)) : kn.value * m));
  return [r.id, [...new Set(ks)].sort((a, b) => a - b)];
}));

/** Per rule and knob value: hits (awards handed out), games with one, and
 * players who earned one. */
const tally = new Map(RULES.map((r) => [r.id, ladders.get(r.id)!.map(() => ({ hits: 0, games: 0, players: 0 }))]));
const judged = new Map(RULES.map((r) => [r.id, 0]));
const skipWhy = new Map<number, Map<string, number>>();
let done = 0, failed = 0, players = 0, noDefs = 0, short = 0;
const fits: number[] = [];

for (const g of games) {
  const p = join(dir, "demos", `${g.id}.sdfz`);
  if (!existsSync(p)) { failed++; continue; }
  let F;
  try {
    const demo = parseDemo(await gunzip(new Uint8Array(readFileSync(p))));
    const { defs, score } = pickDefs(demo, g.version);
    fits.push(Math.round(score * 100) / 100);
    if (!defs) noDefs++;
    F = gather(demo, defs, null, g.map);
  } catch (e) {
    failed++;
    process.stderr.write(`${g.id}: ${(e as Error).message}\n`);
    continue;
  }
  // Short games earn nothing (judge's gate), so they are not counted at all.
  if (F.endMin < MIN_GAME_MIN) { short++; continue; }
  done++;
  players += F.players.filter((x) => !x.ai).length;
  for (const r of RULES) {
    const ks = ladders.get(r.id)!;
    const t = tally.get(r.id)!;
    let skipped = false;
    ks.forEach((k, i) => {
      let out;
      try { out = r.check(F, k); } catch (e) { out = { skip: `threw: ${(e as Error).message}` }; }
      if ("skip" in out) {
        if (i === 0) {
          const m = skipWhy.get(r.id) ?? new Map();
          m.set(out.skip, (m.get(out.skip) ?? 0) + 1);
          skipWhy.set(r.id, m);
        }
        skipped = true;
        return;
      }
      t[i].hits += out.length;
      if (out.length) t[i].games++;
      t[i].players += new Set(out.map((h) => h.player?.id ?? h.side?.index ?? "game")).size;
    });
    if (!skipped) judged.set(r.id, judged.get(r.id)! + 1);
  }
  if (done % 50 === 0) process.stderr.write(`${done} games\n`);
}

process.stdout.write(JSON.stringify({
  games: done, failed, short, players, noDefs, fits: fits.sort((a, b) => a - b),
  rules: RULES.map((r) => ({
    id: r.id, name: r.name, desc: r.desc, need: r.need, knob: r.knob ?? null, rarity: r.rarity ?? null, group: r.group ?? null,
    judged: judged.get(r.id),
    skips: Object.fromEntries(skipWhy.get(r.id) ?? []),
    ks: ladders.get(r.id), rates: tally.get(r.id),
  })),
}));
