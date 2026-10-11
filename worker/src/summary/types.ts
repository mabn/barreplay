// The insights file the summary draws: replays/<rid>.insights<N>.json,
// computed by internal/insights (Go). This is the TypeScript half of that
// contract — keep it in lockstep with internal/insights/insights.go.

export interface Insights {
  version: number;
  gameId: string;
  /** The capture names what killed each unit (version 7+). */
  causes?: boolean;
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
  /** The most intense fights, in time order. */
  battles: Battle[];
  /** Teams knocked out of the game, in time order (version 3). A team's
   * deaths from that frame on went down with it, and are not fighting. */
  eliminated?: Elimination[];
  /** Index into sides of the winner, -1 unknown. Absent from version 1 files. */
  winner?: number;
  /** The win-probability line (version 2, two-sided full-view games). */
  swing?: Swing;
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
  /** Its icontypes key, when the capture records one (version 4+). */
  icon?: string;
  /** A power plant: its loss counts POWER_WORTH times its metal wherever a
   * battle's winner is decided (version 7+). */
  power?: boolean;
}

export interface Series {
  /** Step i's time in seconds. */
  t: number[];
  /** [side][step] metal value of the army. */
  army: number[][];
  /** [side][step] metal value of everything the side owns, buildings and
   * commanders included (version 4+). */
  value?: number[][];
  metalIncome: number[][];
  energyIncome: number[][];
  armyCats: string[];
  /** [side][category][step]. */
  armyByCat: number[][][];
  /** [side][step] = [x, z], the cost-weighted centre of the side's army,
   * or null while it has none. */
  front: (number[] | null)[][];
}

export interface Swing {
  /** Per step: the chance side 0 wins, 0..1. */
  p: number[];
  moments: Moment[];
  /** Whether the model was fitted to real games, and to how many. */
  fitted: boolean;
  games?: number;
}

export interface Moment {
  n: number;
  f0: number;
  f1: number;
  /** The side that gained, and by how much (0..1). */
  side: number;
  delta: number;
  /** Index into battles, -1 for none. */
  battle: number;
  /** The share of the shift carried by army value and by metal income
   * (version 7; summing to 1, absent from older files). */
  army?: number;
  eco?: number;
}

/** One team's part in a battle (version 4+), in metal. */
export interface BattleTeam {
  team: number;
  /** Its largest army within reach of the battle while it lasted. */
  army: number;
  /** What it lost there. */
  lost: number;
  /** The enemy metal credited to it there, wherever it fired from (version
   * 4 re-simulations; absent or 0 when the capture names no killers). */
  killed?: number;
}

/** How many of one def a side lost in a battle (version 4+). */
export interface UnitLoss {
  def: number;
  n: number;
  metal: number;
}

export interface Battle {
  f0: number;
  f1: number;
  x: number;
  z: number;
  /** Radius holding the deaths, elmos. */
  r: number;
  /** Indexed like sides. */
  /** worth: the metal with power plants at POWER_WORTH times theirs, what
   * a winner is decided by (version 7+; absent = metal). */
  lost: { n: number; metal: number; worth?: number; top: number[]; units?: UnitLoss[] }[];
  /** Who took part, by team (version 4+). */
  teams?: BattleTeam[];
}

export interface Elimination {
  f: number;
  team: number;
  /** Recorded by the capture, rather than inferred from a burst of deaths. */
  recorded: boolean;
  /** The team the player handed their units to before leaving (version
   * 7+): nothing was destroyed, the player is out all the same. */
  to?: number;
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
  /** Version 4: the unit's id, for the host to follow and mark it. */
  unit?: number;
  /** Version 4, a unit with a life to show: its first and last sampled
   * frame, and its route as [frame, x, z]. */
  f0?: number;
  f1?: number;
  path?: [number, number, number][];
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
  /** 1 for a unit its owner self-destructed (version 5+). */
  selfd?: number[];
}

export interface Milestone {
  key: string;
  label: string;
  side: number;
  team: number;
  def: number;
  /** Sim frame (30 per game-second). */
  f: number;
  /** Version 4: the unit that reached it, and where it was last sampled
   * before it finished. */
  unit?: number;
  pos?: [number, number];
}

export interface ChatLine {
  f: number;
  name: string;
  /** -1: spectator, relay or unknown. */
  side: number;
  dest?: string;
  text: string;
}

/** A moment to watch: sim frames f0..f1 (lead-in included), and where on the
 * map it happened when that is known (world elmos, r a radius to fit). */
export interface Clip {
  f0: number;
  f1: number;
  /** The instant the clip is about, inside [f0, f1], for the host to mark on
   * its timeline: the lead-in is then plainly a wait of a few seconds. */
  at?: number;
  /** When the moment is a span (a raid, a fight), where it ends: the host
   * marks [at, atEnd] rather than one instant. */
  atEnd?: number;
  /** Where playback starts, inside [f0, f1]: a few seconds before `at`,
   * with the rest of the clip before it there to scroll back to. Absent:
   * from f0. */
  start?: number;
  x?: number;
  z?: number;
  r?: number;
  /** What the clip shows, for the host's player to title it. */
  title?: string;
  /** The title split into runs, player and side names carrying their
   * colours, for a host that can draw them. */
  titleRuns?: { text: string; color?: string }[];
  /** The ONE unit the clip is about: the host follows and marks it. Match
   * on def as well as id, since ids are recycled. */
  follow?: { id: number; def?: number };
  /** That unit's route, [frame, x, z], for the host to draw. */
  path?: [number, number, number][];
}

export interface SummaryOptions {
  /** Called with a clip when the reader asks to see a moment (a click on a
   * chart, a battle, a chat line), for the host to play it in place. Wins
   * over onSeek. */
  onClip?: (clip: Clip) => void;
  /** Called with a sim frame when the reader asks to see a moment, for a
   * host that can only jump its replay there. A host with neither hook
   * leaves both out, and nothing is clickable. */
  onSeek?: (frame: number) => void;
  /** Where map images come from; defaults to BAR's maps API. Null draws the
   * map views on a plain background. */
  mapApi?: string | null;
  /** Where unit icons come from: an origin serving /icons/icontypes.json and
   * the bitmaps it names (the replay viewer). Defaults to the origin this
   * module was loaded from; null draws unit names instead. */
  iconBase?: string | null;
}

export interface SummaryHandle {
  /** Removes everything mountSummary added. */
  destroy(): void;
}

/** Sim frames per game-second. */
export const SIM_FPS = 30;
