// The insights file the summary draws: replays/<rid>.insights<N>.json,
// computed by internal/insights (Go). This is the TypeScript half of that
// contract — keep it in lockstep with internal/insights/insights.go.

export interface Insights {
  version: number;
  gameId: string;
  mapName?: string;
  durationSec: number;
  /** Spacing of every series, in seconds. */
  stepSec: number;
  /** "full": every def is priced. "army": only armed mobile defs are (a
   * replay rebuilt from its published pieces), so losses of anything else
   * count but carry no metal. */
  costCoverage: "full" | "army" | string;
  /** Whose point of view the capture is. Only "full" can compare sides. */
  pov: "full" | "ally" | "unknown" | string;
  bounds: Bounds;
  sides: Side[];
  teams: Team[];
  defs: Record<string, Def>;
  series: Series;
  deaths: Deaths;
  milestones: Milestone[];
  /** The biggest clusters of deaths, in time order. */
  battles: Battle[];
  awards: Award[];
  /** One report per team a player controlled. */
  players: PlayerReport[];
  chat: ChatLine[];
  /** Map pings per side per step. */
  marks: number[][];
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Side {
  ally: number;
  teams: number[];
  players: string[];
  color?: string;
}

export interface Team {
  team: number;
  /** Index into sides; -1 for teams no player controls (Gaia, scavengers). */
  side: number;
  player?: string;
  color?: string;
}

export interface Def {
  name: string;
  human?: string;
  /** Metal; absent when the replay does not record it. */
  cost?: number;
}

export interface Series {
  /** Step i's time in seconds. */
  t: number[];
  /** [side][step] metal value of the army. */
  army: number[][];
  metalIncome: number[][];
  energyIncome: number[][];
  armyCats: string[];
  /** [side][category][step]. */
  armyByCat: number[][][];
  /** [side][step] = [x, z], the cost-weighted centre of the side's army,
   * or null while it has none. */
  front: (number[] | null)[][];
}

export interface Battle {
  f0: number;
  f1: number;
  x: number;
  z: number;
  /** Radius holding the deaths, elmos. */
  r: number;
  /** Indexed like sides. */
  lost: { n: number; metal: number; top: number[] }[];
}

export interface PlayerReport {
  team: number;
  player: string;
  side: number;
  /** Per step, like Series. */
  strip: { builtMetal: number[]; builtN: number[]; lostMetal: number[]; lostN: number[]; chat: number[] };
  leaks: {
    /** Seconds the player's whole side sat on full metal storage. */
    floatSec: number;
    /** The player's income over that time. */
    floatMetal: number;
    /** Share of builder time with no target and not moving; null without build targets. */
    notBuilding: number | null;
    builderSec: number;
  };
  commander: {
    /** [x, z, health %] per step, null while there is no commander. */
    path: (number[] | null)[];
    /** Frame the commander died, -1 if it lived. */
    died: number;
    /** Frame of the first enemy army unit within range, -1 if none. */
    firstContact: number;
  };
  style: {
    incomeShare: number;
    /** Frame of the first T2 lab, -1 if never. */
    t2: number;
    areaPct: number;
    forwardShare: number | null;
    assistShare: number | null;
  };
}

export interface Award {
  key: string;
  label: string;
  text: string;
  team: number;
  def: number;
  value: number;
  /** The moment to watch. */
  f: number;
}

/** Columnar: the i-th entry of every array describes one death. */
export interface Deaths {
  f: number[];
  x: number[];
  z: number[];
  def: number[];
  team: number[];
  cost: number[];
  unfinished: number[];
}

export interface Milestone {
  key: string;
  label: string;
  side: number;
  team: number;
  def: number;
  /** Sim frame (30 per game-second). */
  f: number;
}

export interface ChatLine {
  f: number;
  name: string;
  /** -1: spectator, relay or unknown. */
  side: number;
  dest?: string;
  text: string;
}

export interface SummaryOptions {
  /** Called with a sim frame when the reader asks to see a moment (a click
   * on a chart, a milestone, a chat line). A host with no replay to seek
   * leaves it out, and nothing is clickable. */
  onSeek?: (frame: number) => void;
  /** Where map images come from; defaults to BAR's maps API. Null draws the
   * map views on a plain background. */
  mapApi?: string | null;
}

export interface SummaryHandle {
  /** Removes everything mountSummary added. */
  destroy(): void;
}

/** Sim frames per game-second. */
export const SIM_FPS = 30;
