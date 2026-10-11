// The facts every achievement is judged on, gathered once from the game's
// demo (orders, chat, drawings, pauses, departures, end-of-game totals, the
// lobby's ratings), the replay's unit-def table and, where it helps, the
// insights file. Pure: nothing here touches the page.
import type { BrpDef, Demo, DemoCommand, TeamStats } from "../demo";
import type { Insights } from "../types";

export const FPS = 30;

/** CMD_* ids (rts/Sim/Units/CommandAI/Command.h). */
export const CMD = {
  stop: 0, insert: 1, move: 10, patrol: 15, fight: 16, attack: 20, areaAttack: 21, guard: 25, repair: 40,
  fireState: 45, selfd: 65, loadUnits: 75, loadOnto: 76, unloadUnits: 80, unloadUnit: 81, reclaim: 90,
};
/** Command option bits: the queue multipliers a factory order carries. */
const OPT_RIGHT = 16, OPT_SHIFT = 32, OPT_CTRL = 64;

export interface Build {
  f: number;
  def: BrpDef;
  /** Structures: where it was placed. */
  x: number;
  z: number;
}

export interface Queue {
  f: number;
  def: BrpDef;
  /** Units queued (shift = 5, ctrl = 20, both = 100). */
  n: number;
}

export interface Player {
  /** The demo's player number; -1 for an AI team. */
  id: number;
  name: string;
  team: number;
  ally: number;
  /** Index into Facts.sides. */
  side: number;
  ai: boolean;
  skill: number;
  sigma: number;
  rank: number;
  country: string;
  won: boolean | null;
  stats?: TeamStats;
  cmds: DemoCommand[];
  /** The player's ACTIONS: cmds with one entry per (frame, command). A Lua
   * widget (area mex, build lines, formations) orders unit by unit, so one
   * drag can be hundreds of cmds; counting those as clicks would make every
   * widget user a Click Storm. */
  acts: DemoCommand[];
  /** Frames of each selection change. */
  sel: number[];
  /** Structures ordered, each placement once. */
  builds: Build[];
  /** Units queued in factories. */
  queue: Queue[];
  /** Frame the player left for good before the game ended; -1 if they stayed. */
  leftAt: number;
  /** Frame the player resigned (NETMSG_TEAM resign); -1 if never. */
  resignedAt: number;
  /** Chat lines written, autohost commands ("!vote y") excluded. */
  chat: { f: number; dest: string; text: string }[];
  /** Autohost commands typed ("!cv resign", "!vote n"). */
  commands: { f: number; text: string }[];
  pings: number[];
  lines: number;
}

export interface Side {
  index: number;
  ally: number;
  players: Player[];
  won: boolean | null;
  /** Mean rating of the players who have one; NaN when none has. */
  skill: number;
}

export interface Vote {
  f: number;
  /** Who called it. */
  caller: string;
  /** The command voted on, e.g. "resign Chumpzilla TEAM". */
  command: string;
  outcome: "passed" | "failed" | "cancelled" | null;
  endF: number;
  /** Players who voted no while it ran. */
  no: string[];
}

export interface Facts {
  demo: Demo;
  defs: Map<number, BrpDef> | null;
  ins: Insights | null;
  players: Player[];
  sides: Side[];
  spectators: { id: number; name: string; chat: number }[];
  /** The last simulated frame, and the game's length in seconds/minutes. */
  endF: number;
  endSec: number;
  endMin: number;
  /** Every side but the winner's resigned (vote passed or a resign). */
  resigned: boolean;
  votes: Vote[];
  /** Map size in elmos, when known. */
  map: { w: number; h: number } | null;
  /** Total pause time in seconds, and the pauses as [from, to] wall seconds. */
  pauses: { player: number; start: number; end: number; unpausedBy: number }[];
}

// ---- unit-def classification ------------------------------------------------
// The defs carry no role flags beyond a handful of engine booleans and BAR's
// unitGroup, so roles are read off those plus curated name tables (the same
// ones internal/insights/classes.go uses), the faction prefix stripped.

const shipRE = /^(armaas|armacsub|armantiship|armbats|armcarry|armcrus|armcs|armdecade|armdecadet3|armdronecarry|armepoch|armexcalibur|armhaca|armlship|armmls|armmship|armpship|armpshipt3|armpt|armptt2|armrecl|armroy|armseadragon|armserp|armserpt3|armsjam|armsub|armsubk|armtorps|armtrident|coracsub|corantiship|corarch|corbats|corblackhy|corcarry|corcrus|corcs|cordesolator|cordronecarry|coresupp|coresuppt3|corfship|corhacs|cormls|cormship|coronager|corprince|corpship|corpt|correcl|corroy|corsentinel|corshark|corsjam|corslrpc|corssub|corsub|leganavyaaship|leganavyantinukecarrier|leganavyantiswarm|leganavyartyship|leganavybattleship|leganavybattlesub|leganavyconsub|leganavycruiser|leganavyengineer|leganavyflagship|leganavyheavysub|leganavymissileship|leganavyradjamship|leghastatus|leghastatusalt|legnavyaaship|legnavyartyship|legnavyconship|legnavydestro|legnavyfrigate|legnavyrezsub|legnavyscout|legnavysub|legoptio|legpontus|legstingray|legtriarius|legtriariusalt|legvelite)$/;
const lrpcRE = /^(armbrtha|corint|leglrpc)$/;
const rapidRE = /^(armvulc|corbuzz|legstarfall)$/;
const nukeRE = /^(armsilo|corsilo|legsilo)$/;

/** base strips the scavenger suffix, so a scav copy reads as its original. */
const base = (d: BrpDef) => d.name.replace(/_scav$/, "");
/** role strips the faction too: armmex and cormex are both "mex". */
export const role = (d: BrpDef) => base(d).replace(/^(arm|cor|leg)/, "");
export const faction = (d: BrpDef) => /^(arm|cor|leg)/.exec(d.name)?.[1] ?? "";

export const isStructure = (d: BrpDef) => !!d.isBuilding || !d.canMove;
export const isFactory = (d: BrpDef) => !!d.isFactory;
export const tech = (d: BrpDef) => d.techLevel ?? 0;
export const isT2Factory = (d: BrpDef) => isFactory(d) && tech(d) >= 2;
export const isMex = (d: BrpDef) => isStructure(d) && d.unitGroup === "metal" && /mex|moho|mexp/.test(base(d));
export const isT2Mex = (d: BrpDef) => isMex(d) && tech(d) >= 2;
export const isConverter = (d: BrpDef) => isStructure(d) && d.unitGroup === "metal" && /makr|mmkr|fmkr|metalmaker/.test(base(d));
export const isStorage = (d: BrpDef) => isStructure(d) && /estor|mstor|uwes|uwms|uwadves|uwadvms|storage/.test(base(d));
export const isEnergyStorage = (d: BrpDef) => isStorage(d) && /estor|uwes|uwadves/.test(base(d));
export const isEnergy = (d: BrpDef) => isStructure(d) && d.unitGroup === "energy" && !isStorage(d);
export const isWind = (d: BrpDef) => isEnergy(d) && /win(t2)?$/.test(role(d));
export const isSolar = (d: BrpDef) => isEnergy(d) && /sol(ar)?$/.test(role(d));
export const isTidal = (d: BrpDef) => isEnergy(d) && /tide/.test(role(d));
export const isGeo = (d: BrpDef) => isStructure(d) && /geo|gmm/.test(role(d));
export const isFusion = (d: BrpDef) => isEnergy(d) && /fus/.test(role(d));
export const isWall = (d: BrpDef) => isStructure(d) && /(drag|fort)$/.test(role(d));
export const isNano = (d: BrpDef) => isStructure(d) && !!d.isBuilder && !isFactory(d);
export const isNukeSilo = (d: BrpDef) => isStructure(d) && (nukeRE.test(base(d)) || d.unitGroup === "nuke");
export const isAntiNuke = (d: BrpDef) => d.unitGroup === "antinuke";
export const isLRPC = (d: BrpDef) => lrpcRE.test(base(d));
export const isRapidLRPC = (d: BrpDef) => rapidRE.test(base(d));
export const isJammer = (d: BrpDef) => isStructure(d) && /jam|veil|shroud/.test(role(d));
export const isIntel = (d: BrpDef) => isStructure(d) && (/rad|jam|eye|son|veil|shroud|marky|scan/.test(role(d)));
export const isDefence = (d: BrpDef) => isStructure(d) && !isFactory(d) && (d.weaponCount ?? 0) > 0 && d.unitGroup !== "util" && !isNukeSilo(d);
export const isAirFactory = (d: BrpDef) => isFactory(d) && /^(ap|aap|plat|apt3|aapt3)$/.test(role(d));
export const isSeaplaneFactory = (d: BrpDef) => isFactory(d) && role(d) === "plat";
export const isShipyard = (d: BrpDef) => isFactory(d) && /^(sy|asy|fhp|amsub|syt3)$/.test(role(d));
export const isMobile = (d: BrpDef) => !isStructure(d);
export const isAir = (d: BrpDef) => isMobile(d) && !!d.canFly;
export const isShip = (d: BrpDef) => isMobile(d) && shipRE.test(base(d));
export const isCommander = (d: BrpDef) => !!d.isCommander;
export const isCombat = (d: BrpDef) => isMobile(d) && (d.weaponCount ?? 0) > 0 && !isCommander(d);
export const isConstructor = (d: BrpDef) => isMobile(d) && !!d.isBuilder && !isCommander(d);
/** Experimental: the summary's rule, a mobile armed unit of 3000+ metal. */
export const isExperimental = (d: BrpDef) => isCombat(d) && (d.metalCost ?? 0) >= 3000;
export const isEco = (d: BrpDef) => d.unitGroup === "energy" || d.unitGroup === "metal";

// ---- gathering ---------------------------------------------------------------

/** unwrap turns CMD_INSERT (BAR's "insert into the queue") into the command
 * it carries: params [position, id, options, ...params]. */
export function unwrap(c: DemoCommand): DemoCommand {
  if (c.id !== CMD.insert || c.params.length < 3) return c;
  return { ...c, id: Math.round(c.params[1]), opts: Math.round(c.params[2]), params: c.params.slice(3) };
}

const RESIGN_VOTE = /called a vote for command "(resign [^"]*)"/;
const VOTE_END = /Vote for command "([^"]*)" (passed|failed)/i;
const VOTE_CANCEL = /Vote (?:for command "([^"]*)" )?(?:cancelled|canceled)/i;

export function gather(demo: Demo, defs: Map<number, BrpDef> | null, ins: Insights | null, map: { w: number; h: number } | null): Facts {
  const endF = demo.lastFrame;
  const endSec = demo.gameTime > 0 ? demo.gameTime : endF / FPS;
  const teamAlly = new Map(demo.teams.map((t) => [t.team, t.ally]));
  const pve = (s: string) => /raptor|scav|chicken/i.test(s);
  const players: Player[] = [];
  const blank = (p: Omit<Player, "cmds" | "acts" | "sel" | "builds" | "queue" | "leftAt" | "resignedAt" | "chat" | "commands" | "pings" | "lines" | "side" | "won">): Player => ({
    ...p, side: -1, won: null, cmds: [], acts: [], sel: [], builds: [], queue: [], leftAt: -1, resignedAt: -1, chat: [], commands: [], pings: [], lines: 0,
  });
  const byId = new Map<number, Player>();
  for (const dp of demo.players) {
    if (dp.spectator || !teamAlly.has(dp.team)) continue;
    const p = blank({ id: dp.id, name: dp.name, team: dp.team, ally: teamAlly.get(dp.team) ?? -1, ai: false, skill: dp.skill, sigma: dp.sigma, rank: dp.rank, country: dp.country });
    players.push(p);
    byId.set(dp.id, p);
  }
  const aiByTeam = new Map<number, Player>();
  let aiN = 0;
  for (const t of demo.teams) {
    if (!t.ai || pve(t.ai)) continue;
    const p = blank({ id: -1, name: `AI ${++aiN}`, team: t.team, ally: t.ally, ai: true, skill: NaN, sigma: NaN, rank: -1, country: "" });
    players.push(p);
    aiByTeam.set(t.team, p);
  }
  // The insights file names AI teams too; prefer its names.
  for (const p of players) {
    const t = ins?.teams.find((x) => x.team === p.team);
    if (p.ai && t?.player) p.name = t.player;
  }

  const allies = [...new Set(players.map((p) => p.ally))].sort((a, b) => a - b);
  const winners = demo.winners?.length ? new Set(demo.winners) : ins && ins.winner !== undefined && ins.winner >= 0 && ins.sides[ins.winner] ? new Set([ins.sides[ins.winner].ally]) : null;
  const sides: Side[] = allies.map((ally, index) => {
    const ps = players.filter((p) => p.ally === ally);
    const rated = ps.filter((p) => Number.isFinite(p.skill));
    return { index, ally, players: ps, won: winners ? winners.has(ally) : null, skill: rated.length ? rated.reduce((a, p) => a + p.skill, 0) / rated.length : NaN };
  });
  for (const s of sides) for (const p of s.players) {
    p.side = s.index;
    p.won = s.won;
  }

  if (demo.teamStats) for (const p of players) p.stats = demo.teamStats.get(p.team);

  for (const raw of demo.commands) {
    const c = unwrap(raw);
    const p = raw.ai !== undefined ? aiByTeam.get(demo.aiTeams.get(raw.ai) ?? -1) : byId.get(raw.player);
    if (!p) continue;
    p.cmds.push(c);
    const a = p.acts[p.acts.length - 1];
    if (!a || a.f !== c.f || a.id !== c.id) p.acts.push(c);
  }
  for (const [id, frames] of demo.selections) {
    const p = byId.get(id);
    if (p) p.sel = frames;
  }
  for (const p of players) collectBuilds(p, defs);

  // Departures: a player who left before the end and did not come back.
  const back = new Map<number, number>();
  for (const r of demo.rejoined) back.set(r.player, Math.max(back.get(r.player) ?? -1, r.f));
  for (const l of demo.left) {
    const p = byId.get(l.player);
    if (!p || l.f >= endF - 10 * FPS) continue;
    if ((back.get(l.player) ?? -1) > l.f) continue;
    if (p.leftAt < 0) p.leftAt = l.f;
  }
  for (const m of demo.teamMsgs) {
    const p = byId.get(m.player);
    if (p && m.action === 2 && p.resignedAt < 0) p.resignedAt = m.f;
  }

  const spectators = demo.players.filter((p) => p.spectator || !teamAlly.has(p.team)).map((p) => ({ id: p.id, name: p.name, chat: 0 }));
  const specById = new Map(spectators.map((s) => [s.id, s]));
  const votes: Vote[] = [];
  for (const c of demo.chat) {
    if (c.dest === "server") {
      const call = RESIGN_VOTE.exec(c.text) ?? /called a vote for command "([^"]*)"/.exec(c.text);
      if (call) {
        const caller = /\* (.+?) called a vote/.exec(c.text)?.[1] ?? "";
        votes.push({ f: c.f, caller, command: call[1], outcome: null, endF: -1, no: [] });
        continue;
      }
      const end = VOTE_END.exec(c.text);
      const cancel = !end && VOTE_CANCEL.exec(c.text);
      if (end || cancel) {
        const v = [...votes].reverse().find((x) => x.outcome === null && (!end || x.command === end[1]));
        if (v) {
          v.outcome = end ? (end[2].toLowerCase() as "passed" | "failed") : "cancelled";
          v.endF = c.f;
        }
      }
      continue;
    }
    if (c.player < 0) continue;
    const p = byId.get(c.player);
    const text = c.text.trim();
    if (p) {
      if (text.startsWith("!")) {
        p.commands.push({ f: c.f, text });
        const open = votes.find((v) => v.outcome === null);
        if (open && /^!(vote )?n(o)?$/i.test(text)) open.no.push(p.name);
      } else p.chat.push({ f: c.f, dest: c.dest, text });
    } else {
      const s = specById.get(c.player);
      if (s && !text.startsWith("!")) s.chat++;
    }
  }
  for (const d of demo.draws) {
    const p = byId.get(d.player);
    if (!p) continue;
    if (d.kind === "point") p.pings.push(d.f);
    else if (d.kind === "line") p.lines++;
  }

  // Pauses: each pause runs to the next unpause. The chunk time stamps keep
  // counting while the game stands still, which is what measures it.
  const pauses: Facts["pauses"] = [];
  let open: { player: number; start: number } | null = null;
  for (const e of demo.pauses) {
    if (e.paused && !open) open = { player: e.player, start: e.t };
    else if (!e.paused && open) {
      pauses.push({ ...open, end: e.t, unpausedBy: e.player });
      open = null;
    }
  }

  const losers = sides.filter((s) => s.won === false);
  const resigned = losers.length > 0 && losers.every((s) =>
    s.players.some((p) => p.resignedAt >= 0) || votes.some((v) => v.outcome === "passed" && /^resign /.test(v.command) && s.players.some((p) => v.command.includes(` ${p.name} `) || v.caller === p.name)));
  return { demo, defs, ins, players, sides, spectators, endF, endSec, endMin: endSec / 60, resigned, votes, map, pauses };
}

/** collectBuilds splits a player's build orders into structures placed
 * (once per spot: a builder group shares one order, and a re-queued
 * placement is the same building) and units queued in factories. */
function collectBuilds(p: Player, defs: Map<number, BrpDef> | null) {
  if (!defs) return;
  const seen = new Set<string>();
  for (const c of p.cmds) {
    if (c.id >= 0) continue;
    const def = defs.get(-c.id);
    if (!def) continue;
    if (isStructure(def) && c.params.length >= 3) {
      const key = `${def.id}:${Math.round(c.params[0] / 16)}:${Math.round(c.params[2] / 16)}`;
      if (c.opts & OPT_RIGHT || seen.has(key)) continue;
      seen.add(key);
      p.builds.push({ f: c.f, def, x: c.params[0], z: c.params[2] });
    } else if (!isStructure(def)) {
      const n = (c.opts & OPT_SHIFT ? 5 : 1) * (c.opts & OPT_CTRL ? 20 : 1);
      p.queue.push({ f: c.f, def, n: c.opts & OPT_RIGHT ? -n : n });
    }
  }
}

// ---- helpers the rules share ---------------------------------------------------

export const sec = (f: number) => f / FPS;
export const min = (f: number) => f / FPS / 60;

/** clock formats sim frames as m:ss. */
export function clock(f: number): string {
  const s = Math.max(0, Math.round(f / FPS));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** humans is everyone who played, AIs left out. */
export const humans = (F: Facts) => F.players.filter((p) => !p.ai);

/** two is the two sides of a two-sided game, or null. */
export function two(F: Facts): [Side, Side] | null {
  return F.sides.length === 2 ? [F.sides[0], F.sides[1]] : null;
}
export const winner = (F: Facts) => F.sides.find((s) => s.won === true) ?? null;
export const losers = (F: Facts) => F.sides.filter((s) => s.won === false);
export const isDuel = (F: Facts) => F.sides.length === 2 && F.sides.every((s) => s.players.length === 1);
/** A team game: two sides, more than one player on each. */
export const isTeamGame = (F: Facts) => F.sides.length === 2 && F.sides.every((s) => s.players.length >= 2);
export const playerCount = (F: Facts) => F.players.length;

/** apm is a player's commands and selection changes per minute of the game. */
export const apm = (F: Facts, p: Player) => (p.acts.length + p.sel.length) / Math.max(1, F.endMin);

/** perMinute bins a list of frames into minutes. */
export function perMinute(frames: number[], endF: number): number[] {
  const out = new Array(Math.max(1, Math.ceil(endF / FPS / 60))).fill(0);
  for (const f of frames) out[Math.min(out.length - 1, Math.max(0, Math.floor(f / FPS / 60)))]++;
  return out;
}

/** maxIn is the most frames inside any window of `w` frames. */
export function maxIn(frames: number[], w: number): { n: number; f: number } {
  const s = [...frames].sort((a, b) => a - b);
  let best = { n: 0, f: 0 };
  for (let i = 0, j = 0; j < s.length; j++) {
    while (s[j] - s[i] > w) i++;
    if (j - i + 1 > best.n) best = { n: j - i + 1, f: s[i] };
  }
  return best;
}

/** top returns the item with the highest value, and the runner-up's value. */
export function top<T>(xs: T[], v: (x: T) => number): { best: T; value: number; next: number } | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => v(b) - v(a));
  return { best: s[0], value: v(s[0]), next: s.length > 1 ? v(s[1]) : -Infinity };
}

/** startOf is where a team started: its start position, else its first
 * structure order. */
export function startOf(F: Facts, p: Player): [number, number] | null {
  const s = F.demo.startPos.get(p.team);
  if (s) return s;
  const b = p.builds[0];
  return b ? [b.x, b.z] : null;
}

/** t2At is the frame a player's first T2 factory was finished when the
 * insights file knows (a full-view capture), else when it was ordered;
 * -1 never. */
export function t2At(F: Facts, p: Player): number {
  const r = F.ins?.pov === "full" ? F.ins.players.find((x) => x.team === p.team) : undefined;
  if (r) return r.style.t2;
  const b = p.builds.find((x) => isT2Factory(x.def));
  return b ? b.f : -1;
}

/** sideLeftShort is, per frame, whether `s` had fewer players still in the
 * game than every other side: the frames from which that held to the end. */
export function playersAt(s: Side, f: number): number {
  return s.players.filter((p) => !((p.leftAt >= 0 && p.leftAt <= f) || (p.resignedAt >= 0 && p.resignedAt <= f))).length;
}

/** shortHanded is how long (frames) side `s` had fewer players than the
 * other side of a two-sided game, sampled every 10 s, and the first frame of
 * the last such stretch running to the end (-1 if it was not short then). */
export function shortHanded(F: Facts, s: Side): { frames: number; since: number } {
  const t = two(F);
  if (!t) return { frames: 0, since: -1 };
  const other = t[0] === s ? t[1] : t[0];
  const step = 10 * FPS;
  let frames = 0;
  let since = -1;
  for (let f = 0; f <= F.endF - FPS; f += step) {
    const short = playersAt(s, f) < playersAt(other, f);
    if (short) {
      frames += step;
      if (since < 0) since = f;
    } else since = -1;
  }
  return { frames, since };
}

export const isGG = (t: string) => /^\s*(gg+s?|g g|ggwp|gg wp|good game|gege|ggs all)\b/i.test(t);
export const isGL = (t: string) => /^\s*(gl\s*hf|glhf|gl|hf|good luck|gl and hf|gl & hf)\b/i.test(t);
