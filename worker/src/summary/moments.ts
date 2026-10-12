// What happened in a swing: a name and a one-line account for each moment
// of the win-probability line, written from the deaths inside its window.
// Nothing in a capture says who killed what, so a moment is told from what
// each side LOST, where, and how the armies moved — the same facts a battle
// card uses. Pure, so the node tests can pin the wording rules.
import { fmtClock, fmtMetal } from "./format";
import { knockouts, wipedOf } from "./losses";
import { defWorth, lossWorth, sideName, sideOfTeam, sideShort } from "./model";
import { battlePhrase, battleWhere, marginPhrase, plural } from "./phrases";
import { at as placeAt, place } from "./places";
import { QUIPS_MAX, quip, type Quip, type QuipFacts } from "./quips";
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
  /** The metal weighted by each def's worth (model.ts defWorth: power
   * plants, and buildings in a capture that names killers): what decides who
   * won. */
  worth: number;
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
  /** For a moment the sides' building moved rather than a fight, what each
   * side's army and metal income went from and to; null otherwise. */
  growth: SideGrowth[] | null;
  /** Which of the growth's army value, income and buildings the story
   * names. */
  growthNamed: { army: boolean; eco: boolean; build: boolean } | null;
  /** The growth's army numbers carry the standing defences (version 10:
   * the line reads them with the army, and they were a real part of it). */
  armyDefences: boolean;
  /** For a build-up story, per side, what it built and lost of the kinds
   * of building the story is about; for a base going up, the buildings the
   * side lost (version 10); null otherwise. */
  buildLines: BuildLine[][] | null;
  /** A line of colour now and then (quips.ts), null mostly. */
  quip: Quip | null;
  /** A build-up story's window held a fight the gaining side LOST: each
   * side's losses there (the part inside the window), said beside the
   * build-up; null otherwise. */
  lostFight: SideLoss[] | null;
}

/** One side's army value (metal) and metal income (per second) at the start
 * and the end of a moment's window. */
export interface SideGrowth {
  army: [number, number];
  /** Averaged over the minutes before each end, as the win model reads it. */
  income: [number, number];
  /** Metal produced since the start, at each end. */
  mined: [number, number];
  /** Its standing buildings but the defences, and the defences, in metal
   * (version 10; 0 before). */
  buildings: [number, number];
  defences: [number, number];
}

/** One line of buildings under a side in a build-up story: what it
 * finished, or what it lost, by def. */
export interface BuildLine {
  verb: "built" | "lost";
  /** Since when: "built since 21:15". */
  label: string;
  n: number;
  metal: number;
  units: UnitLoss[];
}

/** Steps the win model averages income over (swing.go swingIncomeSteps):
 * a minute before version 9, three minutes since. */
function incomeSteps(ins: Insights): number {
  return ins.version >= 9 ? 12 : 4;
}

/** Standing defences are said with the army when they are at least this
 * share of army and defences together. */
const DEFENCE_SHARE = 0.1;

/** standing is a side's standing buildings at step i (version 10): the
 * defences, which the line reads with the army, and everything else, which
 * it reads as buildings. */
export function standing(ins: Insights, side: number, i: number): { defences: number; buildings: number } {
  const b = ins.series.buildings?.[side];
  const out = { defences: 0, buildings: 0 };
  if (!b) return out;
  (ins.series.buildingCats ?? []).forEach((c, k) => {
    const xs = b[k] ?? [];
    const v = xs[Math.max(0, Math.min(i, xs.length - 1))] ?? 0;
    if (c === "defence") out.defences += v;
    else out.buildings += v;
  });
  return out;
}

/** A side's loss of buildings: how many, how much metal, by def (the most
 * metal first) and by category, the factories' part, where and when. */
export interface BuildingLoss {
  n: number;
  metal: number;
  units: UnitLoss[];
  byCat: Map<string, number>;
  factory: number;
  pts: [number, number][];
  first: number;
  last: number;
}

/** buildingLosses is what side lost of its buildings (Def.stand, version
 * 10) in [f0, f1], of the categories in cats when given. What went down
 * with an eliminated team is left out, as everywhere a loss is told. */
export function buildingLosses(ins: Insights, side: number, f0: number, f1: number, cats?: ReadonlySet<string>, area?: { x: number; z: number; r: number }): BuildingLoss {
  const sideOf = sideOfTeam(ins);
  const wiped = wipedOf(ins);
  const d = ins.deaths;
  const units = new Map<number, UnitLoss>();
  const out: BuildingLoss = { n: 0, metal: 0, units: [], byCat: new Map(), factory: 0, pts: [], first: Infinity, last: -Infinity };
  for (let i = 0; i < d.f.length; i++) {
    if (d.f[i] < f0 || d.f[i] > f1 || wiped(i) || sideOf.get(d.team[i]) !== side) continue;
    if (area && (d.x[i] < 0 || Math.hypot(d.x[i] - area.x, d.z[i] - area.z) > area.r)) continue;
    const def = ins.defs[String(d.def[i])];
    const cat = def?.stand;
    if (!cat || (cats && !cats.has(cat))) continue;
    const cost = d.cost[i] ?? 0;
    out.n++;
    out.metal += cost;
    out.byCat.set(cat, (out.byCat.get(cat) ?? 0) + cost);
    if (def.class === "factory") out.factory += cost;
    const u = units.get(d.def[i]) ?? { def: d.def[i], n: 0, metal: 0 };
    u.n++;
    u.metal += cost;
    units.set(d.def[i], u);
    if (d.x[i] >= 0) out.pts.push([d.x[i], d.z[i]]);
    out.first = Math.min(out.first, d.f[i]);
    out.last = Math.max(out.last, d.f[i]);
  }
  out.units = [...units.values()].sort((a, b) => b.metal - a.metal || b.n - a.n);
  return out;
}

/** buildLines is what side built (Moment.built) and lost of the building
 * categories in cats around a moment, the lines a build-up story shows
 * under it. A loss is said only when it was more than a stray turret. */
function buildLines(ins: Insights, m: Moment, side: number, cats: ReadonlySet<string>): BuildLine[] {
  const out: BuildLine[] = [];
  const built = (m.built?.[side] ?? []).filter((u) => cats.has(ins.defs[String(u.def)]?.stand ?? ""));
  if (built.length) {
    out.push({
      verb: "built", label: `built since ${fmtClock((m.builtFrom ?? m.f0) / SIM_FPS)}`,
      n: built.reduce((a, u) => a + u.n, 0), metal: built.reduce((a, u) => a + u.metal, 0), units: built,
    });
  }
  const [w0, w1] = momentWindow(ins, m);
  const lost = buildingLosses(ins, side, w0, w1, cats);
  if (lost.n >= 3 || lost.metal >= QUIET_METAL) out.push({ verb: "lost", label: `lost since ${fmtClock(w0 / SIM_FPS)}`, n: lost.n, metal: lost.metal, units: lost.units });
  return out;
}

/** A share of a shift below this is not mentioned as what moved it. */
const DRIVER_MIN = 0.2;

/** builtNotFought says the model's own split (version 7) put less than
 * DRIVER_MIN of a moment's shift on army value: whatever was lost in the
 * window, the armies' balance hardly moved, so a fight there — however big
 * — is not what moved the line. An even trade of 5.9k for 5.5k metal is
 * exactly that, while the incomes pulled apart. */
function builtNotFought(m: Moment): boolean {
  return typeof m.army === "number" && typeof m.eco === "number" && m.army + m.eco + (m.build ?? 0) > 0 && m.army < DRIVER_MIN;
}

/** BAR's metal producers by name — mines and energy converters — the
 * metal half of insights defs.go ecoNameRE. Power plants feed converters
 * too, but a lost wind turbine is not what a fall in metal income is. */
const METAL_NAME = /^(arm|cor|leg)[a-z]*(mex|moho|makr|mmkr|mmm)/;

/** ecoLost is the metal producers side lost in [f0, f1], the most first. */
function ecoLost(ins: Insights, side: number, f0: number, f1: number): { n: number; metal: number; kinds: [string, number][] } {
  const wiped = wipedOf(ins);
  const sideOf = sideOfTeam(ins);
  const d = ins.deaths;
  const kinds = new Map<string, number>();
  let n = 0;
  let metal = 0;
  for (let i = 0; i < d.f.length; i++) {
    if (d.f[i] < f0 || d.f[i] > f1 || wiped(i) || sideOf.get(d.team[i]) !== side) continue;
    const def = ins.defs[d.def[i]];
    if (!def || !METAL_NAME.test(def.name)) continue;
    const name = def.human || def.name;
    kinds.set(name, (kinds.get(name) ?? 0) + 1);
    n++;
    metal += d.cost?.[i] ?? 0;
  }
  return { n, metal, kinds: [...kinds].sort((a, b) => b[1] - a[1]) };
}

interface Growth {
  title: string;
  detail: string;
  sides: SideGrowth[];
  /** Which of army value, income and buildings the story names as carrying
   * it. */
  named: { army: boolean; eco: boolean; build: boolean };
  armyDefences: boolean;
  lines: BuildLine[][] | null;
  /** The building categories the story is about (Def.stand). */
  cats: Set<string>;
}

/** growthStory tells a moment the line made on what the sides BUILT: by
 * whichever of army value, income and (version 10) buildings carried it
 * (each named only when it carried at least DRIVER_MIN of the shift), and
 * for income and buildings, whether the losing side's fell or the gaining
 * side's simply grew faster. A version 10 file also says WHAT was built:
 * the mines and power plants behind an economy, the buildings behind a
 * base, by def, as icons under each side (buildLines). */
export function growthStory(ins: Insights, m: Moment): Growth {
  const won = m.side;
  const lose = 1 - won;
  const W = sideName(ins, won);
  const L = sideName(ins, lose);
  const s = ins.series;
  const last = Math.max(0, s.t.length - 1);
  const step = (f: number) => Math.max(0, Math.min(last, Math.round(f / SIM_FPS / ins.stepSec) - 1));
  const i0 = step(m.f0);
  const i1 = step(m.f1);
  const pair = (xs: number[] | undefined): [number, number] => [xs?.[i0] ?? 0, xs?.[i1] ?? 0];
  // Income as the model reads it: averaged over the last minutes, and
  // summed over the game so far (insights swing.go SwingFeatures).
  const steps = incomeSteps(ins);
  const avg = (xs: number[] | undefined, i: number) => {
    const lo = Math.max(0, i - steps + 1);
    let sum = 0;
    for (let j = lo; j <= i; j++) sum += xs?.[j] ?? 0;
    return sum / (i - lo + 1);
  };
  const mined = (xs: number[] | undefined, i: number) => {
    let sum = 0;
    for (let j = 0; j <= i; j++) sum += (xs?.[j] ?? 0) * ins.stepSec;
    return sum;
  };
  const sides = ins.sides.map((_, sd) => {
    const inc = s.metalIncome?.[sd];
    const a = standing(ins, sd, i0);
    const b = standing(ins, sd, i1);
    return {
      army: pair(s.army[sd]), income: [avg(inc, i0), avg(inc, i1)] as [number, number], mined: [mined(inc, i0), mined(inc, i1)] as [number, number],
      buildings: [a.buildings, b.buildings] as [number, number], defences: [a.defences, b.defences] as [number, number],
    };
  });
  // What carried it: the file says (version 7); older ones are read from
  // whose army grew more.
  let army: boolean;
  let eco: boolean;
  let build = false;
  if (typeof m.army === "number" && typeof m.eco === "number" && m.army + m.eco + (m.build ?? 0) > 0) {
    army = m.army >= DRIVER_MIN;
    eco = m.eco >= DRIVER_MIN;
    build = (m.build ?? 0) >= DRIVER_MIN;
  } else {
    army = armyGrew(ins, m, won);
    eco = !army;
  }
  // The line reads standing defences with the army (version 10): where they
  // are a real part of it, the army's numbers carry them and say so — and
  // the title names them when they moved more than the armies did.
  const armyDefences = !!s.buildings && sides.some((g) => g.defences[1] >= DEFENCE_SHARE * (g.army[1] + g.defences[1]));
  const gain = (xs: [number, number]) => xs[1] - xs[0];
  const defGap = gain(sides[won].defences) - gain(sides[lose].defences);
  const defencesMoved = armyDefences && defGap > 0 && defGap >= 0.5 * Math.abs(gain(sides[won].army) - gain(sides[lose].army));
  if (armyDefences) for (const g of sides) g.army = [g.army[0] + g.defences[0], g.army[1] + g.defences[1]];
  const gw = sides[won];
  const gl = sides[lose];
  const dIncW = gw.income[1] - gw.income[0];
  const dIncL = gl.income[1] - gl.income[0];
  // The losing side's income FELL by more than the other's rose: the story
  // is what it lost, not what the other built. The same for its buildings.
  const incomeLost = dIncL < 0 && -dIncL >= Math.max(0, dIncW);
  const dBldW = gw.buildings[1] - gw.buildings[0];
  const dBldL = gl.buildings[1] - gl.buildings[0];
  const buildingsFell = dBldL < 0 && -dBldL >= Math.max(0, dBldW);
  // "Bigger" only when it is: a side still behind at the end caught up.
  // A base that SHRANK is said as that, whatever else moved: "Blue team
  // out-builds Red team in buildings" over a Red base going down is false.
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const armyWords = army ? (defencesMoved ? ["army", "defences"] : ["army"]) : [];
  let title: string;
  if (build && buildingsFell) {
    const also = list([...armyWords, eco && !incomeLost ? "economy" : ""].filter(Boolean));
    const shrank = eco && incomeLost ? `${possessive(L)} base and income shrink` : `${possessive(L)} base shrinks`;
    title = also ? `${shrank} while ${W} out-builds its ${also}` : shrank;
  } else if (army && eco && build) title = `${W} out-builds ${L} on every front`;
  else if (army && (eco || build)) title = `${W} out-builds ${L} in ${list([...armyWords, eco ? "economy" : "buildings"])}`;
  else if (eco && build) title = `${W} out-builds ${L} in economy and buildings`;
  else if (army) title = `${W} out-builds ${possessive(L)} ${list(armyWords)}`;
  else if (build) title = gw.buildings[1] > gl.buildings[1] ? `${W} builds up a bigger base` : `${possessive(W)} base catches up`;
  else title = incomeLost ? `${L} loses metal income` : gw.income[1] > gl.income[1] ? `${W} builds up a bigger economy` : `${possessive(W)} economy catches up`;
  const rate = (v: number) => `${fmtMetal(Math.round(v * 10) / 10)}/s`;
  const over = steps === 4 ? "the last minute" : `the last ${Math.round(steps * ins.stepSec / 60)} minutes`;
  const parts: string[] = [];
  if (eco) {
    parts.push(`Metal income over ${over}: ${W} ${rate(gw.income[0])} → ${rate(gw.income[1])}, ${L} ${rate(gl.income[0])} → ${rate(gl.income[1])}.`);
    parts.push(`Metal mined so far: ${W} ${fmtMetal(gw.mined[1])}, ${L} ${fmtMetal(gl.mined[1])}.`);
  }
  if (build) parts.push(`Buildings, defences aside: ${W} ${fmtMetal(gw.buildings[0])} → ${fmtMetal(gw.buildings[1])} metal, ${L} ${fmtMetal(gl.buildings[0])} → ${fmtMetal(gl.buildings[1])}.`);
  if (eco && incomeLost) {
    // Where it went, when that was the other side: the mines and
    // converters the losing side lost in the window.
    const [w0, w1] = momentWindow(ins, m);
    const eb = ecoLost(ins, lose, w0, w1);
    if (eb.n >= 1) parts.push(`${L} lost ${eb.n} metal producer${eb.n === 1 ? "" : "s"} (${fmtMetal(eb.metal)} metal): ${eb.kinds.slice(0, 4).map(([name, n]) => (n > 1 ? `${n} ${name}` : name)).join(", ")}.`);
  }
  const armyWord = armyDefences ? "Army and defences" : "Army";
  if (army) parts.push(`${armyWord}: ${W} ${fmtMetal(gw.army[0])} → ${fmtMetal(gw.army[1])} metal, ${L} ${fmtMetal(gl.army[0])} → ${fmtMetal(gl.army[1])}.`);
  else if (gl.army[1] - gl.army[0] > Math.max(0, gw.army[1] - gw.army[0])) {
    // The other side spent the stretch on its army instead: worth saying,
    // since the army chart shows it pulling ahead while the line went the
    // other way.
    parts.push(`${L} put more into its army: ${fmtMetal(gl.army[0])} → ${fmtMetal(gl.army[1])} metal, ${W} ${fmtMetal(gw.army[0])} → ${fmtMetal(gw.army[1])}.`);
  }
  // What was built behind it, and lost: an economy story its mines and
  // power, a buildings story every building but the defences, an army story
  // the defences when they count with it.
  const cats = new Set<string>();
  if (eco || build) cats.add("eco").add("mex");
  if (build) cats.add("other");
  if (army && armyDefences) cats.add("defence");
  const lines = cats.size && m.built ? ins.sides.map((_, sd) => buildLines(ins, m, sd, cats)) : null;
  for (const [sd, ls] of (lines ?? []).entries()) {
    for (const l of ls) parts.push(`${sideName(ins, sd)} ${l.label}: ${l.units.slice(0, 4).map((u) => `${u.n} ${defLabel(ins, u.def, u.n)}`).join(", ")}.`);
  }
  return { title, detail: parts.join(" "), sides, named: { army, eco, build }, armyDefences, lines: lines?.some((ls) => ls.length) ? lines : null, cats };
}

/** defLabel is a def's name for a count: "Wind Turbines" for 2. */
function defLabel(ins: Insights, def: number, n: number): string {
  const d = ins.defs[String(def)];
  const name = d?.human || d?.name || "unit";
  return n > 1 ? plural(name) : name;
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
 * middle", or what players call it on a map whose areas have names
 * ("Blue geo"; places.ts). */
export function compass(ins: Insights, x: number, z: number): string {
  return place(ins, x, z).name;
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
  const out = ins.sides.map(() => ({ n: 0, metal: 0, worth: 0, commanders: [] as string[], commanderDeaths: [] as number[], top: -1, topCost: -1, kinds: new Map<string, [number, number]>(), units: new Map<number, UnitLoss>(), sx: 0, sz: 0, w: 0 }));
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
    o.worth += cost * defWorth(def);
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
    worth: o.worth,
    commanders: o.commanders,
    commanderDeaths: o.commanderDeaths,
    top: o.top,
    kinds: [...o.kinds.entries()].map(([name, [n, metal]]) => [name, n, metal] as [string, number, number])
      .sort((a, b) => b[2] - a[2] || b[1] - a[1]),
    units: [...o.units.values()].sort((a, b) => b.metal - a.metal || b.n - a.n),
    at: o.w ? [o.sx / o.w, o.sz / o.w] : null,
  }));
}

/** deathSpan is the first and last frame of the deaths sideLosses counts
 * inside [f0, f1], or null when there are none. */
function deathSpan(ins: Insights, f0: number, f1: number): [number, number] | null {
  const wiped = wipedOf(ins);
  const sideOf = sideOfTeam(ins);
  const d = ins.deaths;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < d.f.length; i++) {
    if (d.f[i] < f0 || d.f[i] > f1 || wiped(i) || (sideOf.get(d.team[i]) ?? -1) < 0) continue;
    lo = Math.min(lo, d.f[i]);
    hi = Math.max(hi, d.f[i]);
  }
  return lo <= hi ? [lo, hi] : null;
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

function article(name: string): string {
  return /^[aeiou]/i.test(name) ? "an" : "a";
}

/** A side that loses at least BASE_SHARE of its standing buildings, and
 * BASE_MIN metal of them, over a moment — buildings at least BASE_PART of
 * everything it lost there — is told as losing its base (version 10): the
 * line reads buildings, and a base going up is what a viewer remembers. */
const BASE_SHARE = 0.15;
const BASE_MIN = 1000;
const BASE_PART = 0.5;
/** "Most of its base", and "mostly" one kind of building, from this share. */
const BASE_MOST = 0.6;
/** Building losses spread wider than this are told without a place. */
const BASE_SPREAD = 2500;

/** A side's base going up over a moment: the share of its standing
 * buildings lost, what kind most of it was, and where and when. */
export interface BaseLoss {
  share: number;
  mostly: string | null;
  loss: BuildingLoss;
  focus: Focus;
}

/** baseLoss is side's loss of buildings over [f0, f1] when it is a story
 * of its own (see BASE_SHARE), else null. all is everything side lost in
 * the window. */
export function baseLoss(ins: Insights, side: number, f0: number, f1: number, all: SideLoss): BaseLoss | null {
  const s = ins.series;
  if (!s.buildings) return null;
  const loss = buildingLosses(ins, side, f0, f1);
  if (loss.metal < BASE_MIN || loss.metal < BASE_PART * all.metal) return null;
  // The base it had going in.
  const i = Math.max(0, Math.min(s.t.length - 1, Math.round(f0 / SIM_FPS / ins.stepSec) - 1));
  const had = standing(ins, side, i);
  const total = had.defences + had.buildings;
  if (total <= 0 || loss.metal < BASE_SHARE * total) return null;
  const cat = (c: string) => loss.byCat.get(c) ?? 0;
  const most = BASE_MOST * loss.metal;
  const mostly = cat("defence") >= most ? "defences"
    : loss.factory >= most ? "factories"
    : cat("mex") >= most ? "metal extractors"
    : cat("eco") + cat("mex") >= most ? "its economy"
    : null;
  const at = spread(loss.pts);
  const focus: Focus = { f: loss.first, f1: loss.last, ...(at.r !== undefined && at.r <= BASE_SPREAD ? at : {}) };
  return { share: Math.min(1, loss.metal / total), mostly, loss, focus };
}

/** baseTitle says it: "Blue team loses 35% of its base in the west, mostly
 * its economy", "Blue team loses most of its base". Without the place and
 * the kind (short) it is a clause for another title. */
function baseTitle(ins: Insights, side: number, b: BaseLoss, short = false): string {
  const L = sideName(ins, side);
  const where = !short && typeof b.focus.x === "number" && typeof b.focus.z === "number" ? ` ${placeAt(ins, b.focus.x, b.focus.z)}` : "";
  if (b.share >= BASE_MOST) return `${L} loses most of its base${where}`;
  return `${L} loses ${Math.round(b.share * 100)}% of its base${where}${b.mostly && !short ? `, mostly ${b.mostly}` : ""}`;
}

/** quipFacts gathers what quips.ts may remark on about a moment (a
 * version 10 file: it needs Moment.built). */
function quipFacts(ins: Insights, m: Moment, kind: "growth" | "base", base: BaseLoss | null, cats: ReadonlySet<string>): QuipFacts | null {
  if (!m.built) return null;
  const won = m.side;
  const lose = 1 - won;
  const from = m.builtFrom ?? m.f0;
  const metal = (sd: number) => (m.built?.[sd] ?? []).reduce((a, u) => a + u.metal, 0);
  const first = (key: string, sd: number) => ins.milestones.find((x) => x.key === key && x.side === sd);
  const inWindow = (x: { f: number } | undefined) => !!x && x.f > from && x.f <= m.f1;
  const before = (x: { f: number } | undefined) => !!x && x.f <= m.f1;
  const [w0, w1] = momentWindow(ins, m);
  return {
    W: sideName(ins, won), L: sideName(ins, lose), n: m.n, kind,
    // Only what the story is about: a forest of wind turbines is no aside
    // to an army that out-built the other.
    built: (m.built[won] ?? []).map((u) => {
      const d = ins.defs[String(u.def)];
      return { name: d?.name ?? "", human: d?.human || d?.name || "unit", n: u.n, metal: u.metal, stand: d?.stand };
    }).filter((u) => cats.has(u.stand ?? "")),
    wonMetal: metal(won), loseMetal: metal(lose),
    baseShare: base?.share ?? 0,
    minesLost: kind === "base" || cats.has("mex") ? buildingLosses(ins, lose, w0, w1, new Set(["mex"])).n : 0,
    fusionFirst: cats.has("eco") && inWindow(first("fusion", won)) && !before(first("fusion", lose)),
    nukeNoAnti: inWindow(first("nuke", won)) && !before(first("antinuke", lose)),
  };
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
  const ll = lost[lose] ?? { n: 0, metal: 0, worth: 0, commanders: [], commanderDeaths: [], top: -1, kinds: [], units: [], at: null };
  const wl = lost[won] ?? { n: 0, metal: 0, worth: 0, commanders: [], commanderDeaths: [], top: -1, kinds: [], units: [], at: null };
  const size = (l: SideLoss) => (priced ? l.metal : l.n);
  // Who won is decided by worth: a lost power plant costs its output too.
  const worth = (l: SideLoss) => (priced ? l.worth : l.n);
  // Where it happened: the focus when it has a place (the commander's
  // death, the fight's busiest spot), else the centre of what was lost.
  const at = (f: Focus | null) => {
    if (f && typeof f.x === "number" && typeof f.z === "number") return ` ${placeAt(ins, f.x, f.z)}`;
    return ll.at ? ` ${placeAt(ins, ll.at[0], ll.at[1])}` : "";
  };

  // A player leaving takes their whole army off the board, which is the
  // shift whatever else happened in the window.
  // A player who HANDED their units to a teammate took nothing off the
  // board, so their leaving is said beside the story rather than as it.
  const gone = knockouts(ins).filter((k) => k.side === lose && k.f >= f0 && k.f <= f1);
  const out = gone.filter((k) => !k.handoff);
  const handed = gone.filter((k) => k.handoff);
  let title: string;
  let focus: Focus | null;
  // A fight's own losses, when it is told as one event (see below).
  let local: SideLoss[] | null = null;
  // What each side built, when the line moved on that rather than a fight.
  let growth: Growth | null = null;
  // An elimination or a quiet stretch has no battle of its own to credit.
  let fight = true;
  // The battle a shared moment told only part of.
  let whole: Battle | null = null;
  // A fight there that the line did not move on (see builtNotFought).
  let notFought = false;
  // A big loss of buildings: told as the loser's base going up, unless a
  // battle holds it (whose title then says so: phrases.ts) or the army fell
  // with it. A file without buildings (before version 10) has none.
  const base = baseLoss(ins, lose, f0, f1, ll);
  let raid: BaseLoss | null = null;
  // A fight the side the line moved toward LOST, while its army grew
  // anyway (see lostButBuilt): told as the build-up, the fight beside it.
  let lostFight: { won: SideLoss; lost: SideLoss; sides: SideLoss[]; focus: Focus | null; place: string } | null = null;
  // The base going up IS the moment when buildings moved the line more than
  // the armies did (version 10): told as that, whatever commander went with
  // it — unless one battle holds most of it, whose title then says what
  // happened there and who did it ("Red Stormbringers bomb the Blue base").
  const bf = base && (m.build ?? 0) > (m.army ?? 0) ? biggestFight(ins, f0, f1) : -1;
  const held = (i: number) => {
    const b = ins.battles[i];
    return buildingLosses(ins, lose, Math.max(b.f0, f0), Math.min(b.f1, f1), undefined, { x: b.x, z: b.z, r: b.r + BATTLE_REACH }).metal >= BASE_PART * base!.loss.metal;
  };
  const baseFirst = !!base && (m.build ?? 0) > (m.army ?? 0) && !(bf >= 0 && (ownBlast(ins.battles[bf]) === lose || held(bf)));
  if (out.length === 1) {
    fight = false;
    focus = eliminationFocus(ins, out[0].team, out[0].f);
    title = out[0].label;
  } else if (out.length > 1) {
    fight = false;
    focus = eliminationFocus(ins, out[0].team, out[0].f);
    title = `${out.length} of ${possessive(L)} players are out`;
  } else if (baseFirst && base) {
    // Who fought it is not one battle's question: no fighters, no badge.
    fight = false;
    raid = base;
    focus = base.focus;
    title = baseTitle(ins, lose, base);
    if (ll.commanders.length === 1) title += `, with ${possessive(ll.commanders[0])} commander`;
    else if (ll.commanders.length > 1) title += `, with ${ll.commanders.length} of its commanders`;
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
  } else if ((size(ll) < (priced ? QUIET_METAL : 3) && size(ll) <= size(wl) * 1.5) || (notFought = builtNotFought(m) && !base)) {
    // No real fight, or one that did not move the line: it moved on what
    // each side built.
    fight = false;
    focus = null;
    growth = growthStory(ins, m);
    title = growth.title;
  } else if (ll.kinds.length && priced && ll.kinds[0][1] === 1 && ll.kinds[0][2] >= SINGLE_SHARE * ll.metal && ll.kinds[0][2] >= 500) {
    focus = deathFocus(ins, ll.top);
    title = selfDestructed(ins, ll.top)
      ? `${L} self-destructs ${article(ll.kinds[0][0])} ${ll.kinds[0][0]}${at(focus)}`
      : `${L} loses ${article(ll.kinds[0][0])} ${ll.kinds[0][0]}${at(focus)}`;
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
    // No one battle holds it: the losses were spread over the map. The line
    // moves on the ARMY, so say how much of it went — a ten-second burst
    // somewhere is not what moved it — and watch the whole window.
    const drop = b ? null : armyDrop(ins, lose, f0, f1);
    raid = b || drop ? null : base;
    if (!b && !drop && !raid && focus) {
      // Still told as ONE event: the killing around the busiest burst's spot,
      // from its first death in the window to its last, and only that — the
      // clip watches that spot, so the sentence must count what it shows,
      // not every unit lost anywhere on the map in a window longer than it.
      const ev = burstEvent(ins, f0, f1, focus);
      if (ev) {
        focus = ev.focus;
        local = ev.local;
      }
    }
    let phrase: string | null = null;
    const lw = local ? local[won] : wl;
    const lo = local ? local[lose] : ll;
    // The line moved toward W, but W can still have lost more there (its
    // army was bigger, or what it lost mattered less): then the title states
    // the trade rather than calling it a win the numbers beside it deny.
    const unit = (v: number) => (priced ? `${fmtMetal(v)} metal` : `${v} units`);
    if (!drop && !raid && !(b && ownBlast(b) === lose) && priced && worth(lw) > worth(lo) && armyGrew(ins, m, won)) {
      // W lost the fight, so the fight cannot be why the line moved toward
      // it: W's army grew faster than L's despite it (the model reads army
      // value, which a lost fight lowers). Said as that, with the fight as
      // what it was — a fight L won (Marcin, f9c2cb6a's swing A).
      // Only the part of it inside the moment's window: that is what the
      // build-up story beside it covers (a long battle told whole would
      // count losses from minutes outside it).
      if (b && (b.f0 < f0 || b.f1 > f1) && Math.max(b.f0, f0) < Math.min(b.f1, f1)) {
        const p0 = Math.max(b.f0, f0), p1 = Math.min(b.f1, f1);
        const fp: Focus = { f: p0, f1: p1, x: b.x, z: b.z, r: b.r };
        const lp = sideLosses(ins, p0, p1, { x: b.x, z: b.z, r: b.r + BATTLE_REACH });
        lostFight = { won: lp[won], lost: lp[lose], sides: lp, focus: fp, place: at(fp) };
      } else lostFight = { won: lw, lost: lo, sides: local ?? lost, focus, place: at(focus) };
    }
    if (b && ownBlast(b) === lose) {
      // Its own blasts or allies' fire, not the other side, did most of it.
      title = ownBlastTitle(ins, b, lose);
    } else if (drop) {
      focus = { f: f0, f1 };
      title = `${L} loses ${Math.round(drop.share * 100)}% of its army${drop.mostly ? `, mostly ${drop.mostly}` : ""}`;
    } else if (raid) {
      // Spread over the map or not, ONE story: the base going up, from the
      // first building lost to the last.
      focus = raid.focus;
      title = baseTitle(ins, lose, raid);
    } else if (b && !whole && worth(lw) < worth(lo) && (phrase = battlePhrase(ins, b, won, at(focus).trim()))) {
      // The whole battle is this story, so what its numbers say happened
      // there is the title ("Blue Thunders level Ann's base").
      title = phrase;
    } else title = worth(lw) === 0 || worth(lo) >= 2 * worth(lw) ? `${W} wins the fight${at(focus)}`
      : worth(lw) <= worth(lo) ? `${W} wins a close fight${at(focus)}`
      : `${W} trades ${unit(size(lw))} for ${unit(size(lo))}${at(focus)}`;
  }
  // The base going up that the title tells, whose buildings are then shown
  // by def under the side that lost them.
  let told = raid;
  if (base && !baseFirst && (m.build ?? 0) > (m.army ?? 0) && (out.length || ll.commanders.length)) {
    // A player out or a commander down names the moment, but the line moved
    // on the base going with them: say that too.
    title += ` as ${baseTitle(ins, lose, base, true)}`;
    told = base;
  }
  if (lostFight) {
    fight = false;
    growth = growthStory(ins, m);
    // The fight's losses are said beside it; its buildings need no line too.
    growth.lines = growth.lines?.map((ls) => ls.filter((l) => l.verb === "built")) ?? null;
    // Despite, not because of: the fight it lost is half of what happened.
    title = `${growth.title} despite losing a fight${lostFight.place}`;
    local = null;
    whole = null;
    focus = null;
    notFought = true;
  }
  const dl = local ? local[lose] : ll;
  const dw = local ? local[won] : wl;
  // Losses are said only for a side that had some: "both lost nothing" is
  // not a story.
  const losses = (a: SideLoss, b: SideLoss) => [[L, a], [W, b]]
    .filter(([, l]) => (l as SideLoss).n > 0)
    .map(([name, l]) => `${name} lost ${lossText(l as SideLoss, priced)}`)
    .join("; ");
  const said = losses(dl, dw);
  // Fighting the line did not move on is said as what it was: a side note.
  const traded = notFought && priced && Math.max(size(ll), size(wl)) >= QUIET_METAL
    ? ` Meanwhile ${L} lost ${fmtMetal(ll.metal)} metal in fighting and ${W} ${fmtMetal(wl.metal)}, which did not tip the armies toward ${W}.`
    : said ? ` ${said}.` : "";
  const despite = lostFight ? ` ${lostFightNote(ins, lostFight, W, L)}` : traded;
  let detail = growth
    ? growth.detail + despite
    : local
      ? `There, ${fmtClock(focus!.f / SIM_FPS)}–${fmtClock((focus!.f1 ?? focus!.f) / SIM_FPS)}: ${said || "nothing was lost"}.`
      : said ? `${said}.` : "";
  if (handed.length) detail += ` Meanwhile ${handed.map((k) => k.label).join("; ")}.`;
  // Losses counted over the whole window are a span, and the clip marks
  // that span rather than one instant (an elimination, a commander's death)
  // in it: from the first death counted to the last.
  if (!local && !growth && said && focus && focus.f1 === undefined) {
    const span = deathSpan(ins, f0, f1);
    if (span && span[1] - span[0] >= SIM_FPS) focus = { ...focus, f: Math.min(focus.f, span[0]), f1: Math.max(focus.f, span[1]) };
  }
  if (!local && !growth) {
    // Losses counted over the whole window take in any own-blast chain in
    // it, which the battles list then leaves to this story: say it here.
    for (const b of ins.battles) {
      const side = ownBlast(b);
      if (side >= 0 && b.f0 <= f1 && b.f1 >= f0) detail += ` ${ownBlastTitle(ins, b, side)} at ${fmtClock(b.f0 / SIM_FPS)}.`;
    }
  }
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
  // A moment told on what was built despite a fight is not about that fight.
  const battle = notFought ? -1 : battleOfMoment(ins, focus, f0, f1);
  const fought = fight ? fighters(ins, ins.battles[battle]) : ins.sides.map(() => []);
  const facts = growth ? quipFacts(ins, m, "growth", null, growth.cats) : raid ? quipFacts(ins, m, "base", raid, new Set()) : null;
  const baseLines = !growth && told
    ? ins.sides.map((_, sd): BuildLine[] => (sd === lose ? [{
      verb: "lost", label: `buildings: ${told!.loss.n} lost · ${fmtMetal(told!.loss.metal)} metal`,
      n: told!.loss.n, metal: told!.loss.metal, units: told!.loss.units,
    }] : []))
    : null;
  return {
    title, detail, lost, shown: local ?? lost, elsewhere, whole, battle, focus, fighters: fought,
    growth: growth?.sides ?? null, growthNamed: growth?.named ?? null, armyDefences: growth?.armyDefences ?? false,
    buildLines: growth?.lines ?? baseLines, lostFight: lostFight?.sides ?? null, quip: facts ? quip(facts) : null,
  };
}

/** NOTABLE_SHARE is the part of a side's loss in a fight ONE unit must
 * carry, at NOTABLE_METAL or more, to be named on its own: an Epic Pulsar
 * that was a third of everything lost, not the costliest of 200 Goblins. */
const NOTABLE_SHARE = 0.3;
const NOTABLE_METAL = 3000;

/** notableLoss names the one unit that was a big part of a side's loss
 * ("a half-built Epic Pulsar, 7.4k metal"), or null when none stands out. */
export function notableLoss(ins: Insights, l: SideLoss): string | null {
  const k = l.kinds[0];
  if (!k || k[1] !== 1 || k[2] < NOTABLE_METAL || k[2] < NOTABLE_SHARE * l.metal) return null;
  const half = l.top >= 0 && ins.deaths.unfinished?.[l.top] === 1 ? "half-built " : "";
  return `${half ? "a" : article(k[0])} ${half}${k[0]} (${fmtMetal(k[2])} metal)`;
}

/** lostFightNote is the sentence beside a build-up story whose window held
 * a fight the gaining side lost. */
function lostFightNote(ins: Insights, f: { won: SideLoss; lost: SideLoss; focus: Focus | null; place: string }, W: string, L: string): string {
  const when = f.focus ? ` (${fmtClock(f.focus.f / SIM_FPS)}–${fmtClock((f.focus.f1 ?? f.focus.f) / SIM_FPS)})` : "";
  const big = notableLoss(ins, f.won);
  return `Meanwhile ${L} won the fight${f.place}${when}: ${W} lost ${fmtMetal(f.won.metal)} metal${big ? `, including ${big}` : ""}, ${L} ${fmtMetal(f.lost.metal)}.`;
}

/** momentStories tells every moment of a swing line. A battle that two or
 * more of them would each tell whole is told in parts instead: each moment
 * then covers only the stretch of it inside its own window. */
export function momentStories(ins: Insights, moments: Moment[]): MomentStory[] {
  return fewQuips(storiesOf(ins, moments));
}

/** fewQuips keeps the first QUIPS_MAX asides on a page, no two alike: one
 * is a surprise, one under every swing a tic. */
export function fewQuips(stories: MomentStory[]): MomentStory[] {
  const seen = new Set<string>();
  return stories.map((st) => {
    if (!st.quip) return st;
    if (seen.size >= QUIPS_MAX || seen.has(st.quip.key)) return { ...st, quip: null };
    seen.add(st.quip.key);
    return st;
  });
}

function storiesOf(ins: Insights, moments: Moment[]): MomentStory[] {
  const first = moments.map((m) => momentStory(ins, m));
  const told = new Map<number, number>();
  for (const st of first) {
    if (st.battle >= 0 && st.focus?.f1 !== undefined) told.set(st.battle, (told.get(st.battle) ?? 0) + 1);
  }
  const shared = new Set([...told].filter(([, n]) => n > 1).map(([b]) => b));
  // A battle told whole must not run over ANOTHER moment's event either: a
  // long merged fight told whole by one swing took in the bombing run the
  // next swing was about, and the two split that one event between them
  // (a63ccb6a: a ground fight from 30:20 "held" until 38:06, through the
  // 36:00 bombing that the next swing told). It is told in part instead.
  first.forEach((st, k) => {
    const b = st.battle >= 0 && st.focus?.f1 !== undefined && !st.whole ? ins.battles[st.battle] : undefined;
    if (!b || shared.has(st.battle)) return;
    const overlaps = first.some((o, j) => {
      if (j === k || o.battle === st.battle) return false;
      const [g0, g1] = o.focus ? [o.focus.f, o.focus.f1 ?? o.focus.f] : [moments[j].f0, moments[j].f1];
      return g0 < b.f1 && g1 > b.f0;
    });
    if (overlaps) shared.add(st.battle);
  });
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

/** burstEvent grows a burst into the event it belongs to: every death in
 * [f0, f1] within BURST_RADIUS of the burst's centre, spanning its first to
 * its last, with what each side lost there. Null without a place. */
function burstEvent(ins: Insights, f0: number, f1: number, burst: Focus): { focus: Focus; local: SideLoss[] } | null {
  if (typeof burst.x !== "number" || typeof burst.z !== "number") return null;
  const d = ins.deaths;
  const wiped = wipedOf(ins);
  const pts: [number, number][] = [];
  let a = Infinity;
  let e = -Infinity;
  for (let i = 0; i < d.f.length; i++) {
    if (d.f[i] < f0 || d.f[i] > f1 || d.x[i] < 0 || wiped(i)) continue;
    if (Math.hypot(d.x[i] - burst.x, d.z[i] - burst.z) > BURST_RADIUS) continue;
    pts.push([d.x[i], d.z[i]]);
    a = Math.min(a, d.f[i]);
    e = Math.max(e, d.f[i]);
  }
  if (!pts.length) return null;
  const local = sideLosses(ins, a, e, { x: burst.x, z: burst.z, r: BURST_RADIUS });
  return { focus: { f: a, f1: e, ...spread(pts) }, local };
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
  /** "decisive" when the other side lost twice as much or more; "blast"
   * when most of what the loser lost there was its own side's doing. */
  verdict: "decisive" | "win" | "even" | "blast";
  /** The title of a "blast" battle (ownBlastTitle). */
  blast?: string;
  /** What the list says happened: the blast, a battle phrase when one is
   * sure (phrases.ts battlePhrase), else the margin's words. */
  title: string;
}

/** A side's losses in a battle are its own doing when its own side
 * destroyed at least this share of them... */
const OWN_SHARE = 0.5;
/** ...and at least this much metal. */
const OWN_MIN = 1000;

/** ownBlast is the side of a battle whose losses were mostly its own side's
 * doing — a chain of power plants going up, an ally shelling it — or -1. A
 * battle like that is not won by the other side, whatever it lost. */
export function ownBlast(b: Battle | undefined): number {
  if (!b) return -1;
  let best = -1;
  b.lost.forEach((l, s) => {
    const own = l?.own ?? 0;
    if (own >= OWN_MIN && own >= OWN_SHARE * l.metal && (best < 0 || own > (b.lost[best].own ?? 0))) best = s;
  });
  return best;
}

/** ownBlastTitle says what blew up and, when an enemy's kill set it off,
 * whose: "Blue Advanced Fusion Reactors blow up, set off by
 * [MANTA]'s Basilica". Losses to allies' fire rather than to blasts read
 * "Blue team loses 18.9k metal to its own side's fire". */
export function ownBlastTitle(ins: Insights, b: Battle, side: number): string {
  const l = b.lost[side];
  const S = sideName(ins, side);
  const def = l.ownDef !== undefined ? ins.defs[String(l.ownDef)] : undefined;
  const name = def?.human || def?.name;
  const n = l.units?.find((u) => u.def === l.ownDef)?.n ?? 0;
  let title = def?.power && name
    ? `${sideShort(ins, side)} ${n > 1 ? plural(name) : name} ${n > 1 ? "blow" : "blows"} up`
    : `${S} loses ${fmtMetal(l.own ?? 0)} metal to its own side's fire`;
  if (l.trigger) {
    const who = ins.teams.find((t) => t.team === l.trigger![0])?.player || `Team ${l.trigger[0]}`;
    const td = ins.defs[String(l.trigger[1])];
    title += `, set off by ${possessive(who)} ${td?.human || td?.name || "unit"}`;
  }
  return title;
}


/** A stretch of the game this long with nothing in the swing list is a gap
 * worth filling: a sixth of the game, at least four minutes. */
const GAP_SHARE = 1 / 8;
const GAP_MIN_SEC = 240;
/** A filler stays this far from every entry already listed. */
const GAP_APART_SEC = 90;
/** A battle under this share of the game's biggest is not worth a line. */
const GAP_BATTLE_SHARE = 0.1;
/** ...nor one where neither side lost this much metal. */
const GAP_MIN_METAL = 1000;
/** The swing list holds at most this many entries in all. */
const LIST_MAX = 20;
/** A battle is a story of its own, wherever in the game, when it was over
 * quickly (STORY_MAX_SEC) and what went down there was a real share of the
 * war: both sides' losses together at least STORY_SHARE of both armies'
 * value as it started, and the side that lost more lost STORY_MIN_METAL.
 * A raid, a bombing run, an air battle — the line may barely move on one
 * (the game was already far over, or the army it hit was rebuilt), but a
 * person watching the game remembers them. A grinding front of several
 * minutes is not one event; the swings tell those. */
const STORY_SHARE = 0.15;
const STORY_MAX_SEC = 120;
const STORY_MIN_METAL = 1000;
/** The opening share of the game the swing line lists nothing from (Go's
 * earlyShare): there the list tells only battles one side clearly won. */
export const EARLY_SHARE = 0.3;
/** An opening battle is told when its loser lost at least EARLY_MARGIN
 * times what the winner did, and at least EARLY_MIN_METAL metal that was
 * also EARLY_MIN_ARMY of its army at the time (EARLY_MIN_UNITS units when
 * the capture prices nothing) — a skirmish over two scouts is not one. */
const EARLY_MARGIN = 3;
const EARLY_MIN_METAL = 1000;
const EARLY_MIN_ARMY = 0.2;
const EARLY_MIN_UNITS = 10;
/** At most this many opening battles are told. */
const EARLY_MAX = 4;

/** gapBattles picks battles to tell between the swings, where the list
 * would otherwise skip a long stretch of the game: the swing line only
 * lists its biggest shifts, and a fight can decide a lot without being one
 * of them (the line was already far over, or two fights cancelled out).
 * Greedily, the biggest battle in the widest gap goes in, until no gap is
 * wider than GAP_SHARE of the game or none holds a battle worth telling.
 * A battle a swing already tells, or one overlapping a swing's window, is
 * left out. Before any of that, every STORY battle goes in (storyBattle),
 * so the fights a game is remembered by are listed whatever the line did.
 * The opening EARLY_SHARE of the game, where the line lists no swings,
 * also tells its DECISIVE battles (earlyBattle), however small next to the
 * game's biggest, and nothing else from there fills a gap. Ordered by
 * time. */
export function gapBattles(ins: Insights, moments: Moment[], stories: MomentStory[]): GapBattle[] {
  const sw = ins.swing;
  if (!sw || !ins.battles.length) return [];
  const priced = ins.costCoverage === "full" || ins.battles.some((b) => b.lost.some((l) => l.metal > 0));
  // Battles are judged by worth: a lost power plant costs its output too.
  const size = (l?: { n: number; metal: number; worth?: number }) => (l ? (priced ? lossWorth(l) : l.n) : 0);
  const total = (b: Battle) => size(b.lost[0]) + size(b.lost[1]);
  // The floors below are plain METAL, like every number the page shows:
  // judged by worth, 440 metal of wind turbines cleared a 1000-metal floor
  // and read "decisively wins" over a 300-metal skirmish.
  const metal = (l?: { metal: number }) => l?.metal ?? 0;
  const biggest = Math.max(...ins.battles.map(total));
  const told = new Set(stories.map((st) => st.battle).filter((b) => b >= 0));
  const gap = Math.max(GAP_MIN_SEC, ins.durationSec * GAP_SHARE) * SIM_FPS;
  const apart = GAP_APART_SEC * SIM_FPS;
  const end = ins.durationSec * SIM_FPS;
  // Where each entry sits on the time axis: a swing at the end of its
  // window (where its dot is), a battle at its end.
  const marks = moments.map((m) => m.f1);
  const opening = EARLY_SHARE * end;
  const army = ins.series.army;
  const armyAt = (side: number, f: number) => {
    const a = army[side] ?? [];
    return a[Math.max(0, Math.min(a.length - 1, Math.floor(f / SIM_FPS / ins.stepSec)))] ?? 0;
  };
  // A battle in the opening one side clearly won, with real losses.
  const earlyBattle = (b: Battle) => {
    const [a, c] = [size(b.lost[0]), size(b.lost[1])];
    const loser = a > c ? 0 : 1;
    const hi = Math.max(a, c);
    if (hi < EARLY_MARGIN * Math.min(a, c)) return false;
    if (!priced) return hi >= EARLY_MIN_UNITS;
    const m = metal(b.lost[loser]);
    return m >= EARLY_MIN_METAL && m >= EARLY_MIN_ARMY * armyAt(loser, b.f0);
  };
  const picked: number[] = [];
  // A story battle: short, and costly next to both armies.
  const storyBattle = (b: Battle) => {
    if (!priced || b.f1 - b.f0 > STORY_MAX_SEC * SIM_FPS) return false;
    const [a, c] = [metal(b.lost[0]), metal(b.lost[1])];
    return Math.max(a, c) >= STORY_MIN_METAL && a + c >= STORY_SHARE * Math.max(1, armyAt(0, b.f0) + armyAt(1, b.f0));
  };
  // Two battles at the same time and place are one story; at the same time
  // on opposite ends of the map they are two (two bombing runs at once).
  const samePlace = (i: number, j: number) => {
    const [x, y] = [ins.battles[i], ins.battles[j]];
    return Math.abs(x.f1 - y.f1) < apart && Math.hypot(x.x - y.x, x.z - y.z) < x.r + y.r;
  };
  // A swing told over its whole window (a commander's death, an
  // elimination, one big loss) counts every death in it, so a battle inside
  // that window is already in its story; one told as a fight in one place
  // covers the battles there. One told on what was built covers none.
  const windows = moments.map((m, k) => ({ w: momentWindow(ins, m), st: stories[k] })).filter(({ st }) => st && !st.growth);
  const covered = (b: Battle) => windows.some(({ w, st }) => b.f0 <= w[1] && b.f1 >= w[0]
    && (st.shown === st.lost || !st.focus || typeof st.focus.x !== "number"
      || Math.hypot(b.x - st.focus.x, b.z - (st.focus.z ?? 0)) < b.r + (st.focus.r ?? 0) + BATTLE_REACH));
  const storied = ins.battles.map((_, i) => i)
    .filter((i) => !told.has(i) && storyBattle(ins.battles[i]) && !covered(ins.battles[i]))
    .sort((x, y) => total(ins.battles[y]) - total(ins.battles[x]));
  for (const i of storied) {
    if (marks.length >= LIST_MAX || picked.some((j) => samePlace(i, j))) continue;
    picked.push(i);
    marks.push(ins.battles[i].f1);
  }
  const early = ins.battles.map((_, i) => i)
    .filter((i) => ins.battles[i].f0 < opening && !told.has(i) && earlyBattle(ins.battles[i]))
    .sort((x, y) => total(ins.battles[y]) - total(ins.battles[x]));
  let nEarly = 0;
  for (const i of early) {
    const f = ins.battles[i].f1;
    if (picked.includes(i) || nEarly >= EARLY_MAX || marks.length >= LIST_MAX || marks.some((m) => Math.abs(m - f) < apart)) continue;
    picked.push(i);
    marks.push(f);
    nEarly++;
  }
  const free = ins.battles.map((_, i) => i).filter((i) => {
    const b = ins.battles[i];
    return !told.has(i) && b.f0 >= opening && total(b) > 0 && total(b) >= GAP_BATTLE_SHARE * biggest
      && (!priced || Math.max(metal(b.lost[0]), metal(b.lost[1])) >= GAP_MIN_METAL)
      && !moments.some((m) => b.f0 <= m.f1 && b.f1 >= m.f0);
  });
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
    const blast = ownBlast(b);
    const verdict = blast >= 0 && blast !== side ? "blast" as const
      : side < 0 ? "even" as const : lo === 0 || hi >= 2 * lo ? "decisive" as const : "win" as const;
    const move = pAt(b.f1 / SIM_FPS + ins.stepSec) - pAt(b.f0 / SIM_FPS);
    const where = battleWhere(ins, b);
    const title = verdict === "blast" ? ownBlastTitle(ins, b, blast)
      : (side >= 0 && battlePhrase(ins, b, side, where)) || marginPhrase(ins, b, i, side, verdict === "decisive", where, priced);
    return { battle: i, side, delta: side === 1 ? -move : move, verdict, title, ...(verdict === "blast" ? { blast: title } : {}) };
  });
}
