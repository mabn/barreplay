// Asides: now and then a swing's story gets a line of colour under its
// title — "41 Wind Turbines: Blue is betting the game on the weather"
// — about what a side built or lost. Each one fires only on a fact plain
// in the file (Moment.built, the milestones, a base going up), rotates its
// words by the moment's number so a page reads the same on every load, and
// a page carries at most QUIPS_MAX of them, no two of a kind
// (moments.ts fewQuips): one is a surprise, one under every swing a tic.
// Pure, so the node tests pin the rules.
import { fmtMetal } from "./format";
import { plural } from "./phrases";

/** The most asides one page carries. */
export const QUIPS_MAX = 2;

/** What a quip may remark on, gathered by moments.ts quipFacts. */
export interface QuipFacts {
  /** The side the line moved toward, and the other, by name. */
  W: string;
  L: string;
  /** The moment's number: which words a rule uses. */
  n: number;
  /** A build-up story, or a base going up. */
  kind: "growth" | "base";
  /** What W finished in the moment's build-up window, by def. */
  built: { name: string; human: string; n: number; metal: number; stand?: string }[];
  /** The metal of what each side finished in the window. */
  wonMetal: number;
  loseMetal: number;
  /** For a base going up, the share of L's base lost. */
  baseShare: number;
  /** Metal extractors L lost around the moment, when the story is about
   * them (an economy, a base). */
  minesLost: number;
  /** W's first fusion came in the window, and L has none. */
  fusionFirst: boolean;
  /** W's first nuke silo came in the window, and L has no anti-nuke. */
  nukeNoAnti: boolean;
}

export interface Quip {
  /** Which rule fired: a page says each at most once. */
  key: string;
  text: string;
}

/** BAR's wind turbines (not the advanced ones: a forest needs trees). */
const WIND = /^(arm|cor|leg)win(_scav)?$/;
/** Energy converters, the metal makers. */
const CONVERTER = /^(arm|cor|leg)[a-z0-9]*(makr|mmkr|mmm|fmkr|conv)/;
/** Walls: dragon's teeth and fortification walls. */
const WALL = /^(arm|cor|leg)[a-z]*(drag|fort|forti)(_scav)?$/;

/** At least this many wind turbines in one build-up are a forest. */
const WIND_MIN = 15;
/** ...converters, a conversion plant. */
const CONVERTER_MIN = 6;
/** ...of one defence, digging in. */
const DIG_MIN = 8;
/** ...wall pieces, a wall. */
const WALL_MIN = 20;
/** One building this costly is all eggs in one basket. */
const EPIC_METAL = 20000;
/** A side that built at least IDLE_MIN metal while the other built under
 * IDLE_SHARE of that left the other's builders idle. */
const IDLE_MIN = 2000;
const IDLE_SHARE = 0.1;
/** Extractors lost before the mines "go quiet". */
const MINES_MIN = 3;

function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/** quip is the aside a moment earns, the first rule that fires, or null. */
export function quip(f: QuipFacts): Quip | null {
  const { W, L } = f;
  const say = (key: string, words: string[]): Quip => ({ key, text: words[f.n % words.length] });
  const count = (re: RegExp) => f.built.filter((u) => re.test(u.name)).reduce((a, u) => a + u.n, 0);
  // The def of a kind W built most of, for its name.
  const most = (keep: (u: QuipFacts["built"][number]) => boolean) => f.built.filter(keep).sort((a, b) => b.n - a.n)[0];
  const many = (u: { human: string }, n: number) => (n > 1 ? plural(u.human) : u.human);

  if (f.kind === "base" && f.baseShare >= 0.5) {
    return say("base", [
      `${L} will need a new base.`,
      `Property values on ${possessive(L)} side of the map just fell.`,
      `${L} is downsizing, though not by choice.`,
    ]);
  }
  if (f.nukeNoAnti) {
    return say("nuke", [
      `${W} builds a nuke silo, and ${L} has no anti-nuke. Awkward.`,
      `${possessive(W)} first nuke silo goes up. ${L} has no anti-nuke yet.`,
    ]);
  }
  if (f.fusionFirst) {
    return say("fusion", [
      `${W} goes fusion; ${L} has none yet.`,
      `${possessive(W)} first Fusion Reactor hums to life. ${L} has none yet.`,
    ]);
  }
  if (f.kind === "growth" && f.wonMetal >= IDLE_MIN && f.loseMetal <= IDLE_SHARE * f.wonMetal) {
    return say("idle", [
      `${possessive(L)} builders seem to have taken a break.`,
      `Meanwhile ${possessive(L)} construction crews were on a coffee break.`,
    ]);
  }
  if (f.minesLost >= MINES_MIN) {
    return say("mines", [
      `${possessive(L)} mines go quiet.`,
      `No mines, no metal: ${L} finds out the hard way.`,
    ]);
  }
  const dig = most((u) => u.stand === "defence");
  if (dig && dig.n >= DIG_MIN) {
    return say("dig", [
      `${W} digs in: ${dig.n} ${many(dig, dig.n)}.`,
      `${dig.n} ${many(dig, dig.n)}: ${W} is not going anywhere.`,
    ]);
  }
  const walls = count(WALL);
  const wall = most((u) => WALL.test(u.name));
  if (wall && walls >= WALL_MIN) {
    return say("wall", [
      `Nothing says "keep out" like ${walls} ${many(wall, walls)}.`,
      `${W} builds a wall, ${walls} pieces long.`,
    ]);
  }
  const wind = count(WIND);
  const turbine = most((u) => WIND.test(u.name));
  if (turbine && wind >= WIND_MIN) {
    return say("wind", [
      `${wind} ${many(turbine, wind)}: ${W} is betting the game on the weather.`,
      `${W} plants a forest of ${wind} ${many(turbine, wind)}.`,
    ]);
  }
  const conv = count(CONVERTER);
  const converter = most((u) => CONVERTER.test(u.name));
  if (converter && conv >= CONVERTER_MIN) {
    return say("convert", [
      `${conv} ${many(converter, conv)}: ${W} found a use for all that energy.`,
      `${W} turns its spare energy into metal: ${conv} converters.`,
    ]);
  }
  const epic = f.built.filter((u) => u.metal / Math.max(1, u.n) >= EPIC_METAL).sort((a, b) => b.metal / b.n - a.metal / a.n)[0];
  if (epic) {
    const one = fmtMetal(epic.metal / epic.n);
    return say("epic", [
      `${W} puts ${one} metal into one ${epic.human}. No pressure.`,
      `${one} metal in one ${epic.human}: ${W} hopes nobody bombs it.`,
    ]);
  }
  return null;
}
