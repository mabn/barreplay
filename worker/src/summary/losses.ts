// What each side lost over the game, and which of those losses were not
// fighting: when a team is eliminated its remaining units go down with it,
// and at the end of a game those are most of the deaths there are. Pure, so
// the node tests can pin it.
import { sideName, sideOfTeam } from "./model";
import { SIM_FPS, type Insights } from "./types";

export interface Losses {
  /** Whether the values are metal (else unit counts). */
  priced: boolean;
  /** [side][step]: lost in the game. */
  combat: number[][];
  /** [side][step]: lost with an eliminated team. */
  wiped: number[][];
  /** [side][step]: what the side owned as the step began, in metal, which
   * a loss is a share of; null when the file cannot say (before version 4,
   * or a replay pricing only its army). */
  owned: number[][] | null;
}

export interface Knockout {
  f: number;
  team: number;
  side: number;
  /** Who the team was, for a label. */
  name: string;
  /** What happened: "X is eliminated", or "X leaves, handing their units
   * to Y" for a player whose units went to a teammate. */
  label: string;
  /** The units went to a teammate: the army stayed on the board. */
  handoff: boolean;
}

/** knockouts lists the eliminated teams with their sides and names, in time
 * order; empty for a file before version 3. */
export function knockouts(ins: Insights): Knockout[] {
  const side = sideOfTeam(ins);
  const owner = new Map(ins.teams.map((t) => [t.team, t.player ?? ""]));
  return (ins.eliminated ?? []).map((e) => {
    const sd = side.get(e.team) ?? -1;
    const name = owner.get(e.team) || (sd >= 0 ? sideName(ins, sd) : `Team ${e.team}`);
    const to = e.to !== undefined ? owner.get(e.to) || `Team ${e.to}` : null;
    return { f: e.f, team: e.team, side: sd, name, label: to ? `${name} leaves, handing their units to ${to}` : `${name} is eliminated`, handoff: to !== null };
  });
}

/** wipedOf says, by death index, whether that unit went down with its
 * team rather than in the game. */
export function wipedOf(ins: Insights): (i: number) => boolean {
  const at = new Map<number, number>();
  for (const e of ins.eliminated ?? []) at.set(e.team, e.f);
  const d = ins.deaths;
  return (i) => {
    const f = at.get(d.team[i]);
    return f !== undefined && d.f[i] >= f;
  };
}

/** lossesByStep bins every death into its side's step, as metal when the
 * file prices anything and as a count otherwise. */
export function lossesByStep(ins: Insights): Losses {
  const n = ins.series.t.length;
  const sides = ins.sides.length;
  const combat = Array.from({ length: sides }, () => new Array<number>(n).fill(0));
  const wiped = Array.from({ length: sides }, () => new Array<number>(n).fill(0));
  const d = ins.deaths;
  const priced = d.cost.some((c) => c > 0);
  const side = sideOfTeam(ins);
  const isWiped = wipedOf(ins);
  const stepF = ins.stepSec * SIM_FPS;
  for (let i = 0; i < d.f.length; i++) {
    const sd = side.get(d.team[i]) ?? -1;
    if (sd < 0 || sd >= sides || n === 0) continue;
    const step = Math.min(n - 1, Math.max(0, Math.floor(d.f[i] / stepF)));
    (isWiped(i) ? wiped : combat)[sd][step] += priced ? d.cost[i] ?? 0 : 1;
  }
  // What each side owned as the step began is the value at the END of the
  // step before: the step's own value already has its losses taken out.
  const v = ins.series.value;
  const owned = priced && ins.costCoverage === "full" && v && v.length === sides
    ? v.map((row) => row.map((_, i) => row[Math.max(0, i - 1)] ?? 0))
    : null;
  return { priced, combat, wiped, owned };
}
