// What happened in a swing: a name and a one-line account for each moment
// of the win-probability line, written from the deaths inside its window.
// Nothing in a capture says who killed what, so a moment is told from what
// each side LOST, where, and how the armies moved — the same facts a battle
// card uses. Pure, so the node tests can pin the wording rules.
import { fmtMetal } from "./format";
import { sideName, sideOfTeam } from "./model";
import { SIM_FPS, type Insights, type Moment } from "./types";

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
  /** Kinds lost, most metal first: [name, count, metal]. */
  kinds: [string, number, number][];
  /** Where the side's losses were, cost-weighted, or null with none. */
  at: [number, number] | null;
}

export interface MomentStory {
  title: string;
  detail: string;
  lost: SideLoss[];
  /** Index into battles of the battle overlapping the window, -1 for none. */
  battle: number;
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

/** sideLosses tallies each side's deaths inside [f0, f1]. */
export function sideLosses(ins: Insights, f0: number, f1: number): SideLoss[] {
  const sideOf = sideOfTeam(ins);
  const owner = new Map(ins.teams.map((t) => [t.team, t.player ?? ""]));
  const out = ins.sides.map(() => ({ n: 0, metal: 0, commanders: [] as string[], kinds: new Map<string, [number, number]>(), sx: 0, sz: 0, w: 0 }));
  const d = ins.deaths;
  for (let i = 0; i < d.f.length; i++) {
    if (d.f[i] < f0 || d.f[i] > f1) continue;
    const side = sideOf.get(d.team[i]) ?? -1;
    if (side < 0 || side >= out.length) continue;
    const o = out[side];
    const def = ins.defs[String(d.def[i])];
    const cost = d.cost[i] ?? 0;
    o.n++;
    o.metal += cost;
    if (def && isCommander(def.name)) o.commanders.push(owner.get(d.team[i]) || sideName(ins, side));
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
  const ll = lost[lose] ?? { n: 0, metal: 0, commanders: [], kinds: [], at: null };
  const wl = lost[won] ?? { n: 0, metal: 0, commanders: [], kinds: [], at: null };
  const where = ll.at ? ` in ${compass(ins, ll.at[0], ll.at[1])}` : "";
  const size = (l: SideLoss) => (priced ? l.metal : l.n);

  let title: string;
  if (ll.commanders.length === 1) {
    title = `${possessive(ll.commanders[0])} commander falls${where}`;
  } else if (ll.commanders.length > 1) {
    title = `${ll.commanders.length} of ${possessive(L)} commanders fall${where}`;
  } else if (size(ll) < (priced ? QUIET_METAL : 3) && size(ll) <= size(wl) * 1.5) {
    // No real fight: the line moved on what each side built.
    title = armyGrew(ins, m, won) ? `${W} out-builds ${L}` : `${W} pulls ahead on income`;
  } else if (ll.kinds.length && priced && ll.kinds[0][1] === 1 && ll.kinds[0][2] >= SINGLE_SHARE * ll.metal && ll.kinds[0][2] >= 500) {
    title = `${L} loses a ${ll.kinds[0][0]}${where}`;
  } else if (size(wl) === 0 || size(ll) >= 2 * size(wl)) {
    title = `${W} wins the fight${where}`;
  } else {
    title = `${W} edges a trade${where}`;
  }
  const detail = `${L} lost ${lossText(ll, priced)}; ${W} lost ${lossText(wl, priced)}.`;
  let battle = -1;
  let best = 0;
  ins.battles.forEach((b, i) => {
    const ov = Math.min(b.f1, f1) - Math.max(b.f0, f0);
    if (ov > best) {
      best = ov;
      battle = i;
    }
  });
  return { title, detail, lost, battle };
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
