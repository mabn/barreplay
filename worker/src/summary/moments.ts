// What happened in a swing: a name and a one-line account for each moment
// of the win-probability line, written from the deaths inside its window.
// Nothing in a capture says who killed what, so a moment is told from what
// each side LOST, where, and how the armies moved — the same facts a battle
// card uses. Pure, so the node tests can pin the wording rules.
import { fmtClock, fmtMetal } from "./format";
import { knockouts, wipedOf } from "./losses";
import { sideName, sideOfTeam } from "./model";
import { SIM_FPS, type Battle, type Insights, type Moment, type UnitLoss } from "./types";

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
  /** The same losses by def, most metal first (what icons are drawn from). */
  units: UnitLoss[];
  /** Where the side's losses were, cost-weighted, or null with none. */
  at: [number, number] | null;
}

export interface MomentStory {
  title: string;
  detail: string;
  lost: SideLoss[];
  /** What each side lost in the EVENT the story tells: the battle's own
   * losses for a fight, else the whole window's (= lost). */
  shown: SideLoss[];
  /** For a fight, what each side lost ELSEWHERE in the window when that is
   * worth a mention (null otherwise). */
  elsewhere: number[] | null;
  /** The whole battle a shared moment told only part of, else null. */
  whole: Battle | null;
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
  /** When the event runs on (a raid, a fight), where it ends: the moment is
   * then the RANGE [f, f1], which is how a host should mark it. */
  f1?: number;
  x?: number;
  z?: number;
  r?: number;
}

/** Elmos past a battle's radius whose deaths still count as the battle's,
 * the same reach the insights give its armies. */
const BATTLE_REACH = 600;

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
 * least FIGHTER_SHARE of their side's army there plus what it lost and
 * killed there, biggest first. Killing counts so a long-range gun or a nuke
 * fired from across the map is a fighter in the battle it hit. */
export function fighters(ins: Insights, b: Battle | undefined): Fighter[][] {
  const out: Fighter[][] = ins.sides.map(() => []);
  if (!b?.teams) return out;
  const sideOf = sideOfTeam(ins);
  const owner = new Map(ins.teams.map((t) => [t.team, t.player ?? ""]));
  const total = ins.sides.map(() => 0);
  for (const t of b.teams) {
    const sd = sideOf.get(t.team) ?? -1;
    if (sd >= 0 && sd < total.length) total[sd] += t.army + t.lost + (t.killed ?? 0);
  }
  for (const t of b.teams) {
    const sd = sideOf.get(t.team) ?? -1;
    if (sd < 0 || sd >= total.length || total[sd] <= 0) continue;
    const metal = t.army + t.lost + (t.killed ?? 0);
    const share = metal / total[sd];
    if (share >= FIGHTER_SHARE) out[sd].push({ name: owner.get(t.team) || `Team ${t.team}`, team: t.team, metal, share });
  }
  for (const list of out) list.sort((a, b) => b.metal - a.metal);
  return out;
}

/** selfDestructed is whether death i was a unit its owner blew up (a
 * version 5 file; older ones cannot say). */
export function selfDestructed(ins: Insights, i: number): boolean {
  return i >= 0 && ins.deaths.selfd?.[i] === 1;
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
 * plus a step either side. Before, since a step's value is read at its END
 * and the deaths that moved it happened during it; after, because a raid
 * shows on the line as soon as it starts while its biggest losses can land
 * seconds later — measured on a real 8v8, the bombers' first kills were
 * inside the window and the four advanced fusions they blew up one second
 * past it, so the story told of everything but the main event. */
export function momentWindow(ins: Insights, m: Moment): [number, number] {
  const step = ins.stepSec * SIM_FPS;
  return [Math.max(0, m.f0 - step), m.f1 + step];
}

/** sideLosses tallies each side's deaths inside [f0, f1], leaving out the
 * units that went down with an eliminated team: those were not fought for. */
export function sideLosses(ins: Insights, f0: number, f1: number, area?: { x: number; z: number; r: number }): SideLoss[] {
  const sideOf = sideOfTeam(ins);
  const wiped = wipedOf(ins);
  const owner = new Map(ins.teams.map((t) => [t.team, t.player ?? ""]));
  const out = ins.sides.map(() => ({ n: 0, metal: 0, commanders: [] as string[], commanderDeaths: [] as number[], top: -1, topCost: -1, kinds: new Map<string, [number, number]>(), units: new Map<number, UnitLoss>(), sx: 0, sz: 0, w: 0 }));
  const d = ins.deaths;
  for (let i = 0; i < d.f.length; i++) {
    if (d.f[i] < f0 || d.f[i] > f1 || wiped(i)) continue;
    if (area && (d.x[i] < 0 || Math.hypot(d.x[i] - area.x, d.z[i] - area.z) > area.r)) continue;
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
    const u = o.units.get(d.def[i]) ?? { def: d.def[i], n: 0, metal: 0 };
    u.n++;
    u.metal += cost;
    o.units.set(d.def[i], u);
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
    units: [...o.units.values()].sort((a, b) => b.metal - a.metal || b.n - a.n),
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
export function momentStory(ins: Insights, m: Moment, shared?: ReadonlySet<number>): MomentStory {
  const [f0, f1] = momentWindow(ins, m);
  const lost = sideLosses(ins, f0, f1);
  const won = m.side;
  const lose = 1 - won;
  const priced = ins.costCoverage === "full" || lost.some((l) => l.metal > 0);
  const W = sideName(ins, won);
  const L = sideName(ins, lose);
  const ll = lost[lose] ?? { n: 0, metal: 0, commanders: [], commanderDeaths: [], top: -1, kinds: [], units: [], at: null };
  const wl = lost[won] ?? { n: 0, metal: 0, commanders: [], commanderDeaths: [], top: -1, kinds: [], units: [], at: null };
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
  // A fight's own losses, when it is told as one event (see below).
  let local: SideLoss[] | null = null;
  // An elimination or a quiet stretch has no battle of its own to credit.
  let fight = true;
  // The battle a shared moment told only part of.
  let whole: Battle | null = null;
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
    title = selfDestructed(ins, ll.commanderDeaths[0])
      ? `${ll.commanders[0]} self-destructs their commander${at(focus)}`
      : `${possessive(ll.commanders[0])} commander falls${at(focus)}`;
  } else if (ll.commanders.length > 1) {
    focus = deathFocus(ins, ll.commanderDeaths[0]);
    title = ll.commanderDeaths.every((i) => selfDestructed(ins, i))
      ? `${ll.commanders.length} of ${possessive(L)} commanders self-destruct${at(focus)}`
      : `${ll.commanders.length} of ${possessive(L)} commanders fall${at(focus)}`;
  } else if (size(ll) < (priced ? QUIET_METAL : 3) && size(ll) <= size(wl) * 1.5) {
    // No real fight: the line moved on what each side built.
    fight = false;
    focus = null;
    title = armyGrew(ins, m, won) ? `${W} out-builds ${L}` : `${W} pulls ahead on income`;
  } else if (ll.kinds.length && priced && ll.kinds[0][1] === 1 && ll.kinds[0][2] >= SINGLE_SHARE * ll.metal && ll.kinds[0][2] >= 500) {
    focus = deathFocus(ins, ll.top);
    title = selfDestructed(ins, ll.top)
      ? `${L} self-destructs a ${ll.kinds[0][0]}${at(focus)}`
      : `${L} loses a ${ll.kinds[0][0]}${at(focus)}`;
  } else {
    // A fight: told as the EVENT it was — the battle running at its busiest
    // killing, from start to end, and only what died there — not as the sum
    // of a window that also holds whatever died elsewhere at the time.
    // Which one is decided by DISTANCE as well as time: of the battles
    // running in the window, the one where the most metal went down — two
    // fights on opposite sides of the map at once are two stories, and the
    // densest burst of killing (what used to pick) favours a short air
    // skirmish over a long ground war that cost twice as much.
    const bi = biggestFight(ins, f0, f1);
    const b = ins.battles[bi];
    if (b) {
      // A long battle can hold more than one swing; told whole, each of
      // them read the same sentence over the same span. Shared, each tells
      // only its own part of it.
      const part = shared?.has(bi) ? [Math.max(b.f0, f0), Math.min(b.f1, f1)] : [b.f0, b.f1];
      focus = { f: part[0], f1: part[1], x: b.x, z: b.z, r: b.r };
      local = sideLosses(ins, part[0], part[1], { x: b.x, z: b.z, r: b.r + BATTLE_REACH });
      if (part[0] !== b.f0 || part[1] !== b.f1) whole = b;
    } else {
      focus = burstFocus(ins, f0, f1);
    }
    const lw = local ? local[won] : wl;
    const lo = local ? local[lose] : ll;
    // No one battle holds it: the losses were spread over the map. The line
    // moves on the ARMY, so say how much of it went — a ten-second burst
    // somewhere is not what moved it — and watch the whole window.
    const drop = b ? null : armyDrop(ins, lose, f0, f1);
    // The line moved toward W, but W can still have lost more there (its
    // army was bigger, or what it lost mattered less): then the title states
    // the trade rather than calling it a win the numbers beside it deny.
    const unit = (v: number) => (priced ? `${fmtMetal(v)} metal` : `${v} units`);
    if (drop) {
      focus = { f: f0, f1 };
      title = `${L} loses ${Math.round(drop.share * 100)}% of its army${drop.mostly ? `, mostly ${drop.mostly}` : ""}`;
    } else title = size(lw) === 0 || size(lo) >= 2 * size(lw) ? `${W} wins the fight${at(focus)}`
      : size(lw) <= size(lo) ? `${W} wins a close fight${at(focus)}`
      : `${W} trades ${unit(size(lw))} for ${unit(size(lo))}${at(focus)}`;
  }
  const dl = local ? local[lose] : ll;
  const dw = local ? local[won] : wl;
  let detail = local
    ? `There, ${fmtClock(focus!.f / SIM_FPS)}–${fmtClock((focus!.f1 ?? focus!.f) / SIM_FPS)}: ${L} lost ${lossText(dl, priced)}; ${W} lost ${lossText(dw, priced)}.`
    : `${L} lost ${lossText(ll, priced)}; ${W} lost ${lossText(wl, priced)}.`;
  if (whole) detail += ` Part of a fight from ${fmtClock(whole.f0 / SIM_FPS)} to ${fmtClock(whole.f1 / SIM_FPS)}.`;
  let elsewhere: number[] | null = null;
  if (local && priced) {
    // What went down elsewhere at the time, when it is worth a mention: the
    // reader should not take this fight for the whole story.
    const rest = (side: number) => Math.max(0, (lost[side]?.metal ?? 0) - (local![side]?.metal ?? 0));
    const here = (local[won]?.metal ?? 0) + (local[lose]?.metal ?? 0);
    if (rest(won) + rest(lose) >= 0.25 * here && rest(won) + rest(lose) >= QUIET_METAL) {
      detail += ` Elsewhere at the time: ${L} lost ${fmtMetal(rest(lose))} metal, ${W} ${fmtMetal(rest(won))}.`;
      elsewhere = ins.sides.map((_, sd) => rest(sd));
    }
  }
  const battle = battleOfMoment(ins, focus, f0, f1);
  const fought = fight ? fighters(ins, ins.battles[battle]) : ins.sides.map(() => []);
  return { title, detail, lost, shown: local ?? lost, elsewhere, whole, battle, focus, fighters: fought };
}

/** momentStories tells every moment of a swing line. A battle that two or
 * more of them would each tell whole is told in parts instead: each moment
 * then covers only the stretch of it inside its own window. */
export function momentStories(ins: Insights, moments: Moment[]): MomentStory[] {
  const first = moments.map((m) => momentStory(ins, m));
  const told = new Map<number, number>();
  for (const st of first) {
    if (st.battle >= 0 && st.focus?.f1 !== undefined) told.set(st.battle, (told.get(st.battle) ?? 0) + 1);
  }
  const shared = new Set([...told].filter(([, n]) => n > 1).map(([b]) => b));
  if (!shared.size) return first;
  return moments.map((m, k) => (shared.has(first[k].battle) ? momentStory(ins, m, shared) : first[k]));
}

/** The share of its army a side must lose over a moment, with no single
 * battle to tell, for the moment to be told as that loss. */
const ARMY_DROP_SHARE = 0.25;

/** What the army categories are called in a sentence ("mostly air"). */
const CAT_WORDS: Record<string, string> = { air: "aircraft", light: "light units", medium: "medium units", heavy: "heavy units", experimental: "experimentals" };

/** armyDrop is how much of side's army went over [f0, f1] — its value at
 * the step before the window against the lowest it reached in it — and the
 * category carrying most of that, when it is at least ARMY_DROP_SHARE. */
export function armyDrop(ins: Insights, side: number, f0: number, f1: number): { share: number; mostly?: string } | null {
  const s = ins.series;
  const a = s.army?.[side];
  if (!a?.length) return null;
  // The last step at or before a frame.
  const idx = (f: number) => {
    let i = 0;
    while (i + 1 < s.t.length && s.t[i + 1] <= f / SIM_FPS) i++;
    return Math.min(i, a.length - 1);
  };
  const i0 = idx(f0);
  const i1 = idx(f1);
  let low = i0;
  for (let i = i0; i <= i1; i++) if (a[i] < a[low]) low = i;
  const start = a[i0];
  if (!(start > 0) || (start - a[low]) / start < ARMY_DROP_SHARE) return null;
  const out: { share: number; mostly?: string } = { share: (start - a[low]) / start };
  const cats = s.armyByCat?.[side];
  if (cats?.length === s.armyCats.length) {
    let best = -1;
    let bestDrop = 0;
    cats.forEach((c, k) => {
      const d = (c[i0] ?? 0) - (c[low] ?? 0);
      if (d > bestDrop) {
        bestDrop = d;
        best = k;
      }
    });
    if (best >= 0 && bestDrop >= 0.5 * (start - a[low])) out.mostly = CAT_WORDS[s.armyCats[best]] ?? s.armyCats[best];
  }
  return out;
}

/** biggestFight is the battle running inside [f0, f1] where the most metal
 * went down within that window, or -1 when none is. */
function biggestFight(ins: Insights, f0: number, f1: number): number {
  let best = -1;
  let most = 0;
  ins.battles.forEach((b, i) => {
    const a = Math.max(b.f0, f0);
    const e = Math.min(b.f1, f1);
    if (e < a) return;
    const sum = sideLosses(ins, a, e, { x: b.x, z: b.z, r: b.r + BATTLE_REACH }).reduce((s, l) => s + l.metal + l.n, 0);
    if (sum > most) {
      most = sum;
      best = i;
    }
  });
  return best;
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
  let last = d.f[a];
  for (let j = bestAt; j < idx.length && d.f[idx[j]] - d.f[a] <= BURST_SEC * SIM_FPS; j++) last = d.f[idx[j]];
  return { f: d.f[a], f1: last, ...spread(pts) };
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

/** A battle told in the swing list because nothing else was: the line went
 * quiet on the list for a stretch in which armies still died. */
export interface GapBattle {
  /** Index into battles (the battles section numbers it battle + 1). */
  battle: number;
  /** The side that lost less there, -1 for an even trade. */
  side: number;
  /** How far the line moved toward side across the battle (may be <= 0). */
  delta: number;
  /** "decisive" when the other side lost twice as much or more. */
  verdict: "decisive" | "win" | "even";
}

/** A stretch of the game this long with nothing in the swing list is a gap
 * worth filling: a sixth of the game, at least four minutes. */
const GAP_SHARE = 1 / 8;
const GAP_MIN_SEC = 240;
/** A filler stays this far from every entry already listed. */
const GAP_APART_SEC = 90;
/** A battle under this share of the game's biggest is not worth a line. */
const GAP_BATTLE_SHARE = 0.1;
/** The swing list holds at most this many entries in all. */
const LIST_MAX = 12;

/** gapBattles picks battles to tell between the swings, where the list
 * would otherwise skip a long stretch of the game: the swing line only
 * lists its biggest shifts, and a fight can decide a lot without being one
 * of them (the line was already far over, or two fights cancelled out).
 * Greedily, the biggest battle in the widest gap goes in, until no gap is
 * wider than GAP_SHARE of the game or none holds a battle worth telling.
 * A battle a swing already tells, or one overlapping a swing's window, is
 * left out. Ordered by time. */
export function gapBattles(ins: Insights, moments: Moment[], stories: MomentStory[]): GapBattle[] {
  const sw = ins.swing;
  if (!sw || !ins.battles.length) return [];
  const priced = ins.costCoverage === "full" || ins.battles.some((b) => b.lost.some((l) => l.metal > 0));
  const size = (l?: { n: number; metal: number }) => (l ? (priced ? l.metal : l.n) : 0);
  const total = (b: Battle) => size(b.lost[0]) + size(b.lost[1]);
  const biggest = Math.max(...ins.battles.map(total));
  const told = new Set(stories.map((st) => st.battle).filter((b) => b >= 0));
  const gap = Math.max(GAP_MIN_SEC, ins.durationSec * GAP_SHARE) * SIM_FPS;
  const apart = GAP_APART_SEC * SIM_FPS;
  const end = ins.durationSec * SIM_FPS;
  // Where each entry sits on the time axis: a swing at the end of its
  // window (where its dot is), a battle at its end.
  const marks = moments.map((m) => m.f1);
  const free = ins.battles.map((_, i) => i).filter((i) => {
    const b = ins.battles[i];
    return !told.has(i) && total(b) > 0 && total(b) >= GAP_BATTLE_SHARE * biggest
      && !moments.some((m) => b.f0 <= m.f1 && b.f1 >= m.f0);
  });
  const picked: number[] = [];
  while (marks.length < LIST_MAX) {
    const at = [0, ...marks].sort((a, b) => a - b);
    // The gaps, widest first, and the biggest battle that fits in one.
    const gaps = at.map((a, k) => [a, k + 1 < at.length ? at[k + 1] : end]).filter(([a, e]) => e - a > gap)
      .sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]));
    let pick = -1;
    for (const [a, e] of gaps) {
      for (const i of free) {
        const f = ins.battles[i].f1;
        if (picked.includes(i) || f <= a || f >= e || marks.some((m) => Math.abs(m - f) < apart)) continue;
        if (pick < 0 || total(ins.battles[i]) > total(ins.battles[pick])) pick = i;
      }
      if (pick >= 0) break;
    }
    if (pick < 0) break;
    picked.push(pick);
    marks.push(ins.battles[pick].f1);
  }
  const t = ins.series.t.map((x) => Math.min(ins.durationSec, x + ins.stepSec));
  const pAt = (sec: number) => {
    let i = 0;
    while (i + 1 < t.length && t[i + 1] <= sec) i++;
    return sw.p[i] ?? 0.5;
  };
  return picked.sort((a, b) => a - b).map((i) => {
    const b = ins.battles[i];
    const [a, c] = [size(b.lost[0]), size(b.lost[1])];
    const side = Math.abs(a - c) <= 0.1 * Math.max(a, c) ? -1 : a < c ? 0 : 1;
    const lo = Math.min(a, c);
    const hi = Math.max(a, c);
    const verdict = side < 0 ? "even" : lo === 0 || hi >= 2 * lo ? "decisive" : "win";
    const move = pAt(b.f1 / SIM_FPS + ins.stepSec) - pAt(b.f0 / SIM_FPS);
    return { battle: i, side, delta: side === 1 ? -move : move, verdict };
  });
}
