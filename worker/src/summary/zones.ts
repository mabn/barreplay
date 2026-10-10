// Killing zones: the deaths of a game merged into the few places the metal
// went down, for a map that a big game's ninety thousand dots would paint
// solid. Pure, so the merging is tested without a page.
import { wipedOf } from "./losses";
import { sideOfTeam } from "./model";
import { SIM_FPS, type Insights } from "./types";

/** ZONE_SHARE is the zone radius as a share of the map's longer side: a
 * twelfth is a base or a choke point, not a whole flank. */
const ZONE_SHARE = 1 / 12;
/** PEAK_SEC is the window a zone's busiest moment is found in. */
const PEAK_SEC = 30;
/** MAX_ZONES keeps the map to the places worth a look. */
export const MAX_ZONES = 40;

export interface Zone {
  x: number;
  z: number;
  /** Radius the zone gathered deaths from, in elmos. */
  r: number;
  /** Metal (or, when nothing is priced, units) lost per side. */
  lost: number[];
  count: number[];
  total: number;
  /** Start and end of the zone's busiest PEAK_SEC, in sim frames. */
  peakF0: number;
  peakF1: number;
  first: number;
  last: number;
  /** Costliest unit kinds lost there, biggest first. */
  top: { def: number; n: number; metal: number }[];
}

/** zonesOf groups the deaths that were fought for (not those that went down
 * with an eliminated team) into zones: deaths are binned into a grid of
 * half-zone cells, then the heaviest cell left takes every cell within one
 * zone radius of it, repeated. Weight is metal when the file prices
 * anything, else one per unit. */
export function zonesOf(ins: Insights): { zones: Zone[]; radius: number; totals: number[] } {
  const d = ins.deaths;
  const b = ins.bounds;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 1024);
  const radius = Math.max(400, span * ZONE_SHARE);
  const cell = radius / 2;
  const side = sideOfTeam(ins);
  const wiped = wipedOf(ins);
  const priced = d.cost.some((c) => c > 0);
  const w = (i: number) => (priced ? d.cost[i] : 1);
  // Every side's whole loss, past the zones too: the map shows the biggest
  // places, the legend the whole game.
  const totals = ins.sides.map(() => 0);
  const cells = new Map<string, { x: number; z: number; wt: number; idx: number[] }>();
  for (let i = 0; i < d.f.length; i++) {
    if (wiped(i) || w(i) <= 0) continue;
    const sd = side.get(d.team[i]) ?? -1;
    if (sd >= 0) totals[sd] += w(i);
    if (d.x[i] < 0) continue; // never sampled: nowhere to draw it
    const key = `${Math.floor(d.x[i] / cell)},${Math.floor(d.z[i] / cell)}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { x: 0, z: 0, wt: 0, idx: [] }));
    c.x += d.x[i] * w(i);
    c.z += d.z[i] * w(i);
    c.wt += w(i);
    c.idx.push(i);
  }
  const left = [...cells.values()].map((c) => ({ ...c, x: c.x / c.wt, z: c.z / c.wt }));
  left.sort((a, b2) => b2.wt - a.wt);
  const used = new Array<boolean>(left.length).fill(false);
  const zones: Zone[] = [];
  for (let k = 0; k < left.length && zones.length < MAX_ZONES; k++) {
    if (used[k]) continue;
    const seed = left[k];
    const idx: number[] = [];
    for (let j = k; j < left.length; j++) {
      if (used[j] || Math.hypot(left[j].x - seed.x, left[j].z - seed.z) > radius) continue;
      used[j] = true;
      idx.push(...left[j].idx);
    }
    zones.push(zoneOf(ins, idx, w, side, radius));
  }
  return { zones, radius, totals };
}

function zoneOf(ins: Insights, idx: number[], w: (i: number) => number, side: Map<number, number>, r: number): Zone {
  const d = ins.deaths;
  const lost = ins.sides.map(() => 0);
  const count = ins.sides.map(() => 0);
  const bins = new Map<number, number>();
  const defs = new Map<number, { n: number; metal: number }>();
  let x = 0, z = 0, total = 0, first = Infinity, last = -Infinity;
  const bin = PEAK_SEC * SIM_FPS;
  for (const i of idx) {
    const wt = w(i);
    total += wt;
    x += d.x[i] * wt;
    z += d.z[i] * wt;
    const sd = side.get(d.team[i]) ?? -1;
    if (sd >= 0) {
      lost[sd] += wt;
      count[sd]++;
    }
    const bk = Math.floor(d.f[i] / bin);
    bins.set(bk, (bins.get(bk) ?? 0) + wt);
    const df = defs.get(d.def[i]) ?? { n: 0, metal: 0 };
    df.n++;
    df.metal += d.cost[i];
    defs.set(d.def[i], df);
    first = Math.min(first, d.f[i]);
    last = Math.max(last, d.f[i]);
  }
  let peak = 0, peakW = -1;
  for (const [bk, wt] of bins) {
    if (wt > peakW || (wt === peakW && bk < peak)) {
      peak = bk;
      peakW = wt;
    }
  }
  // The peak starts at its first death, not at the bin's edge.
  let peakF0 = (peak + 1) * bin;
  for (const i of idx) if (Math.floor(d.f[i] / bin) === peak) peakF0 = Math.min(peakF0, d.f[i]);
  const top = [...defs.entries()].map(([def, v]) => ({ def, ...v }))
    .sort((a, b) => b.metal - a.metal || b.n - a.n).slice(0, 3);
  return { x: x / total, z: z / total, r, lost, count, total, peakF0, peakF1: (peak + 1) * bin, first, last, top };
}
