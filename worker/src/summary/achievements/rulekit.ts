// What every achievement rule is built from: the Rule shape and the helpers
// the rule files (rules-*.ts) share.
import { CMD, isCommander, isMex, maxIn, role, type Facts, type Player, type Side } from "./facts";
export * from "./facts";

export type Need = "meta" | "chat" | "orders" | "endstats";

export interface Hit {
  player?: Player;
  side?: Side;
  /** What earned it, with the numbers. */
  text: string;
  /** The moment, when there is one to watch. */
  f?: number;
}

/** A rule's KNOB: the one number that decides how often it is earned, so
 * its rarity can be tuned. The rule's check reads it as `k`, and its desc
 * names it as {k}. */
export interface Knob {
  /** The value the rule is judged at. */
  value: number;
  /** 1 when a BIGGER value makes the achievement harder (rarer), -1 when a
   * smaller one does (a time limit). */
  harder: 1 | -1;
  /** A whole number (a count, whole seconds): tuning rounds it. */
  int?: boolean;
}

export interface Rule {
  id: number;
  name: string;
  /** What earns it; {k} stands for the knob's value. */
  desc: string;
  need: Need;
  /** Absent on a rule with no number to tune (a yes/no condition). */
  knob?: Knob;
  check: (F: Facts, k: number) => Hit[] | { skip: string };
}

/** describe is a rule's desc at knob value k (its own by default). */
export function describe(r: Rule, k = r.knob?.value): string {
  return k === undefined ? r.desc : r.desc.replace(/\{k\}/g, fmtKnob(k));
}

export function fmtKnob(k: number): string {
  return Number.isInteger(k) ? String(k) : String(Math.round(k * 100) / 100);
}

/** PREGAME: the frames on which the pre-game build queue is issued. */
export const PREGAME = 10;
export const skip = (why: string) => ({ skip: why });
export const k = (n: number) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${Math.round(n / 1e3)}k` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`);
export const mins = (F: Facts) => `${Math.floor(F.endMin)}:${String(Math.round(F.endSec % 60)).padStart(2, "0")}`;
export const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const st = (p: Player) => p.stats!;
export const withStats = (F: Facts) => F.players.filter((p) => p.stats);
export const winners = (F: Facts) => F.players.filter((p) => p.won === true);
export const sideOf = (F: Facts, p: Player) => F.sides[p.side];
export const decided = (F: Facts) => F.sides.some((s) => s.won !== null);
export const count = <T,>(xs: T[], pred: (x: T) => boolean) => xs.reduce((a, x) => a + (pred(x) ? 1 : 0), 0);
export const builds = (p: Player, pred: (d: Parameters<typeof isMex>[0]) => boolean) => p.builds.filter((b) => pred(b.def));
export const queued = (p: Player, pred: (d: Parameters<typeof isMex>[0]) => boolean) => sum(p.queue.filter((q) => pred(q.def)).map((q) => q.n));
export const otherSide = (F: Facts, s: Side) => F.sides.find((x) => x !== s)!;
export const rating = (p: Player) => (Number.isFinite(p.skill) ? p.skill.toFixed(1) : "?");

export function gameHit(text: string, f?: number): Hit[] {
  return [{ text, f }];
}

/** endstats gates a rule on the demo's end-of-game totals. */
export type Res = Hit[] | { skip: string };
export function endstats(F: Facts, fn: () => Res): Hit[] | { skip: string } {
  if (!F.demo.teamStats || !withStats(F).length) return skip("this demo carries no end-of-game totals");
  return fn();
}
/** orders gates a rule on knowing what each build order builds. */
export function orders(F: Facts, fn: () => Res): Hit[] | { skip: string } {
  if (!F.defs) return skip("the replay's unit-def table could not be read, so build orders cannot be named");
  return fn();
}
export function needWinner(F: Facts, fn: () => Res): Hit[] | { skip: string } {
  if (!decided(F)) return skip("the demo does not say who won");
  return fn();
}
/** byElimination: the losers did not resign or vote to. */
export const byElimination = (F: Facts) => decided(F) && !F.resigned;

/** per runs pred over players and turns each match into a Hit. */
export function per(ps: Player[], fn: (p: Player) => string | null | false | undefined, f?: (p: Player) => number | undefined): Hit[] {
  const out: Hit[] = [];
  for (const p of ps) {
    const t = fn(p);
    if (t) out.push({ player: p, text: t, f: f?.(p) });
  }
  return out;
}

/** sideTotal sums one end-of-game total over a side. */
export const sideTotal = (s: Side, key: keyof NonNullable<Player["stats"]>) => sum(s.players.map((p) => (p.stats ? p.stats[key] : 0)));

/** firstBuilds is a player's first n structure orders, by role. */
export const firstBuilds = (p: Player, n: number) => p.builds.slice(0, n).map((b) => role(b.def));

export const chatLines = (ps: Player[]) => sum(ps.map((p) => p.chat.length));
export const last = <T,>(xs: T[]) => xs[xs.length - 1];

/** selfdBursts is a player's self-destruct orders as unit counts, and the
 * most units ordered within w frames. */
export function selfdBurst(p: Player, w: number): { n: number; f: number } {
  const ev: number[] = [];
  for (const c of p.cmds) if (c.id === CMD.selfd) for (let i = 0; i < Math.max(1, c.units.length); i++) ev.push(c.f);
  return maxIn(ev, w);
}

/** commanderSelfd is the frame a player's commander died self-destructed,
 * as the insights file records it (a full-view capture), or -1. */
export function commanderSelfd(F: Facts, p: Player): number | null {
  const ins = F.ins;
  if (!ins?.deaths?.selfd || ins.pov !== "full") return null;
  const d = ins.deaths;
  for (let i = 0; i < d.f.length; i++) {
    if (d.team[i] !== p.team || !d.selfd?.[i]) continue;
    const def = F.defs?.get(d.def[i]);
    if ((def && isCommander(def)) || ins.defs[String(d.def[i])]?.class === "commander") return d.f[i];
  }
  return -1;
}

/** voteSide is the side a resign vote was about: its caller's. */
export function voteSide(F: Facts, caller: string): Side | null {
  const p = F.players.find((x) => x.name === caller);
  return p ? sideOf(F, p) : null;
}
export const resignVotes = (F: Facts) => F.votes.filter((v) => /^resign /i.test(v.command));

/** gaps is the longest stretch (frames) between consecutive frames, the
 * game's start and its end included. */
export function longestGap(frames: number[], from: number, to: number): { len: number; at: number } {
  const s = [from, ...frames.filter((f) => f >= from && f <= to).sort((a, b) => a - b), to];
  let best = { len: 0, at: from };
  for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > best.len) best = { len: s[i] - s[i - 1], at: s[i - 1] };
  return best;
}

/** openings names a few standard starts by the roles of the first builds. */
export const OPENINGS: { name: string; seq: RegExp }[] = [
  { name: "the double-mex wind opening", seq: /^mex,mex,win,win,(lab|vp|ap|hp)$/ },
  { name: "the triple-mex wind opening", seq: /^mex,mex,mex,win,(lab|vp|ap|hp)$/ },
  { name: "the solar opening", seq: /^mex,mex,solar,(lab|vp|ap|hp),/ },
  { name: "the factory-first opening", seq: /^(lab|vp|ap|hp),mex,mex,/ },
  { name: "the mex-solar-mex opening", seq: /^mex,solar,mex,(lab|vp|ap|hp)/ },
];
