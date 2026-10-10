// What happened in a swing: a name and a one-line account for each moment
// of the win-probability line, written from the deaths inside its window.
// Nothing in a capture says who killed what, so a moment is told from what
// each side LOST, where, and how the armies moved — the same facts a battle
// card uses. Pure, so the node tests can pin the wording rules.
import { fmtMetal } from "./format";
import { knockouts, wipedOf } from "./losses";
import { sideName, sideOfTeam } from "./model";
import { SIM_FPS, type Battle, type Insights, type Moment } from "./types";

/** BAR's commanders, minus the scavenger bosses (app.js's COMMANDER_RE). */
const COMMANDER_RE = /^(arm|cor|leg)com/;

/** A loss this share of the side's whole loss in the window, from one unit,
 * names the moment after that unit. */
const SINGLE_SHARE = 0.5;

/** Under this much metal lost by the losing side, the shift is not a fight
 * but the armies or economies pulling apart. */
const QUIET_METAL = 300;

export interface SideLoss {
  n: number;
  metal: number;
  /** Commanders lost, by the player who owned each. */
  commanders: string[];
  /** Death indices of those commanders, in the same order. */
  commanderDeaths: number[];
  /** Death index of the costliest unit lost, -1 with none. */
  top: number;
  /** Kinds lost, most metal first: [name, count, metal]. */
  kinds: [string, number, number][];
  /** Where the side's losses were, cost-weighted, or null with none. */
  at: [number, number] | null;
}

export interface MomentStory {
  title: string;
  detail: string;
  lost: SideLoss[];
  /** Index into battles of the battle the moment was (the one holding its
   * focus, else the one overlapping its window most), -1 for none. */
  battle: number;
  /** Who fought it, per side (the players carrying at least FIGHTER_SHARE
   * of their side's part in the battle), empty without a battle or a file
   * that records who took part. */
  fighters: Fighter[][];
  /** The instant that made the moment, and where, when one can be named:
   * the commander's death, the elimination, the costliest loss, or the
   * densest killing of a fight. Null when the line moved on what the sides
   * built rather than on anything that happened at one place. */
  focus: Focus | null;
}

/** An instant on the map: sim frame f, at world (x, z) within radius r. */
export interface Focus {
  f: number;
  x?: number;
  z?: number;
  r?: number;
}

/** Seconds and elmos of killing a fight's focus is looked for in: the box
 * holding the most metal lost is where the fight is. Both bounds matter —
 * ten seconds across the whole map is a mex here and a turbine there. */
const BURST_SEC = 10;
const BURST_RADIUS = 1500;

/** The share of a side's part in a battle (army there plus metal lost
 * there) that names a player as one who fought it. */
export const FIGHTER_SHARE = 0.1;

/** A player who fought a battle, and the metal they brought and lost. */
export interface Fighter {
  name: string;
  team: number;
  metal: number;
  share: number;
}

/** fighters names, per side, the players who carried a battle: each with at
 * least FIGHTER_SHARE of their side's army-there-plus-losses, biggest
 * first. */
export function fighters(ins: Insights, b: Battle | undefined): Fighter[][] {
  const out: Fighter[][] = ins.sides.map(() => []);
  if (!b?.teams) return out;
  const sideOf = sideOfTeam(ins);
  const owner = new Map(ins.teams.map((t) => [t.team, t.player ?? ""]));
  const total = ins.sides.map(() => 0);
  for (const t of b.teams) {
    const sd = sideOf.get(t.team) ?? -1;
    if (sd >= 0 && sd < total.length) total[sd] += t.army + t.lost;
  }
  for (const t of b.teams) {
    const sd = sideOf.get(t.team) ?? -1;
    if (sd < 0 || sd >= total.length || total[sd] <= 0) continue;
    const metal = t.army + t.lost;
    const share = metal / total[sd];
    if (share >= FIGHTER_SHARE) out[sd].push({ name: owner.get(t.team) || `Team ${t.team}`, team: t.team, metal, share });
  }
  for (const list of out) list.sort((a, b) => b.metal - a.metal);
  return out;
}

/** isCommander is whether a def name is a real commander. */
export function isCommander(name: string): boolean {
  return COMMANDER_RE.test(name) && !name.includes("boss");
}

/** compass names where a point sits on the map: "the north-west", "the
 * centre". Bounds are the capture's, which is what the map view draws. */
export function compass(ins: Insights, x: number, z: number): string {
  const b = ins.bounds;
  const u = (x - b.minX) / Math.max(1, b.maxX - b.minX);
  const v = (z - b.minZ) / Math.max(1, b.maxZ - b.minZ);
  const ns = v < 1 / 3 ? "north" : v > 2 / 3 ? "south" : "";
  const ew = u < 1 / 3 ? "west" : u > 2 / 3 ? "east" : "";
  if (!ns && !ew) return "the centre";
  return "the " + (ns && ew ? `${ns}-${ew}` : ns || ew);
}

/** momentWindow is the frames whose deaths explain a moment: its own window
 * plus the step before it, since a step's value is read at its END and the
 * deaths that moved it happened during it. */
export function momentWindow(ins: Insights, m: Moment): [number, number] {
  return [Math.max(0, m.f0 - ins.stepSec * SIM_FPS), m.f1];
}

/** sideLosses tallies each side's deaths inside [f0, f1], leaving out the
 * units that went down with an eliminated team: those were not fought for. */
export function sideLosses(ins: Insights, f0: number, f1: number): SideLoss[] {
  const sideOf = sideOfTeam(ins);
  const wiped = wipedOf(ins);
  const owner = new Map(ins.teams.map((t) => [t.team, t.player ?? ""]));
  const out = ins.sides.map(() => ({ n: 0, metal: 0, commanders: [] as string[], commanderDeaths: [] as number[], top: -1, topCost: -1, kinds: new Map<string, [number, number]>(), sx: 0, sz: 0, w: 0 }));
  const d = ins.deaths;
  for (let i = 0; i < d.f.length; i++) {
    if (d.f[i] < f0 || d.f[i] > f1 || wiped(i)) continue;
    const side = sideOf.get(d.team[i]) ?? -1;
    if (side < 0 || side >= out.length) continue;
    const o = out[side];
    const def = ins.defs[String(d.def[i])];
    const cost = d.cost[i] ?? 0;
    o.n++;
    o.metal += cost;
    if (def && isCommander(def.name)) {
      o.commanders.push(owner.get(d.team[i]) || sideName(ins, side));
      o.commanderDeaths.push(i);
    }
    if (cost > o.topCost) {
      o.topCost = cost;
      o.top = i;
    }
    const name = def?.human || def?.name || "unit";
    const k = o.kinds.get(name) ?? [0, 0];
    o.kinds.set(name, [k[0] + 1, k[1] + cost]);
    if (d.x[i] >= 0) {
      const w = Math.max(1, cost);
      o.sx += d.x[i] * w;
      o.sz += d.z[i] * w;
      o.w += w;
    }
  }
  return out.map((o) => ({
    n: o.n,
    metal: o.metal,
    commanders: o.commanders,
    commanderDeaths: o.commanderDeaths,
    top: o.top,
    kinds: [...o.kinds.entries()].map(([name, [n, metal]]) => [name, n, metal] as [string, number, number])
      .sort((a, b) => b[2] - a[2] || b[1] - a[1]),
    at: o.w ? [o.sx / o.w, o.sz / o.w] : null,
  }));
}

/** lossText is "12 units (2.1k metal): 3 Thud, 2 Pawn", or "nothing". */
export function lossText(l: SideLoss, priced: boolean): string {
  if (l.n === 0) return "nothing";
  const head = `${l.n} unit${l.n === 1 ? "" : "s"}` + (priced && l.metal > 0 ? ` (${fmtMetal(l.metal)} metal)` : "");
  const kinds = l.kinds.slice(0, 3).map(([name, n]) => (n > 1 ? `${n} ${name}` : name)).join(", ");
  return kinds ? `${head}: ${kinds}` : head;
}

function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/** momentStory names a moment and says what happened in it. */
export function momentStory(ins: Insights, m: Moment): MomentStory {
  const [f0, f1] = momentWindow(ins, m);
  const lost = sideLosses(ins, f0, f1);
  const won = m.side;
  const lose = 1 - won;
  const priced = ins.costCoverage === "full" || lost.some((l) => l.metal > 0);
  const W = sideName(ins, won);
  const L = sideName(ins, lose);
  const ll = lost[lose] ?? { n: 0, metal: 0, commanders: [], commanderDeaths: [], top: -1, kinds: [], at: null };
  const wl = lost[won] ?? { n: 0, metal: 0, commanders: [], commanderDeaths: [], top: -1, kinds: [], at: null };
  const size = (l: SideLoss) => (priced ? l.metal : l.n);
  // Where it happened: the focus when it has a place (the commander's
  // death, the fight's busiest spot), else the centre of what was lost.
  const at = (f: Focus | null) => {
    if (f && typeof f.x === "number" && typeof f.z === "number") return ` in ${compass(ins, f.x, f.z)}`;
    return ll.at ? ` in ${compass(ins, ll.at[0], ll.at[1])}` : "";
  };

  // A player leaving takes their whole army off the board, which is the
  // shift whatever else happened in the window.
  const out = knockouts(ins).filter((k) => k.side === lose && k.f >= f0 && k.f <= f1);
  let title: string;
  let focus: Focus | null;
  // An elimination or a quiet stretch has no battle of its own to credit.
  let fight = true;
  if (out.length === 1) {
    fight = false;
    focus = eliminationFocus(ins, out[0].team, out[0].f);
    title = `${out[0].name} is eliminated`;
  } else if (out.length > 1) {
    fight = false;
    focus = eliminationFocus(ins, out[0].team, out[0].f);
    title = `${out.length} of ${possessive(L)} players are eliminated`;
  } else if (ll.commanders.length === 1) {
    focus = deathFocus(ins, ll.commanderDeaths[0]);
    title = `${possessive(ll.commanders[0])} commander falls${at(focus)}`;
  } else if (ll.commanders.length > 1) {
    focus = deathFocus(ins, ll.commanderDeaths[0]);
    title = `${ll.commanders.length} of ${possessive(L)} commanders fall${at(focus)}`;
  } else if (size(ll) < (priced ? QUIET_METAL : 3) && size(ll) <= size(wl) * 1.5) {
    // No real fight: the line moved on what each side built.
    fight = false;
    focus = null;
    title = armyGrew(ins, m, won) ? `${W} out-builds ${L}` : `${W} pulls ahead on income`;
  } else if (ll.kinds.length && priced && ll.kinds[0][1] === 1 && ll.kinds[0][2] >= SINGLE_SHARE * ll.metal && ll.kinds[0][2] >= 500) {
    focus = deathFocus(ins, ll.top);
    title = `${L} loses a ${ll.kinds[0][0]}${at(focus)}`;
  } else if (size(wl) === 0 || size(ll) >= 2 * size(wl)) {
    focus = burstFocus(ins, f0, f1);
    title = `${W} wins the fight${at(focus)}`;
  } else {
    focus = burstFocus(ins, f0, f1);
    title = `${W} edges a trade${at(focus)}`;
  }
  const detail = `${L} lost ${lossText(ll, priced)}; ${W} lost ${lossText(wl, priced)}.`;
  const battle = battleOfMoment(ins, focus, f0, f1);
  const fought = fight ? fighters(ins, ins.battles[battle]) : ins.sides.map(() => []);
  return { title, detail, lost, battle, focus, fighters: fought };
}

/** battleOfMoment is the battle a moment was: the one running when its focus
 * happened, nearest to it, or — with no focus, or none running then — the
 * one overlapping its window most. Overlap alone picks a long battle that
 * merely spans the moment over the short one that made it. */
function battleOfMoment(ins: Insights, focus: Focus | null, f0: number, f1: number): number {
  const pad = ins.stepSec * SIM_FPS;
  if (focus) {
    let best = -1;
    let bestD = Infinity;
    ins.battles.forEach((b, i) => {
      if (focus.f < b.f0 - pad || focus.f > b.f1 + pad) return;
      const d = typeof focus.x === "number" && typeof focus.z === "number"
        ? Math.hypot(b.x - focus.x, b.z - focus.z) - b.r
        : 0;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) return best;
  }
  let battle = -1;
  let most = 0;
  ins.battles.forEach((b, i) => {
    const ov = Math.min(b.f1, f1) - Math.max(b.f0, f0);
    if (ov > most) {
      most = ov;
      battle = i;
    }
  });
  return battle;
}

/** deathFocus is one unit's death: when, and where it was last seen. */
export function deathFocus(ins: Insights, i: number): Focus | null {
  const d = ins.deaths;
  if (i < 0 || i >= d.f.length) return null;
  return d.x[i] >= 0 ? { f: d.f[i], x: d.x[i], z: d.z[i], r: 700 } : { f: d.f[i] };
}

/** eliminationFocus is a team going out: the moment, centred on what it
 * lost with it (its last units, wherever they stood). */
export function eliminationFocus(ins: Insights, team: number, f: number): Focus {
  const d = ins.deaths;
  const pts: [number, number][] = [];
  for (let i = 0; i < d.f.length; i++) {
    if (d.team[i] === team && d.f[i] >= f && d.f[i] <= f + BURST_SEC * SIM_FPS && d.x[i] >= 0) pts.push([d.x[i], d.z[i]]);
  }
  return { f, ...spread(pts) };
}

/** burstFocus is the busiest killing inside [f0, f1]: the BURST_SEC by
 * BURST_RADIUS box holding the most metal lost (by count when the file
 * prices nothing), at its first death and centred on the deaths in it.
 * Deaths that went down with an eliminated team are left out, as
 * everywhere a fight is told. */
function burstFocus(ins: Insights, f0: number, f1: number): Focus | null {
  const d = ins.deaths;
  const wiped = wipedOf(ins);
  const priced = d.cost.some((c) => c > 0);
  const idx: number[] = [];
  for (let i = 0; i < d.f.length; i++) if (d.f[i] >= f0 && d.f[i] <= f1 && d.x[i] >= 0 && !wiped(i)) idx.push(i);
  if (!idx.length) return null;
  idx.sort((a, b) => d.f[a] - d.f[b]);
  const w = (i: number) => (priced ? Math.max(1, d.cost[i] ?? 0) : 1);
  let best = -1;
  let bestAt = 0;
  for (let k = 0; k < idx.length; k++) {
    const a = idx[k];
    let sum = 0;
    for (let j = k; j < idx.length && d.f[idx[j]] - d.f[a] <= BURST_SEC * SIM_FPS; j++) {
      const b = idx[j];
      if (Math.hypot(d.x[b] - d.x[a], d.z[b] - d.z[a]) <= BURST_RADIUS) sum += w(b);
    }
    if (sum > best) {
      best = sum;
      bestAt = k;
    }
  }
  const a = idx[bestAt];
  const pts: [number, number][] = [];
  for (let j = bestAt; j < idx.length && d.f[idx[j]] - d.f[a] <= BURST_SEC * SIM_FPS; j++) {
    const b = idx[j];
    if (Math.hypot(d.x[b] - d.x[a], d.z[b] - d.z[a]) <= BURST_RADIUS) pts.push([d.x[b], d.z[b]]);
  }
  return { f: d.f[a], ...spread(pts) };
}

/** spread is the centre of a set of points and a radius holding most of
 * them, or nothing for no points. */
function spread(pts: [number, number][]): Partial<Focus> {
  if (!pts.length) return {};
  const x = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const z = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const dist = pts.map((p) => Math.hypot(p[0] - x, p[1] - z)).sort((a, b) => a - b);
  return { x, z, r: Math.max(600, dist[Math.floor(dist.length * 0.8)] ?? 0) };
}

/** armyGrew is whether the gaining side's army grew more than the other's
 * over the window (else the shift came from income). */
function armyGrew(ins: Insights, m: Moment, won: number): boolean {
  const a = ins.series.army;
  if (a.length !== 2) return false;
  const step = (f: number) => Math.max(0, Math.min(a[0].length - 1, Math.round(f / SIM_FPS / ins.stepSec) - 1));
  const i0 = step(m.f0);
  const i1 = step(m.f1);
  const g = (side: number) => (a[side][i1] ?? 0) - (a[side][i0] ?? 0);
  return g(won) > g(1 - won);
}
