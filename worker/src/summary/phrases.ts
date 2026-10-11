// Battle phrases: what a battle's title says happened, in the words a
// caster would use — "Blue Thunders level Ann's base", "Red defences hold
// off a Blue attack" — rather than "Blue team wins battle" every time.
//
// Every phrase is a claim about what happened, so each fires only when the
// numbers plainly say it: who did the killing (Battle.lost[].by, version 8,
// a capture that names killers), what kind of unit each one was (Def.class)
// and what was lost. When no rule is sure, the margin words close the list,
// which need only what every battle records.
import { fmtMetal } from "./format";
import { lossWorth, sideShort } from "./model";
import { at, place } from "./places";
import type { Battle, Insights, UnitKill, UnitLoss } from "./types";

/** "Mostly": a share of the metal at least this big. */
const MOSTLY = 0.6;
/** A def that did at least this share of a class's killing names it. */
const NAMES = 0.5;
/** Killer-based phrases need the killers of at least this share of the
 * losses to be known: a battle whose losses are mostly blasts and
 * unattributed deaths says nothing about who won it. */
const CREDITED = 0.6;
/** One player took at least this share of a side's losses: name them. */
const ONE_PLAYER = 0.7;
/** Losses under this are a skirmish whatever killed them. */
const PHRASE_MIN_METAL = 1000;
/** A bombing run that took this much of buildings flattens a base. */
const LEVEL_METAL = 20000;
/** A lost factory of at least FACTORY_COST metal that was FACTORY_SHARE of
 * the loss names the battle. */
const FACTORY_COST = 1000;
const FACTORY_SHARE = 0.25;
/** A side's units of one def cheaper than this, at least SWARM_UNITS of
 * them doing most of the killing, are a swarm. */
const SWARM_COST = 60;
const SWARM_UNITS = 30;
/** Losses of one side's economy this big cripple it. */
const CRIPPLE_METAL = 10000;
/** A side that lost this many times the other's losses, and WIPE_ARMY of
 * its army there, was crushed. */
const WIPE_MARGIN = 10;
const WIPE_ARMY = 0.3;
/** An even battle in which both sides lost this share of their army is a
 * bloodbath, not a skirmish. */
const BLOODY_ARMY = 0.15;
/** How big a fight is, by the metal the side that lost more lost there —
 * the words scale with it, not only with the margin: a 2.8k-for-600 kill is
 * a nice skirmish, not Blue "overwhelming" anyone (Marcin's call). Under
 * FIGHT_METAL a battle is a skirmish whatever the margin; strong verbs
 * (overwhelms, smashes, crushes, a bloody stalemate) need BIG_METAL. */
const FIGHT_METAL = 5000;
const BIG_METAL = 20000;

const AIR = new Set(["bomber", "fighter", "gunship", "air"]);
const STRUCTURE = new Set(["defence", "lrgun", "nuke", "factory", "eco", "building"]);
const MOBILE = new Set(["army", "experimental", "ship", "commander", "unit", ...AIR]);


export function plural(name: string): string {
  return /(s|x|ch|sh)$/.test(name) ? name + "es" : /[^aeiou]y$/.test(name) ? name.slice(0, -1) + "ies" : name + "s";
}

function cls(ins: Insights, def: number): string {
  return ins.defs[String(def)]?.class ?? "";
}

function unitName(ins: Insights, def: number, n: number): string {
  const d = ins.defs[String(def)];
  const name = d?.human || d?.name || "unit";
  return n > 1 ? plural(name) : name;
}

/** share sums the metal of the entries whose class is in set, over total. */
function share(ins: Insights, list: (UnitLoss | UnitKill)[] | undefined, set: Set<string>, total: number): number {
  if (!list || total <= 0) return 0;
  return list.reduce((a, u) => a + (set.has(cls(ins, u.def)) ? u.metal : 0), 0) / total;
}

/** byDef sums kills by def (a def fielded by two teams of a side is one). */
function byDef(by: UnitKill[]): { def: number; metal: number; n: number; units: number }[] {
  const m = new Map<number, { def: number; metal: number; n: number; units: number }>();
  for (const k of by) {
    const e = m.get(k.def) ?? { def: k.def, metal: 0, n: 0, units: 0 };
    e.metal += k.metal;
    e.n += k.n;
    e.units += k.units;
    m.set(k.def, e);
  }
  return [...m.values()].sort((a, b) => b.metal - a.metal);
}

/** battlePhrase titles a battle side `won` came out ahead in, or returns
 * null when no rule is sure of anything more than the margin. `where` is the
 * place phrase ("in the north"). */
export function battlePhrase(ins: Insights, b: Battle, won: number, where: string): string | null {
  const lose = 1 - won;
  const L = b.lost[lose];
  const Wl = b.lost[won];
  if (!L || !Wl || L.metal < PHRASE_MIN_METAL || lossWorth(Wl) >= lossWorth(L)) return null;
  const by = L.by ?? [];
  const credited = by.reduce((a, k) => a + k.metal, 0);
  const W = sideShort(ins, won);
  const Ls = sideShort(ins, lose);
  const units = L.units ?? [];
  const lost = (set: Set<string>) => share(ins, units, set, L.metal);
  const killed = (set: Set<string>) => share(ins, by, set, credited);
  const defs = byDef(by);
  // The units of one class that did the killing, by name when one def did
  // most of it ("Thunders"), else by the class's word ("bombers").
  // The verb after it agrees: "Blue Pulsar holds", "Blue Pulsars hold".
  const named = (set: Set<string>, word: string): [string, boolean] => {
    const of = defs.filter((d) => set.has(cls(ins, d.def)));
    const sum = of.reduce((a, d) => a + d.metal, 0);
    const top = of[0];
    return top && top.metal >= NAMES * sum ? [unitName(ins, top.def, top.units), top.units > 1] : [word, true];
  };
  const verb = (many: boolean, v: string) => (many ? v : /(s|sh|ch|x)$/.test(v) ? v + "es" : v + "s");
  const say = (set: Set<string>, word: string, v: string, rest: string) => {
    const [n, many] = named(set, word);
    const [head, ...tail] = v.split(" ");
    return `${W} ${n} ${[verb(many, head), ...tail].join(" ")} ${rest}`;
  };
  // Whose loss it was: one player's, when one took most of it.
  const victim = (() => {
    const ts = (b.teams ?? []).filter((t) => ins.teams.find((x) => x.team === t.team)?.side === lose);
    const top = ts.sort((x, y) => y.lost - x.lost)[0];
    const player = top && top.lost >= ONE_PLAYER * L.metal ? ins.teams.find((x) => x.team === top.team)?.player : undefined;
    return player || null;
  })();
  const possessive = (n: string) => (n.endsWith("s") ? `${n}'` : `${n}'s`);
  const spot = place(ins, b.x, b.z);
  const base = victim ? `${possessive(victim)} base` : spot.side === lose ? `${possessive(spot.name)} base` : `the ${Ls} base ${where}`;
  const buildings = lost(STRUCTURE) >= MOSTLY;
  const army = lost(MOBILE) >= MOSTLY;

  // What the losing side lost was mostly its own bombers: a bombing run
  // that failed, whoever shot it down — a claim about the losses alone, so
  // it needs no killers beyond knowing fighters when it names them.
  if (lost(new Set(["bomber"])) >= MOSTLY) {
    const bombers = (() => {
      const top = [...units].filter((u) => cls(ins, u.def) === "bomber").sort((a, c) => c.metal - a.metal)[0];
      return top ? unitName(ins, top.def, 2) : "bombers";
    })();
    if (credited >= CREDITED * L.metal && killed(new Set(["fighter"])) >= MOSTLY) return say(new Set(["fighter"]), "fighters", "intercept", `the ${Ls} ${bombers}`);
    return `${Ls} ${bombers} are shot down ${where}`;
  }
  if (credited >= CREDITED * L.metal) {
    if (killed(new Set(["nuke"])) >= MOSTLY) return `A ${W} nuke ${L.metal >= LEVEL_METAL / 4 ? "flattens" : "hits"} ${buildings ? base : `the ${Ls} army ${where}`}`;
    if (killed(new Set(["lrgun"])) >= MOSTLY) return say(new Set(["lrgun"]), "long-range guns", "shell", `${buildings ? base : `the ${Ls} army ${where}`} from afar`);
    if (killed(new Set(["bomber"])) >= MOSTLY) {
      if (buildings) return say(new Set(["bomber"]), "bombers", L.metal >= LEVEL_METAL ? "level" : "bomb", base);
      return say(new Set(["bomber"]), "bombers", "bomb", `the ${Ls} army ${where}`);
    }
    if (lost(AIR) >= MOSTLY && Wl.metal > 0 && share(ins, Wl.units, AIR, Wl.metal) >= MOSTLY) {
      return killed(new Set(["fighter"])) >= MOSTLY
        ? say(new Set(["fighter"]), "fighters", "win the skies", where.replace(/^(in|at|on) /, "over "))
        : `${W} wins the air battle ${where.replace(/^(in|at|on) /, "over ")}`;
    }
    if (killed(new Set(["gunship"])) >= MOSTLY) return say(new Set(["gunship"]), "gunships", "tear through", buildings ? base : `the ${Ls} army ${where}`);
    const top = defs[0];
    if (top && cls(ins, top.def) === "experimental" && top.metal >= NAMES * credited) {
      const X = unitName(ins, top.def, top.units);
      const many = top.units > 1;
      if (buildings) return `${W} ${X} ${verb(many, "crush")} ${lost(new Set(["defence"])) >= 0.4 ? `the ${Ls} defences ${where}` : base}`;
      return `${W} ${X} ${verb(many, "stomp")} through the ${Ls} army ${where}`;
    }
    if (lost(new Set(["ship"])) >= MOSTLY && killed(new Set(["ship"])) >= MOSTLY) return say(new Set(["ship"]), "ships", "sink", `the ${Ls} fleet ${where}`);
    // Defences HOLD only when the attack plainly failed.
    if (army && killed(new Set(["defence"])) >= MOSTLY && 3 * lossWorth(Wl) <= 2 * lossWorth(L)) return say(new Set(["defence"]), "defences", "hold off", `a ${Ls} attack ${where}`);
    if (top && (ins.defs[String(top.def)]?.cost ?? Infinity) < SWARM_COST && top.units >= SWARM_UNITS && top.metal >= MOSTLY * credited) {
      return L.metal >= BIG_METAL
        ? `A swarm of ${W} ${unitName(ins, top.def, 2)} overwhelms ${Ls} ${where}`
        : `${W} ${unitName(ins, top.def, 2)} swarm ${Ls} ${where}`;
    }
    if (lost(new Set(["eco"])) >= MOSTLY && 3 * Wl.metal <= L.metal) {
      const eco = victim ? `${possessive(victim)} economy` : `the ${Ls} economy`;
      return `${W} ${L.metal >= CRIPPLE_METAL ? "cripples" : "raids"} ${eco} ${where}`;
    }
  }
  // A lost factory is the title when it was a real part of the loss — in a
  // war of a million metal a lab is a footnote.
  const fac = units.filter((u) => cls(ins, u.def) === "factory" && u.metal / Math.max(1, u.n) >= FACTORY_COST).sort((a, c) => c.metal - a.metal)[0];
  if (fac && fac.metal >= FACTORY_SHARE * L.metal) {
    const what = unitName(ins, fac.def, fac.n);
    return `${W} destroys ${victim ? `${possessive(victim)} ${what}` : fac.n > 1 ? `${Ls} ${what}` : `a ${Ls} ${what}`} ${where}`;
  }
  return null;
}

/** marginPhrase titles a battle on the margin alone — what every battle
 * records — rotating its words by the battle's number so a page reads the
 * same on every load. side is the side that lost less, -1 for an even
 * trade; decisive when the other side lost twice as much or more. */
export function marginPhrase(ins: Insights, b: Battle, index: number, side: number, decisive: boolean, where: string, priced: boolean): string {
  const armyAt = (s: number) => {
    const a = ins.series.army[s] ?? [];
    return a[Math.max(0, Math.min(a.length - 1, Math.floor(b.f0 / 30 / ins.stepSec)))] ?? 0;
  };
  if (side < 0) {
    const bloody = priced && [0, 1].every((s) => (b.lost[s]?.metal ?? 0) >= Math.max(BIG_METAL / 2, BLOODY_ARMY * Math.max(1, armyAt(s))));
    if (bloody) {
      const each = ((b.lost[0]?.metal ?? 0) + (b.lost[1]?.metal ?? 0)) / 2;
      return `Bloody stalemate ${where}: both sides lose ~${fmtMetal(each)} metal`;
    }
    return index % 2 ? `Skirmish ${where}, neither side gains` : `Even trade ${where}`;
  }
  const W = sideShort(ins, side);
  const Ls = sideShort(ins, 1 - side);
  const lw = b.lost[side];
  const ll = b.lost[1 - side];
  const lsize = priced ? lossWorth(ll) : ll?.n ?? 0;
  const wsize = priced ? lossWorth(lw) : lw?.n ?? 0;
  // Without prices there is no size to go by: the middle words.
  const metal = priced ? ll?.metal ?? 0 : FIGHT_METAL;
  if (lsize >= WIPE_MARGIN * Math.max(wsize, 1e-9) && priced && metal >= BIG_METAL / 2 && metal >= WIPE_ARMY * Math.max(1, armyAt(1 - side))) {
    return share(ins, ll?.units, MOBILE, ll?.metal ?? 0) >= MOSTLY && index % 2
      ? `${Ls} army is wiped out ${where}`
      : `${W} crushes ${Ls} ${where}`;
  }
  if (metal < FIGHT_METAL) {
    const words = decisive
      ? [`${W} wins a skirmish ${where}`, `${W} picks off ${Ls} units ${where}`, `${W} takes a clean fight ${where}`]
      : [`${W} edges out ${Ls} ${where}`, `${W} narrowly wins a skirmish ${where}`, `${W} comes out ahead ${where}`];
    return words[index % words.length];
  }
  if (decisive) {
    const words = metal >= BIG_METAL
      ? [`${W} overwhelms ${Ls} ${where}`, `${W} smashes ${Ls} ${where}`, `${W} decisively wins ${where}`, `${W} outfights ${Ls} ${where}`]
      : [`${W} decisively wins ${where}`, `${W} outfights ${Ls} ${where}`, `${W} beats ${Ls} ${where}`];
    return words[index % words.length];
  }
  const words = [`${W} edges out ${Ls} ${where}`, `${W} narrowly wins ${where}`, `${W} comes out ahead ${where}`];
  return words[index % words.length];
}

/** battleWhere names a battle's place for a title: "in the north-west",
 * "at Blue geo". */
export function battleWhere(ins: Insights, b: Battle): string {
  return at(ins, b.x, b.z);
}
