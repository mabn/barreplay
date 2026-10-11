// The achievements: every one on the shortlist that a demo and the BAR API
// can decide on their own (no re-simulation), judged in the browser from
// facts.ts. Each rule names who earned it, with the numbers that earned it,
// or says why this game cannot tell.
//
// The thresholds are the shortlist's own; this is a first look at how often
// they fire, so none has been tuned.
import {
  CMD, FPS, apm, clock, faction, humans, isAir, isAirFactory, isAntiNuke, isCombat, isCommander, isConstructor, isConverter,
  isDefence, isDuel, isEco, isEnergy, isEnergyStorage, isExperimental, isFactory, isFusion, isGeo, isGG, isGL, isIntel, isJammer,
  isLRPC, isMex, isMobile, isNano, isNukeSilo, isRapidLRPC, isSeaplaneFactory, isShip, isShipyard, isSolar, isStorage, isStructure,
  isT2Factory, isT2Mex, isTeamGame, isTidal, isWall, isWind, losers, maxIn, perMinute, playerCount, role, shortHanded, startOf,
  t2At, tech, top, two, winner, type Facts, type Player, type Side,
} from "./facts";

export type Need = "meta" | "chat" | "orders" | "endstats";

export interface Hit {
  player?: Player;
  side?: Side;
  /** What earned it, with the numbers. */
  text: string;
  /** The moment, when there is one to watch. */
  f?: number;
}

export interface Rule {
  id: number;
  name: string;
  desc: string;
  need: Need;
  check: (F: Facts) => Hit[] | { skip: string };
}

/** PREGAME: the frames on which the pre-game build queue is issued. */
const PREGAME = 10;
const skip = (why: string) => ({ skip: why });
const k = (n: number) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${Math.round(n / 1e3)}k` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`);
const mins = (F: Facts) => `${Math.floor(F.endMin)}:${String(Math.round(F.endSec % 60)).padStart(2, "0")}`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const st = (p: Player) => p.stats!;
const withStats = (F: Facts) => F.players.filter((p) => p.stats);
const winners = (F: Facts) => F.players.filter((p) => p.won === true);
const sideOf = (F: Facts, p: Player) => F.sides[p.side];
const decided = (F: Facts) => F.sides.some((s) => s.won !== null);
const count = <T,>(xs: T[], pred: (x: T) => boolean) => xs.reduce((a, x) => a + (pred(x) ? 1 : 0), 0);
const builds = (p: Player, pred: (d: Parameters<typeof isMex>[0]) => boolean) => p.builds.filter((b) => pred(b.def));
const queued = (p: Player, pred: (d: Parameters<typeof isMex>[0]) => boolean) => sum(p.queue.filter((q) => pred(q.def)).map((q) => q.n));
const otherSide = (F: Facts, s: Side) => F.sides.find((x) => x !== s)!;
const rating = (p: Player) => (Number.isFinite(p.skill) ? p.skill.toFixed(1) : "?");

function gameHit(text: string, f?: number): Hit[] {
  return [{ text, f }];
}

/** endstats gates a rule on the demo's end-of-game totals. */
type Res = Hit[] | { skip: string };
function endstats(F: Facts, fn: () => Res): Hit[] | { skip: string } {
  if (!F.demo.teamStats || !withStats(F).length) return skip("this demo carries no end-of-game totals");
  return fn();
}
/** orders gates a rule on knowing what each build order builds. */
function orders(F: Facts, fn: () => Res): Hit[] | { skip: string } {
  if (!F.defs) return skip("the replay's unit-def table could not be read, so build orders cannot be named");
  return fn();
}
function needWinner(F: Facts, fn: () => Res): Hit[] | { skip: string } {
  if (!decided(F)) return skip("the demo does not say who won");
  return fn();
}
/** byElimination: the losers did not resign or vote to. */
const byElimination = (F: Facts) => decided(F) && !F.resigned;

/** per runs pred over players and turns each match into a Hit. */
function per(ps: Player[], fn: (p: Player) => string | null | false | undefined, f?: (p: Player) => number | undefined): Hit[] {
  const out: Hit[] = [];
  for (const p of ps) {
    const t = fn(p);
    if (t) out.push({ player: p, text: t, f: f?.(p) });
  }
  return out;
}

/** sideTotal sums one end-of-game total over a side. */
const sideTotal = (s: Side, key: keyof NonNullable<Player["stats"]>) => sum(s.players.map((p) => (p.stats ? p.stats[key] : 0)));

/** firstBuilds is a player's first n structure orders, by role. */
const firstBuilds = (p: Player, n: number) => p.builds.slice(0, n).map((b) => role(b.def));

const chatLines = (ps: Player[]) => sum(ps.map((p) => p.chat.length));
const last = <T,>(xs: T[]) => xs[xs.length - 1];

/** selfdBursts is a player's self-destruct orders as unit counts, and the
 * most units ordered within w frames. */
function selfdBurst(p: Player, w: number): { n: number; f: number } {
  const ev: number[] = [];
  for (const c of p.cmds) if (c.id === CMD.selfd) for (let i = 0; i < Math.max(1, c.units.length); i++) ev.push(c.f);
  return maxIn(ev, w);
}

/** commanderSelfd is the frame a player's commander died self-destructed,
 * as the insights file records it (a full-view capture), or -1. */
function commanderSelfd(F: Facts, p: Player): number | null {
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
function voteSide(F: Facts, caller: string): Side | null {
  const p = F.players.find((x) => x.name === caller);
  return p ? sideOf(F, p) : null;
}
const resignVotes = (F: Facts) => F.votes.filter((v) => /^resign /i.test(v.command));

/** gaps is the longest stretch (frames) between consecutive frames, the
 * game's start and its end included. */
function longestGap(frames: number[], from: number, to: number): { len: number; at: number } {
  const s = [from, ...frames.filter((f) => f >= from && f <= to).sort((a, b) => a - b), to];
  let best = { len: 0, at: from };
  for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > best.len) best = { len: s[i] - s[i - 1], at: s[i - 1] };
  return best;
}

/** openings names a few standard starts by the roles of the first builds. */
const OPENINGS: { name: string; seq: RegExp }[] = [
  { name: "the double-mex wind opening", seq: /^mex,mex,win,win,(lab|vp|ap|hp)$/ },
  { name: "the triple-mex wind opening", seq: /^mex,mex,mex,win,(lab|vp|ap|hp)$/ },
  { name: "the solar opening", seq: /^mex,mex,solar,(lab|vp|ap|hp),/ },
  { name: "the factory-first opening", seq: /^(lab|vp|ap|hp),mex,mex,/ },
  { name: "the mex-solar-mex opening", seq: /^mex,solar,mex,(lab|vp|ap|hp)/ },
];

export const RULES: Rule[] = [
  // ---- the lobby: sizes, ratings, ranks, countries, length ------------------
  { id: 173, name: "Masterpiece", desc: "A side with fewer players than its opponent (by 2+) wins.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F), t = two(F); if (!w || !t) return []; const o = otherSide(F, w); return o.players.length - w.players.length >= 2 ? [{ side: w, text: `${w.players.length} players beat ${o.players.length}` }] : []; }) },
  { id: 190, name: "Brutal+", desc: "An allied side beats a side with 50% more players.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w || !two(F)) return []; const o = otherSide(F, w); return o.players.length >= 1.5 * w.players.length && w.players.length >= 2 ? [{ side: w, text: `${w.players.length} beat ${o.players.length}` }] : []; }) },
  { id: 450, name: "Speed!", desc: "Game ends before minute 8 with 8+ players.", need: "meta",
    check: (F) => (F.endMin < 8 && playerCount(F) >= 8 ? gameHit(`${playerCount(F)} players, over at ${mins(F)}`) : []) },
  { id: 472, name: "Gone in 360 Seconds", desc: "A game won by elimination in under 6 minutes.", need: "meta",
    check: (F) => needWinner(F, () => (byElimination(F) && F.endMin < 6 ? gameHit(`no resign, over at ${mins(F)}`) : [])) },
  { id: 570, name: "Short Work", desc: "The game is decided before minute 10 in a game of 8+ players.", need: "meta",
    check: (F) => (F.endMin < 10 && playerCount(F) >= 8 ? gameHit(`${playerCount(F)} players, over at ${mins(F)}`) : []) },
  { id: 653, name: "Lightning War", desc: "A side wins a game of 6+ players in under 12 minutes.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); return w && playerCount(F) >= 6 && F.endMin < 12 ? [{ side: w, text: `won at ${mins(F)}` }] : []; }) },
  { id: 671, name: "Champion of Elysium", desc: "A side wins against an average OpenSkill 5+ higher.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w || !two(F)) return []; const o = otherSide(F, w); return o.skill - w.skill >= 5 ? [{ side: w, text: `average ${w.skill.toFixed(1)} beat ${o.skill.toFixed(1)}` }] : []; }) },
  { id: 703, name: "Hard Mode", desc: "Win against a side whose average OpenSkill is 5+ higher.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w || !two(F)) return []; const o = otherSide(F, w); return o.skill - w.skill >= 5 ? [{ side: w, text: `average ${w.skill.toFixed(1)} beat ${o.skill.toFixed(1)}` }] : []; }) },
  { id: 720, name: "Are You Not Entertained?", desc: "A team game (4v4+) won in under 10 minutes.", need: "meta",
    check: (F) => needWinner(F, () => (two(F) && F.sides.every((s) => s.players.length >= 4) && F.endMin < 10 ? gameHit(`won at ${mins(F)}`) : [])) },
  { id: 880, name: "Turn of the Century", desc: "A game lasting over 100 minutes.", need: "meta",
    check: (F) => (F.endMin > 100 ? gameHit(`${mins(F)} long`) : []) },
  { id: 1014, name: "Blitz", desc: "The game was decided before 15 minutes.", need: "meta",
    check: (F) => (F.endMin < 15 ? gameHit(`over at ${mins(F)}`) : []) },
  { id: 1026, name: "Seoul Power", desc: "A team game of 6+ players is decided before minute 12.", need: "meta",
    check: (F) => (isTeamGame(F) && playerCount(F) >= 6 && F.endMin < 12 ? gameHit(`${playerCount(F)} players, over at ${mins(F)}`) : []) },
  { id: 1103, name: "Deep for Speed", desc: "A team game (6+ players) won by elimination in under 20 minutes.", need: "meta",
    check: (F) => needWinner(F, () => (isTeamGame(F) && playerCount(F) >= 6 && byElimination(F) && F.endMin < 20 ? gameHit(`no resign, over at ${mins(F)}`) : [])) },
  { id: 1122, name: "Nexus Blitz", desc: "Win in under 12 minutes in a team game.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); return w && isTeamGame(F) && F.endMin < 12 ? [{ side: w, text: `won at ${mins(F)}` }] : []; }) },
  { id: 1135, name: "Warsong Expedience", desc: "Win a 1v1 in under 7 minutes.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); return w && isDuel(F) && F.endMin < 7 ? [{ player: w.players[0], text: `won at ${mins(F)}` }] : []; }) },
  { id: 1137, name: "Let's Get This Done", desc: "Team game won in under 10 minutes.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); return w && isTeamGame(F) && F.endMin < 10 ? [{ side: w, text: `won at ${mins(F)}` }] : []; }) },
  { id: 1158, name: "Kill Them All Before Nightfall", desc: "A game of 8+ players decided before minute 20.", need: "meta",
    check: (F) => (playerCount(F) >= 8 && F.endMin < 20 ? gameHit(`${playerCount(F)} players, over at ${mins(F)}`) : []) },
  { id: 1232, name: "Supremest Commander", desc: "A player wins against a side with a higher total rating by 20+ points.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w || !two(F)) return []; const o = otherSide(F, w); const tw = sum(w.players.map((p) => p.skill || 0)), to = sum(o.players.map((p) => p.skill || 0)); return to - tw >= 20 ? [{ side: w, text: `total ${tw.toFixed(0)} beat ${to.toFixed(0)}` }] : []; }) },
  { id: 1493, name: "Packed House", desc: "A game watched live by 15 or more spectators.", need: "meta",
    check: (F) => (F.spectators.length >= 15 ? gameHit(`${F.spectators.length} spectators`) : []) },
  { id: 1788, name: "Duel Upset", desc: "In a duel, the winner's OpenSkill was >= 10 lower than the loser's.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w || !isDuel(F)) return []; const a = w.players[0], b = otherSide(F, w).players[0]; return b.skill - a.skill >= 10 ? [{ player: a, text: `${rating(a)} beat ${rating(b)}` }] : []; }) },
  { id: 1789, name: "Team Upset", desc: "The winning side's average rating was >= 5 lower than the loser's in a team game.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w || !isTeamGame(F)) return []; const o = otherSide(F, w); return o.skill - w.skill >= 5 ? [{ side: w, text: `average ${w.skill.toFixed(1)} beat ${o.skill.toFixed(1)}` }] : []; }) },
  { id: 1790, name: "Rookie Win", desc: "A player at chevron rank 0 (under 5 hours) was on the winning side of an 8v8 and dealt the most damage there.", need: "meta",
    check: (F) => needWinner(F, () => endstats(F, () => { const w = winner(F); if (!w || !two(F) || !F.sides.every((s) => s.players.length === 8)) return []; const t = top(w.players.filter((p) => p.stats), (p) => st(p).damageDealt); return t && t.best.rank === 0 ? [{ player: t.best, text: `rank 0, ${k(t.value)} damage, the most on the side` }] : []; })) },
  { id: 1791, name: "Veteran's Guidance", desc: "The winning side had both a rank 0 and a rank 5 player.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); return w && w.players.some((p) => p.rank === 0) && w.players.some((p) => p.rank >= 5) ? [{ side: w, text: `a rank-0 newcomer beside a rank-${Math.max(...w.players.map((p) => p.rank))} veteran` }] : []; }) },
  { id: 1792, name: "United Nations", desc: "Players from >= 12 different countries in one game.", need: "meta",
    check: (F) => { const c = new Set(humans(F).map((p) => p.country).filter(Boolean)); return c.size >= 12 ? gameHit(`${c.size} countries`) : []; } },
  { id: 1793, name: "National Team", desc: "Every player on the winning side is from the same country (>= 3 players).", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w || w.players.length < 3) return []; const c = new Set(w.players.map((p) => p.country)); return c.size === 1 && [...c][0] ? [{ side: w, text: `all from ${[...c][0]}` }] : []; }) },
  { id: 1794, name: "Blitzkrieg", desc: "A team game of >= 8 players won in under 10 minutes.", need: "meta",
    check: (F) => needWinner(F, () => (isTeamGame(F) && playerCount(F) >= 8 && F.endMin < 10 ? gameHit(`${playerCount(F)} players, won at ${mins(F)}`) : [])) },
  { id: 1795, name: "Marathon Session", desc: "Game lasted >= 90 minutes.", need: "meta",
    check: (F) => (F.endMin >= 90 ? gameHit(`${mins(F)} long`) : []) },
  { id: 1796, name: "Equal Footing", desc: "Both sides' average rating within 0.5 in a >= 6-player game.", need: "meta",
    check: (F) => { const t = two(F); return t && playerCount(F) >= 6 && Math.abs(t[0].skill - t[1].skill) <= 0.5 ? gameHit(`${t[0].skill.toFixed(1)} against ${t[1].skill.toFixed(1)}`) : []; } },
  { id: 1797, name: "Uncertain Future", desc: "A player with rating uncertainty >= 7 (new account) won a duel against an established player.", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w || !isDuel(F)) return []; const a = w.players[0], b = otherSide(F, w).players[0]; return a.sigma >= 7 && b.sigma < 5 ? [{ player: a, text: `uncertainty ${a.sigma.toFixed(1)} against ${b.sigma.toFixed(1)}` }] : []; }) },
  { id: 1798, name: "Big Brain Lobby", desc: "The game's average rating is in the top 1% of all games of its size.", need: "meta",
    check: () => skip("needs every other game's ratings (history)") },
  { id: 1799, name: "Odd Odds", desc: "A side won while having fewer players (uneven teams from the startscript).", need: "meta",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w) return []; const more = F.sides.filter((s) => s !== w && s.players.length > w.players.length); return more.length && two(F) ? [{ side: w, text: `${w.players.length} against ${otherSide(F, w).players.length}` }] : []; }) },
  { id: 1800, name: "Mod Explorer", desc: "A game with >= 5 non-default modoptions.", need: "meta",
    // The lobby writes EVERY modoption into the startscript, defaults
    // included (a plain ranked game lists ~200), and the defaults are not
    // known here.
    check: () => skip("the demo lists every modoption, defaults included, and the defaults are not known here") },
  { id: 50, name: "Flip-Flop", desc: "A side starts a resign vote (!cv resign) that fails, then wins the game.", need: "chat",
    check: (F) => needWinner(F, () => resignVotes(F).filter((v) => v.outcome === "failed" || v.outcome === "cancelled").flatMap((v) => { const s = voteSide(F, v.caller); return s?.won ? [{ side: s, text: `${v.caller}'s resign vote at ${clock(v.f)} failed`, f: v.f }] : []; }).slice(0, 1)) },
  { id: 601, name: "No Time for Chitchat", desc: "The winning side of a team game sent no chat messages at all.", need: "chat",
    check: (F) => needWinner(F, () => { const w = winner(F); return w && isTeamGame(F) && chatLines(w.players) === 0 ? [{ side: w, text: "not one chat line" }] : []; }) },
  { id: 775, name: "What a Save", desc: "Player chats 'what a save'/'nice shot' after an ally's loss.", need: "chat",
    check: (F) => per(humans(F), (p) => { const c = p.chat.find((x) => /\b(what a save|nice save|nice shot|great save)\b/i.test(x.text)); return c ? `"${c.text}" at ${clock(c.f)}` : null; }, (p) => p.chat.find((x) => /\b(what a save|nice save|nice shot|great save)\b/i.test(x.text))?.f) },
  { id: 861, name: "Map Artist", desc: "A player draws >= 200 map line segments in one game.", need: "chat",
    check: (F) => per(humans(F), (p) => p.lines >= 200 && `${p.lines} line segments`) },
  { id: 896, name: "Graffiti Artist", desc: "A player draws 200+ line segments on the map in one game.", need: "chat",
    check: (F) => per(humans(F), (p) => p.lines >= 200 && `${p.lines} line segments`) },
  { id: 1031, name: "Hello Cleveland!", desc: "The most chat-active player in a team game (by messages) also tops their side's kills.", need: "chat",
    check: (F) => endstats(F, () => { if (!isTeamGame(F)) return []; const t = top(humans(F), (p) => p.chat.length); if (!t || t.value <= 0 || t.value === t.next) return []; const p = t.best, s = sideOf(F, p); const tk = top(s.players.filter((x) => x.stats), (x) => st(x).unitsKilled); return tk?.best === p ? [{ player: p, text: `${t.value} messages and ${st(p).unitsKilled} kills, both the most` }] : []; }) },
  { id: 1187, name: "Media Blitz", desc: "A player sends 50+ chat messages in a game.", need: "chat",
    check: (F) => per(humans(F), (p) => p.chat.length >= 50 && `${p.chat.length} messages`) },
  { id: 1206, name: "Communication Breakdown", desc: "A team game of 8+ players where nobody on the losing side writes a single chat line or ping.", need: "chat",
    check: (F) => needWinner(F, () => (isTeamGame(F) && playerCount(F) >= 8 ? losers(F).filter((s) => chatLines(s.players) === 0 && s.players.every((p) => p.pings.length === 0)).map((s) => ({ side: s, text: "no chat, no pings" })) : [])) },
  { id: 1224, name: "Good Game", desc: "Every player in the game writes 'gg' in the last 2 minutes.", need: "chat",
    check: (F) => (humans(F).length >= 2 && humans(F).every((p) => p.chat.some((c) => c.f >= F.endF - 120 * FPS && isGG(c.text))) ? gameHit(`all ${humans(F).length} players said gg`) : []) },
  { id: 1465, name: "Chatterbox", desc: "A player sends 60+ chat messages in one game.", need: "chat",
    check: (F) => per(humans(F), (p) => p.chat.length >= 60 && `${p.chat.length} messages`) },
  { id: 1497, name: "Storyteller", desc: "A player writes 60 or more chat messages in one game.", need: "chat",
    check: (F) => per(humans(F), (p) => p.chat.length >= 60 && `${p.chat.length} messages`) },
  { id: 1766, name: "Unanimous GG", desc: "Every player in the game wrote 'gg' (or variants) at the end.", need: "chat",
    check: (F) => (humans(F).length >= 2 && humans(F).every((p) => p.chat.some((c) => c.f >= F.endF - 300 * FPS && isGG(c.text))) ? gameHit(`all ${humans(F).length} players`) : []) },
  { id: 1767, name: "GL HF", desc: "Every player wrote glhf/gl/hf in the first 2 minutes.", need: "chat",
    check: (F) => (humans(F).length >= 2 && humans(F).every((p) => p.chat.some((c) => c.f <= 120 * FPS && isGL(c.text))) ? gameHit(`all ${humans(F).length} players`) : []) },
  { id: 1768, name: "Silent Victory", desc: "The winning side wrote no chat at all in a game >= 20 min.", need: "chat",
    check: (F) => needWinner(F, () => { const w = winner(F); return w && F.endMin >= 20 && chatLines(w.players) === 0 ? [{ side: w, text: `${mins(F)} without a word` }] : []; }) },
  { id: 1769, name: "Hundred Messages", desc: "Player wrote >= 100 chat messages.", need: "chat",
    check: (F) => per(humans(F), (p) => p.chat.length >= 100 && `${p.chat.length} messages`) },
  { id: 1770, name: "Shot Caller", desc: "Player wrote the most ally chat and placed the most pings on their winning side.", need: "chat",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w || w.players.length < 2) return []; const a = top(w.players, (p) => count(p.chat, (c) => c.dest === "ally")), b = top(w.players, (p) => p.pings.length); return a && b && a.best === b.best && a.value > a.next && b.value > b.next && a.value > 0 && b.value > 0 ? [{ player: a.best, text: `${a.value} ally messages, ${b.value} pings` }] : []; }) },
  { id: 1771, name: "Freehand Painter", desc: "Player drew >= 200 line segments on the map.", need: "chat",
    check: (F) => per(humans(F), (p) => p.lines >= 200 && `${p.lines} line segments`) },
  { id: 1772, name: "Ping Spammer", desc: "Player placed >= 50 map pings.", need: "chat",
    check: (F) => per(humans(F), (p) => p.pings.length >= 50 && `${p.pings.length} pings`) },
  { id: 1775, name: "Spectator Gallery", desc: "Spectators wrote >= 200 messages.", need: "chat",
    check: (F) => { const n = sum(F.spectators.map((s) => s.chat)); return n >= 200 ? gameHit(`${n} spectator messages`) : []; } },
  { id: 1777, name: "Calm Under Fire", desc: "Player wrote nothing for the whole game and won as MVP by damage dealt.", need: "chat",
    check: (F) => needWinner(F, () => endstats(F, () => { const t = top(withStats(F), (p) => st(p).damageDealt); return t && t.best.won && t.best.chat.length === 0 && !t.best.ai ? [{ player: t.best, text: `the game's top damage (${k(t.value)}), not a word written` }] : []; })) },
  { id: 1778, name: "Commentator", desc: "A spectator wrote >= 50 messages.", need: "chat",
    check: (F) => F.spectators.filter((s) => s.chat >= 50).map((s) => ({ text: `${s.name}, watching, wrote ${s.chat} messages` })) },
  { id: 1780, name: "Team Meeting", desc: "Ally chat had >= 5 messages from >= 4 different players within 30 s.", need: "chat",
    check: (F) => F.sides.flatMap((s) => { const lines = s.players.flatMap((p) => p.chat.filter((c) => c.dest === "ally").map((c) => ({ f: c.f, p }))).sort((a, b) => a.f - b.f); for (let i = 0; i < lines.length; i++) { const w = lines.filter((x) => x.f >= lines[i].f && x.f <= lines[i].f + 30 * FPS); if (w.length >= 5 && new Set(w.map((x) => x.p)).size >= 4) return [{ side: s, text: `${w.length} messages from ${new Set(w.map((x) => x.p)).size} players at ${clock(lines[i].f)}`, f: lines[i].f }]; } return []; }) },
  { id: 1783, name: "Polite Opponents", desc: "Both sides exchanged 'gl' and 'gg' in all-chat.", need: "chat",
    check: (F) => { const t = two(F); if (!t) return []; const has = (s: Side, re: (x: string) => boolean) => s.players.some((p) => p.chat.some((c) => c.dest === "all" && re(c.text))); return t.every((s) => has(s, isGL) && has(s, isGG)) ? gameHit("gl at the start and gg at the end, from both sides") : []; } },
  { id: 1784, name: "Cursed Word", desc: "Someone wrote 'easy' in all-chat and their side lost.", need: "chat",
    check: (F) => needWinner(F, () => per(humans(F).filter((p) => p.won === false), (p) => { const c = p.chat.find((x) => x.dest === "all" && /\b(easy|ez|ezpz)\b/i.test(x.text)); return c ? `"${c.text}" at ${clock(c.f)}, then lost` : null; })) },
  { id: 1785, name: "Sorry!", desc: "A player wrote 'sorry' or 'sry' >= 5 times.", need: "chat",
    check: (F) => per(humans(F), (p) => { const n = count(p.chat, (c) => /\b(sorry|sry|soz)\b/i.test(c.text)); return n >= 5 && `${n} apologies`; }) },
  { id: 1787, name: "Shout of Victory", desc: "The first 'gg' of the game came from the losing side >= 2 min before the end.", need: "chat",
    check: (F) => needWinner(F, () => { const gg = humans(F).flatMap((p) => p.chat.filter((c) => isGG(c.text)).map((c) => ({ p, f: c.f }))).sort((a, b) => a.f - b.f)[0]; return gg && gg.p.won === false && gg.f <= F.endF - 120 * FPS ? [{ player: gg.p, text: `gg at ${clock(gg.f)}, ${Math.round((F.endF - gg.f) / FPS / 60)} min before the end`, f: gg.f }] : []; }) },

  // ---- end-of-game totals -------------------------------------------------------
  { id: 153, name: "The Untouchables", desc: "A player wins a 20+ minute game without losing a single unit.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => (F.endMin >= 20 ? per(winners(F).filter((p) => p.stats), (p) => st(p).unitsDied === 0 && "no unit lost") : []))) },
  { id: 160, name: "Perfect KO", desc: "A 1v1 won without the winner losing any unit.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => (isDuel(F) ? per(winners(F).filter((p) => p.stats), (p) => st(p).unitsDied === 0 && "no unit lost") : []))) },
  { id: 174, name: "Agile as a Sparrow", desc: "Winning player lost no unit in a game of 10+ minutes.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => (F.endMin >= 10 ? per(winners(F).filter((p) => p.stats), (p) => st(p).unitsDied === 0 && "no unit lost") : []))) },
  { id: 562, name: "Human Wave", desc: "A side wins after losing three times as many units as it killed (count, not metal).", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => { const w = winner(F); if (!w) return []; const d = sideTotal(w, "unitsDied"), kk = sideTotal(w, "unitsKilled"); return d >= 3 * kk && d > 0 ? [{ side: w, text: `lost ${d} units, killed ${kk}` }] : []; })) },
  { id: 563, name: "Carnage", desc: "One player kills 1000 enemy units in one game.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsKilled >= 1000 && `${st(p).unitsKilled} kills`)) },
  { id: 730, name: "Unit Preservation", desc: "Winner's losses are under 10% of the loser's in a 20+ min game.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => { const w = winner(F); if (!w || !two(F) || F.endMin < 20) return []; const a = sideTotal(w, "unitsDied"), b = sideTotal(otherSide(F, w), "unitsDied"); return a < 0.1 * b ? [{ side: w, text: `lost ${a} units against ${b}` }] : []; })) },
  { id: 754, name: "Star Pupil", desc: "A player under 5 hours of play time (rank 0) is on the winning side and dealt the most damage on it.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => { const w = winner(F); if (!w) return []; const t = top(w.players.filter((p) => p.stats), (p) => st(p).damageDealt); return t && t.best.rank === 0 ? [{ player: t.best, text: `rank 0 and ${k(t.value)} damage, the side's most` }] : []; })) },
  { id: 785, name: "Pacifist Economist", desc: "A player on the winning side whose units destroyed nothing but who produced the most metal on it.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => { const w = winner(F); if (!w || w.players.length < 2) return []; const t = top(w.players.filter((p) => p.stats), (p) => st(p).metalProduced); return t && st(t.best).unitsKilled === 0 ? [{ player: t.best, text: `${k(t.value)} metal produced, no kills` }] : []; })) },
  { id: 786, name: "Did Everything", desc: "Top of their side in metal produced, damage dealt and units built, all at once.", need: "endstats",
    check: (F) => endstats(F, () => F.sides.filter((s) => s.players.length >= 2).flatMap((s) => { const ps = s.players.filter((p) => p.stats); const a = top(ps, (p) => st(p).metalProduced), b = top(ps, (p) => st(p).damageDealt), c = top(ps, (p) => st(p).unitsProduced); return a && b && c && a.best === b.best && b.best === c.best ? [{ player: a.best, text: `${k(a.value)} metal, ${k(b.value)} damage, ${c.value} units: all the side's most` }] : []; })) },
  { id: 787, name: "Underdog", desc: "The lowest-rated player in the lobby (OpenSkill) who dealt the most damage on their side.", need: "endstats",
    check: (F) => endstats(F, () => { const rated = humans(F).filter((p) => Number.isFinite(p.skill)); const lo = top(rated, (p) => -p.skill); if (!lo || -lo.value === -lo.next) return []; const s = sideOf(F, lo.best); if (s.players.length < 2) return []; const t = top(s.players.filter((p) => p.stats), (p) => st(p).damageDealt); return t?.best === lo.best ? [{ player: lo.best, text: `rated ${rating(lo.best)}, the lobby's lowest, and the side's top damage (${k(t.value)})` }] : []; }) },
  { id: 821, name: "Dead God", desc: "A player is top in kills, economy and units built at once at the end.", need: "endstats",
    check: (F) => endstats(F, () => { const ps = withStats(F); const a = top(ps, (p) => st(p).unitsKilled), b = top(ps, (p) => st(p).metalProduced), c = top(ps, (p) => st(p).unitsProduced); return ps.length >= 4 && a && b && c && a.best === b.best && b.best === c.best ? [{ player: a.best, text: `the game's most kills (${a.value}), metal (${k(b.value)}) and units built (${c.value})` }] : []; }) },
  { id: 825, name: "Good Shepherd", desc: "A side wins with its lowest-rated player top in kills.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => { const w = winner(F); if (!w || w.players.length < 2) return []; const lo = top(w.players.filter((p) => Number.isFinite(p.skill)), (p) => -p.skill), t = top(w.players.filter((p) => p.stats), (p) => st(p).unitsKilled); return lo && t && lo.best === t.best ? [{ player: lo.best, text: `rated ${rating(lo.best)}, the side's lowest, with its most kills (${t.value})` }] : []; })) },
  { id: 957, name: "Anyone Order a Pizza?", desc: "A player finishes 1000+ units total in one game.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsProduced >= 1000 && `${st(p).unitsProduced} units built`)) },
  { id: 1154, name: "Pantheon", desc: "Highest-rated player who also had the most kills and the most metal spent.", need: "endstats",
    check: (F) => endstats(F, () => { const hi = top(humans(F).filter((p) => Number.isFinite(p.skill)), (p) => p.skill), a = top(withStats(F), (p) => st(p).unitsKilled), b = top(withStats(F), (p) => st(p).metalUsed); return hi && a && b && hi.best === a.best && a.best === b.best && playerCount(F) >= 4 ? [{ player: hi.best, text: `rated ${rating(hi.best)}, ${a.value} kills, ${k(b.value)} metal spent: all the game's most` }] : []; }) },
  { id: 1171, name: "Annihilation", desc: "A game in which 5000+ units died.", need: "endstats",
    check: (F) => endstats(F, () => { const n = sum(withStats(F).map((p) => st(p).unitsDied)); return n >= 5000 ? gameHit(`${n} units died`) : []; }) },
  { id: 1217, name: "Mission Casualties", desc: "A game in which 3000 or more units die in total.", need: "endstats",
    check: (F) => endstats(F, () => { const n = sum(withStats(F).map((p) => st(p).unitsDied)); return n >= 3000 ? gameHit(`${n} units died`) : []; }) },
  { id: 1222, name: "Raptor Exterminator", desc: "In a Raptors game, a player kills 2000 raptors (tiers at 500/2000/5000).", need: "endstats",
    check: (F) => { if (!F.demo.teams.some((t) => t.ai && /raptor|chicken/i.test(t.ai))) return []; return endstats(F, () => per(humans(F).filter((p) => p.stats), (p) => { const n = st(p).unitsKilled; return n >= 500 && `${n} raptors (${n >= 5000 ? "gold" : n >= 2000 ? "silver" : "bronze"} tier)`; })); } },
  { id: 1250, name: "Scrapper", desc: "A side destroys >= 1000 units in one game.", need: "endstats",
    check: (F) => endstats(F, () => F.sides.filter((s) => sideTotal(s, "unitsKilled") >= 1000).map((s) => ({ side: s, text: `${sideTotal(s, "unitsKilled")} kills` }))) },
  { id: 1256, name: "Grim Reaper", desc: "One player's units kill 500 enemy units in one game.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsKilled >= 500 && `${st(p).unitsKilled} kills`)) },
  { id: 1268, name: "Body Bagger", desc: "One player's kills exceed 50% of all enemy units their side destroyed, in a 4+ player game.", need: "endstats",
    check: (F) => endstats(F, () => (playerCount(F) >= 4 ? per(withStats(F), (p) => { const s = sideTotal(sideOf(F, p), "unitsKilled"); return sideOf(F, p).players.length >= 2 && s > 0 && st(p).unitsKilled > 0.5 * s && `${st(p).unitsKilled} of the side's ${s} kills`; }) : [])) },
  { id: 1277, name: "Pacifist Mech", desc: "A player on the winning side who killed under 3 enemy units in a game of 20+ min.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => (F.endMin >= 20 ? per(winners(F).filter((p) => p.stats), (p) => st(p).unitsKilled < 3 && `${st(p).unitsKilled} kills`) : []))) },
  { id: 1302, name: "Spread Managed Democracy", desc: "A player kills 150+ enemy units in one game.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsKilled >= 150 && `${st(p).unitsKilled} kills`)) },
  { id: 1308, name: "Pile 'Em Up", desc: "A side kills 500+ units in one game.", need: "endstats",
    check: (F) => endstats(F, () => F.sides.filter((s) => sideTotal(s, "unitsKilled") >= 500).map((s) => ({ side: s, text: `${sideTotal(s, "unitsKilled")} kills` }))) },
  { id: 1354, name: "Explore, Expand, Exploit", desc: "A player produces 100k+ metal in one game.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).metalProduced >= 1e5 && `${k(st(p).metalProduced)} metal`)) },
  { id: 1480, name: "Golden Spurs", desc: "A player gives away 50+ units to allies in one game.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsSent >= 50 && `${st(p).unitsSent} units given`)) },
  { id: 1485, name: "Economy of Scale", desc: "One player produces 150k metal in a single game.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).metalProduced >= 1.5e5 && `${k(st(p).metalProduced)} metal`)) },
  { id: 1494, name: "Command Economy", desc: "A player spends 120k metal on builds in one game.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).metalUsed >= 1.2e5 && `${k(st(p).metalUsed)} metal spent`)) },
  { id: 1524, name: "Legions", desc: "A player finishes >= 600 units in one game.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsProduced >= 600 && `${st(p).unitsProduced} units`)) },
  { id: 1551, name: "Gladiator", desc: "Highest-OpenSkill player in the game who also carried the most kills.", need: "endstats",
    check: (F) => endstats(F, () => { const hi = top(humans(F).filter((p) => Number.isFinite(p.skill)), (p) => p.skill), a = top(withStats(F), (p) => st(p).unitsKilled); return playerCount(F) >= 4 && hi && a && hi.best === a.best ? [{ player: hi.best, text: `rated ${rating(hi.best)}, ${a.value} kills` }] : []; }) },
  { id: 1576, name: "Top Producer", desc: "The player who produced the most metal in the game, if at least 1.5x the next player.", need: "endstats",
    check: (F) => endstats(F, () => { const t = top(withStats(F), (p) => st(p).metalProduced); return t && t.value >= 1.5 * t.next && t.next > 0 ? [{ player: t.best, text: `${k(t.value)} metal, next ${k(t.next)}` }] : []; }) },
  { id: 1596, name: "Thanatos Race", desc: "The two allies with the closest kill counts (within 2) at the top of the side.", need: "endstats",
    check: (F) => endstats(F, () => F.sides.flatMap((s) => { const ps = s.players.filter((p) => p.stats).sort((a, b) => st(b).unitsKilled - st(a).unitsKilled); return ps.length >= 2 && st(ps[0]).unitsKilled >= 20 && st(ps[0]).unitsKilled - st(ps[1]).unitsKilled <= 2 ? [{ side: s, text: `${ps[0].name} ${st(ps[0]).unitsKilled} kills, ${ps[1].name} ${st(ps[1]).unitsKilled}` }] : []; })) },
  { id: 1597, name: "Highest GPM", desc: "Player with the highest average metal income per minute; only if 1.5x the next player.", need: "endstats",
    check: (F) => endstats(F, () => { const t = top(withStats(F), (p) => st(p).metalProduced); return t && t.value >= 1.5 * t.next && t.next > 0 ? [{ player: t.best, text: `${k(t.value / F.endMin)} metal a minute, next ${k(t.next / F.endMin)}` }] : []; }) },
  { id: 1618, name: "Splatted Most", desc: "The player with the most kills (by count) in the game.", need: "endstats",
    check: (F) => endstats(F, () => { const t = top(withStats(F), (p) => st(p).unitsKilled); return t && t.value > t.next ? [{ player: t.best, text: `${t.value} kills` }] : []; }) },
  { id: 1644, name: "All Bark and All Bite", desc: "Player dealt >= 5x the damage they received and >= 200k damage.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).damageDealt >= 2e5 && st(p).damageDealt >= 5 * st(p).damageReceived && `${k(st(p).damageDealt)} dealt, ${k(st(p).damageReceived)} taken`)) },
  { id: 1645, name: "Damage Sponge", desc: "Player received >= 40% of their whole side's damage in a team game of >= 3 per side.", need: "endstats",
    check: (F) => endstats(F, () => (two(F) && F.sides.every((s) => s.players.length >= 3) ? per(withStats(F), (p) => { const s = sideTotal(sideOf(F, p), "damageReceived"); return s > 0 && st(p).damageReceived >= 0.4 * s && `${Math.round((100 * st(p).damageReceived) / s)}% of the side's damage taken`; }) : [])) },
  { id: 1646, name: "Kill Leader", desc: "Player's kills are the highest in the game and >= 2x the next player's.", need: "endstats",
    check: (F) => endstats(F, () => { const t = top(withStats(F), (p) => st(p).unitsKilled); return t && t.next > 0 && t.value >= 2 * t.next ? [{ player: t.best, text: `${t.value} kills, next ${t.next}` }] : []; }) },
  { id: 1647, name: "Five Hundred Club", desc: "Player's kills >= 500.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsKilled >= 500 && `${st(p).unitsKilled} kills`)) },
  { id: 1648, name: "Thousand Cuts", desc: "Player's kills >= 1000.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsKilled >= 1000 && `${st(p).unitsKilled} kills`)) },
  { id: 1649, name: "Thousand-Unit Factory", desc: "Player's units produced >= 1000.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsProduced >= 1000 && `${st(p).unitsProduced} units`)) },
  { id: 1650, name: "Workshop of the World", desc: "Player produced >= 35% of the whole game's metal in a game of >= 8 players.", need: "endstats",
    check: (F) => endstats(F, () => { if (playerCount(F) < 8) return []; const all = sum(withStats(F).map((p) => st(p).metalProduced)); return per(withStats(F), (p) => all > 0 && st(p).metalProduced >= 0.35 * all && `${Math.round((100 * st(p).metalProduced) / all)}% of all metal produced`); }) },
  { id: 1651, name: "Overflowing Coffers", desc: "Player's metal storage overflowed by >= 20k.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).metalExcess >= 2e4 && `storage overflowed by ${k(st(p).metalExcess)} metal`)) },
  { id: 1652, name: "Not a Drop Wasted", desc: "Player produced >= 50k metal with under 0.5% of it overflowing.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).metalProduced >= 5e4 && st(p).metalExcess < 0.005 * st(p).metalProduced && `${k(st(p).metalProduced)} metal, ${k(st(p).metalExcess)} overflowed`)) },
  { id: 1653, name: "Power Plant", desc: "Player's energy produced >= 3M.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).energyProduced >= 3e6 && `${k(st(p).energyProduced)} energy`)) },
  { id: 1654, name: "Grid Dumper", desc: "Player's energy overflow >= 50% of their energy produced and >= 500k.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).energyExcess >= 5e5 && st(p).energyExcess >= 0.5 * st(p).energyProduced && `${k(st(p).energyExcess)} of ${k(st(p).energyProduced)} energy overflowed`)) },
  { id: 1655, name: "The Banker", desc: "Player sent >= 50% of the metal they produced to allies, and >= 20k.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).metalSent >= 2e4 && st(p).metalSent >= 0.5 * st(p).metalProduced && `sent ${k(st(p).metalSent)} of ${k(st(p).metalProduced)} metal`)) },
  { id: 1656, name: "Sugar Daddy", desc: "Player sent the most metal+energy in the game and >= 3x what they received.", need: "endstats",
    check: (F) => endstats(F, () => { const t = top(withStats(F), (p) => st(p).metalSent + st(p).energySent); if (!t || t.value <= 0) return []; const r = st(t.best).metalReceived + st(t.best).energyReceived; return t.value >= 3 * r ? [{ player: t.best, text: `sent ${k(t.value)}, received ${k(r)}` }] : []; }) },
  { id: 1657, name: "Kept Alive", desc: "Player's metal received >= their own metal produced and >= 20k: funded by allies.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).metalReceived >= 2e4 && st(p).metalReceived >= st(p).metalProduced && `received ${k(st(p).metalReceived)}, produced ${k(st(p).metalProduced)}`)) },
  { id: 1659, name: "Inheritance", desc: "Player received >= 100 units: they took over a departed teammate's army.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsReceived >= 100 && `${st(p).unitsReceived} units received`)) },
  { id: 1660, name: "Body Snatcher", desc: "Player captured >= 10 units.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsCaptured >= 10 && `${st(p).unitsCaptured} captured`)) },
  { id: 1661, name: "Kidnapped", desc: "Player had >= 5 units captured by the enemy.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsOutCaptured >= 5 && `${st(p).unitsOutCaptured} units captured from them`)) },
  { id: 1662, name: "Spend It All", desc: "Player spent >= 98% of the metal they produced and received over a game >= 20 min.", need: "endstats",
    check: (F) => endstats(F, () => (F.endMin >= 20 ? per(withStats(F), (p) => { const inc = st(p).metalProduced + st(p).metalReceived; return inc > 1000 && st(p).metalUsed >= 0.98 * inc && `spent ${Math.round((100 * st(p).metalUsed) / inc)}%`; }) : [])) },
  { id: 1664, name: "Cost Effective", desc: "Player's damage dealt per unit lost is the best in the game and >= 3x their side's average.", need: "endstats",
    check: (F) => endstats(F, () => { const eff = (p: Player) => st(p).damageDealt / Math.max(1, st(p).unitsDied); const t = top(withStats(F), eff); if (!t) return []; const s = sideOf(F, t.best).players.filter((p) => p.stats); const a = avg(s.map(eff)); return s.length >= 2 && t.value >= 3 * a ? [{ player: t.best, text: `${k(t.value)} damage per unit lost, the side averaged ${k(a)}` }] : []; }) },
  { id: 1665, name: "Kamikaze Squadron", desc: "Player lost >= 2x as many units as they killed, with >= 300 lost.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).unitsDied >= 300 && st(p).unitsDied >= 2 * st(p).unitsKilled && `lost ${st(p).unitsDied}, killed ${st(p).unitsKilled}`)) },
  { id: 1666, name: "Untouchable Base", desc: "Player lost no unit in a game >= 15 min where their side won.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => (F.endMin >= 15 ? per(winners(F).filter((p) => p.stats), (p) => st(p).unitsDied === 0 && "no unit lost") : []))) },
  { id: 1667, name: "Pure Economy", desc: "Player in a winning team dealt < 1% of their side's damage and sent the most metal.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => { const w = winner(F); if (!w || w.players.length < 2) return []; const ps = w.players.filter((p) => p.stats); const t = top(ps, (p) => st(p).metalSent); const d = sideTotal(w, "damageDealt"); return t && t.value > 0 && d > 0 && st(t.best).damageDealt < 0.01 * d ? [{ player: t.best, text: `sent ${k(t.value)} metal, dealt ${((100 * st(t.best).damageDealt) / d).toFixed(1)}% of the damage` }] : []; })) },
  { id: 1668, name: "Heavy Hitters", desc: "The winning side dealt <= 60% of the losing side's damage: won while outdamaged.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => { const w = winner(F); if (!w || !two(F)) return []; const a = sideTotal(w, "damageDealt"), b = sideTotal(otherSide(F, w), "damageDealt"); return b > 0 && a <= 0.6 * b ? [{ side: w, text: `dealt ${k(a)} against ${k(b)}` }] : []; })) },
  { id: 1669, name: "Lopsided", desc: "Winning side's units lost <= 15% of the losing side's.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => { const w = winner(F); if (!w || !two(F)) return []; const a = sideTotal(w, "unitsDied"), b = sideTotal(otherSide(F, w), "unitsDied"); return b >= 20 && a <= 0.15 * b ? [{ side: w, text: `lost ${a} units against ${b}` }] : []; })) },
  { id: 1670, name: "Equal Exchange", desc: "Both sides' total damage taken within 3% of each other in a game >= 30 min.", need: "endstats",
    check: (F) => endstats(F, () => { const t = two(F); if (!t || F.endMin < 30) return []; const a = sideTotal(t[0], "damageReceived"), b = sideTotal(t[1], "damageReceived"); return Math.abs(a - b) <= 0.03 * Math.max(a, b) ? gameHit(`${k(a)} against ${k(b)} damage taken`) : []; }) },
  { id: 1671, name: "Total War", desc: "Game's total units lost across all teams >= 10,000.", need: "endstats",
    check: (F) => endstats(F, () => { const n = sum(withStats(F).map((p) => st(p).unitsDied)); return n >= 1e4 ? gameHit(`${n} units died`) : []; }) },
  { id: 1672, name: "Billion Damage", desc: "Sum of damage dealt across the game >= 100M.", need: "endstats",
    check: (F) => endstats(F, () => { const n = sum(withStats(F).map((p) => st(p).damageDealt)); return n >= 1e8 ? gameHit(`${k(n)} damage`) : []; }) },
  { id: 1673, name: "Carry", desc: "On the winning side, one player dealt >= 50% of the side's damage in a team of >= 4.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => { const w = winner(F); if (!w || w.players.length < 4) return []; const d = sideTotal(w, "damageDealt"); return per(w.players.filter((p) => p.stats), (p) => d > 0 && st(p).damageDealt >= 0.5 * d && `${Math.round((100 * st(p).damageDealt) / d)}% of the side's damage`); })) },
  { id: 1674, name: "Pocket Economy", desc: "A player who dealt < 5% of their side's damage produced >= 35% of its metal.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => { const s = sideOf(F, p); if (s.players.length < 2) return null; const d = sideTotal(s, "damageDealt"), m = sideTotal(s, "metalProduced"); return d > 0 && m > 0 && st(p).damageDealt < 0.05 * d && st(p).metalProduced >= 0.35 * m && `${Math.round((100 * st(p).metalProduced) / m)}% of the side's metal, ${((100 * st(p).damageDealt) / d).toFixed(1)}% of its damage`; })) },
  { id: 1675, name: "Solar Flare", desc: "Player's energy produced is >= 20x their metal produced (a pure energy role).", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).metalProduced > 0 && st(p).energyProduced >= 20 * st(p).metalProduced && st(p).energyProduced >= 1e5 && `${k(st(p).energyProduced)} energy to ${k(st(p).metalProduced)} metal`)) },
  { id: 1676, name: "Metal Baron", desc: "Player's metal produced is the highest in a game of >= 12 players and >= 1.5x the second.", need: "endstats",
    check: (F) => endstats(F, () => { if (playerCount(F) < 12) return []; const t = top(withStats(F), (p) => st(p).metalProduced); return t && t.next > 0 && t.value >= 1.5 * t.next ? [{ player: t.best, text: `${k(t.value)} metal, next ${k(t.next)}` }] : []; }) },
  { id: 1677, name: "Middleman", desc: "Player both received and sent >= 20k metal: resources passed through them.", need: "endstats",
    check: (F) => endstats(F, () => per(withStats(F), (p) => st(p).metalReceived >= 2e4 && st(p).metalSent >= 2e4 && `received ${k(st(p).metalReceived)}, sent ${k(st(p).metalSent)}`)) },
  { id: 1678, name: "Quality over Quantity", desc: "Player dealt the most damage in the game while building the fewest units on their side.", need: "endstats",
    check: (F) => endstats(F, () => { const t = top(withStats(F), (p) => st(p).damageDealt); if (!t) return []; const s = sideOf(F, t.best).players.filter((p) => p.stats); const lo = top(s, (p) => -st(p).unitsProduced); return s.length >= 2 && lo?.best === t.best && -lo.value < -lo.next ? [{ player: t.best, text: `the game's top damage (${k(t.value)}) from ${st(t.best).unitsProduced} units, the side's fewest` }] : []; }) },
  { id: 1679, name: "Swarm Production", desc: "Player's units produced >= 3x anyone else's in the game.", need: "endstats",
    check: (F) => endstats(F, () => { const t = top(withStats(F), (p) => st(p).unitsProduced); return t && t.next > 0 && t.value >= 3 * t.next ? [{ player: t.best, text: `${t.value} units, next ${t.next}` }] : []; }) },
  { id: 1680, name: "Nothing Built", desc: "Player built <= 5 units in a game >= 15 min while still dealing >= 10% of their side's damage.", need: "endstats",
    check: (F) => endstats(F, () => (F.endMin >= 15 ? per(withStats(F), (p) => { const d = sideTotal(sideOf(F, p), "damageDealt"); return st(p).unitsProduced <= 5 && d > 0 && st(p).damageDealt >= 0.1 * d && `${st(p).unitsProduced} units built, ${Math.round((100 * st(p).damageDealt) / d)}% of the side's damage`; }) : [])) },
  { id: 1683, name: "Shared Wealth", desc: "Every player on the winning side sent and received >= 5k metal: a fully pooled economy.", need: "endstats",
    check: (F) => needWinner(F, () => endstats(F, () => { const w = winner(F); return w && w.players.length >= 2 && w.players.every((p) => p.stats && st(p).metalSent >= 5000 && st(p).metalReceived >= 5000) ? [{ side: w, text: "every player sent and received 5k+ metal" }] : []; })) },
  { id: 1684, name: "Self-Sufficient", desc: "In a team game, a player sent and received 0 metal, 0 energy and 0 units.", need: "endstats",
    check: (F) => endstats(F, () => (isTeamGame(F) ? per(withStats(F), (p) => { const s = st(p); return s.metalSent + s.metalReceived + s.energySent + s.energyReceived + s.unitsSent + s.unitsReceived === 0 && "nothing given, nothing taken"; }) : [])) },
  { id: 1868, name: "Outclassed and Outscored", desc: "Lowest-rated player in the game had the highest damage dealt.", need: "endstats",
    check: (F) => endstats(F, () => { const lo = top(humans(F).filter((p) => Number.isFinite(p.skill)), (p) => -p.skill), t = top(withStats(F), (p) => st(p).damageDealt); return playerCount(F) >= 4 && lo && t && lo.best === t.best ? [{ player: lo.best, text: `rated ${rating(lo.best)}, the lowest, with the most damage (${k(t.value)})` }] : []; }) },
  { id: 1869, name: "Rookie Economist", desc: "Rank-0 player produced the most metal on their side.", need: "endstats",
    check: (F) => endstats(F, () => F.sides.filter((s) => s.players.length >= 2).flatMap((s) => { const t = top(s.players.filter((p) => p.stats), (p) => st(p).metalProduced); return t && t.best.rank === 0 ? [{ player: t.best, text: `rank 0, ${k(t.value)} metal, the side's most` }] : []; })) },
  { id: 1870, name: "Punching Up", desc: "Player dealt more damage than every higher-rated player (>= 8 players, they are in the bottom quarter by rating).", need: "endstats",
    check: (F) => endstats(F, () => { const rated = humans(F).filter((p) => Number.isFinite(p.skill) && p.stats).sort((a, b) => a.skill - b.skill); if (rated.length < 8) return []; const q = Math.floor(rated.length / 4); return per(rated.slice(0, q), (p) => rated.filter((x) => x.skill > p.skill).every((x) => st(x).damageDealt < st(p).damageDealt) && `rated ${rating(p)}, out-damaged every higher-rated player`); }) },

  // ---- orders ------------------------------------------------------------------
  { id: 208, name: "Improvised Carpentry", desc: "A player wins without building a single metal extractor.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => per(winners(F).filter((p) => p.cmds.length), (p) => builds(p, isMex).length === 0 && "no metal extractor ordered"))) },
  { id: 224, name: "Slaughterhouse", desc: "A player self-destructs 20 or more of their own units within 10 seconds.", need: "orders",
    check: (F) => per(F.players, (p) => { const b = selfdBurst(p, 10 * FPS); return b.n >= 20 && `${b.n} units at ${clock(b.f)}`; }, (p) => selfdBurst(p, 10 * FPS).f) },
  { id: 251, name: "Less Is More", desc: "Side wins while having fewer players (after leaves/resigns) than the enemy for the last 25% of the game.", need: "orders",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w || !two(F)) return []; const h = shortHanded(F, w); return h.since >= 0 && h.since <= 0.75 * F.endF ? [{ side: w, text: `a player short from ${clock(h.since)} to the end`, f: h.since }] : []; }) },
  { id: 255, name: "Make It Quick", desc: "A game won before any player finished a tier-2 factory.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => (F.players.every((p) => t2At(F, p) < 0) ? gameHit(`over at ${mins(F)} with no T2 factory`) : []))) },
  { id: 267, name: "Big Red Button", desc: "A player self-destructs >= 10 units within 10 s.", need: "orders",
    check: (F) => per(F.players, (p) => { const b = selfdBurst(p, 10 * FPS); return b.n >= 10 && `${b.n} units at ${clock(b.f)}`; }, (p) => selfdBurst(p, 10 * FPS).f) },
  { id: 291, name: "Speed Climber", desc: "A 1v1 won by commander kill under 5 minutes.", need: "orders",
    check: (F) => needWinner(F, () => { const w = winner(F); return w && isDuel(F) && byElimination(F) && F.endMin < 5 ? [{ player: w.players[0], text: `no resign, over at ${mins(F)}` }] : []; }) },
  { id: 434, name: "Suit Only", desc: "A player wins having built nothing but their commander's own construction and turrets: no factory ever ordered.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => per(winners(F).filter((p) => p.cmds.length), (p) => builds(p, isFactory).length === 0 && "no factory ordered"))) },
  { id: 473, name: "Hold My Primary", desc: "A player wins without building any combat unit (eco/defences only, the commander does the rest).", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => per(winners(F).filter((p) => p.cmds.length), (p) => queued(p, isCombat) <= 0 && "no combat unit queued"))) },
  { id: 527, name: "Fast Food", desc: "A winning player built no energy-producing building (relied on commander/allies).", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => per(winners(F).filter((p) => p.cmds.length), (p) => builds(p, isEnergy).length === 0 && "no energy building ordered"))) },
  { id: 567, name: "Cross-Faction", desc: "A player builds units of two different factions in one game (through a given or captured constructor).", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const fs = new Set([...p.builds.map((b) => faction(b.def)), ...p.queue.map((q) => faction(q.def))].filter(Boolean)); return fs.size >= 2 && `built ${[...fs].map((x) => ({ arm: "Armada", cor: "Cortex", leg: "Legion" })[x] ?? x).join(" and ")}`; })) },
  { id: 598, name: "Raining Bullets", desc: "A side wins a game of >= 20 min without building a single static defence.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => { const w = winner(F); return w && F.endMin >= 20 && w.players.every((p) => builds(p, isDefence).length === 0) ? [{ side: w, text: "no static defence ordered" }] : []; })) },
  { id: 613, name: "The Path Not Taken", desc: "A side wins a 25+ min game without ever building a T2 factory.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => { const w = winner(F); return w && F.endMin >= 25 && w.players.every((p) => t2At(F, p) < 0) ? [{ side: w, text: `${mins(F)} without a T2 factory` }] : []; })) },
  { id: 661, name: "Beginner's Luck", desc: "A side wins using only tech-1 units (no T2 factory finished).", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => { const w = winner(F); return w && w.players.every((p) => t2At(F, p) < 0) ? [{ side: w, text: "no T2 factory" }] : []; })) },
  { id: 670, name: "Guppy", desc: "A player builds three different experimentals in one game.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const d = new Set(p.queue.filter((q) => q.n > 0 && isExperimental(q.def)).map((q) => q.def.humanName ?? q.def.name)); return d.size >= 3 && [...d].join(", "); })) },
  { id: 677, name: "Insanity", desc: "A side wins with fewer players than the enemy (after a leaver) for 10+ minutes.", need: "orders",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w || !two(F)) return []; const h = shortHanded(F, w); return h.frames >= 600 * FPS ? [{ side: w, text: `${Math.round(h.frames / FPS / 60)} min a player short` }] : []; }) },
  { id: 701, name: "Getting Back to Nature", desc: "Win with your side never building beyond T1.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => { const w = winner(F); return w && w.players.every((p) => p.builds.every((b) => tech(b.def) < 2) && p.queue.every((q) => tech(q.def) < 2)) ? [{ side: w, text: "nothing of tech 2 or above ordered" }] : []; })) },
  { id: 723, name: "Great Walls", desc: "A player builds 200+ wall segments (dragon's teeth/fortification walls).", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isWall).length >= 200 && `${builds(p, isWall).length} wall segments`)) },
  { id: 724, name: "All In", desc: "A winning player built no second factory all game.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => per(winners(F).filter((p) => p.cmds.length), (p) => builds(p, isFactory).length === 1 && `one factory: ${builds(p, isFactory)[0].def.humanName}`))) },
  { id: 725, name: "Titanic Terror", desc: "Both factions' flagship experimentals appear in the same game (Titan and Juggernaut).", need: "orders",
    check: (F) => orders(F, () => { const all = F.players.flatMap((p) => p.queue.filter((q) => q.n > 0).map((q) => q.def.name.replace(/_scav$/, ""))); return all.includes("armbanth") && all.includes("corkorg") ? gameHit("a Titan and a Juggernaut were both ordered") : []; }) },
  { id: 1153, name: "Surrender at 20", desc: "Side resigns at exactly minute 20-21.", need: "orders",
    check: (F) => losers(F).flatMap((s) => { const r = Math.min(...s.players.map((p) => (p.resignedAt >= 0 ? p.resignedAt : Infinity))); return r >= 1200 * FPS && r < 1260 * FPS ? [{ side: s, text: `resigned at ${clock(r)}`, f: r }] : []; }) },
  { id: 1238, name: "Before Our Time", desc: "A player builds a T2 unit before minute 4.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const q = p.queue.find((x) => x.n > 0 && tech(x.def) >= 2 && x.f < 240 * FPS); return q && `${q.def.humanName} queued at ${clock(q.f)}`; }, (p) => p.queue.find((x) => x.n > 0 && tech(x.def) >= 2 && x.f < 240 * FPS)?.f)) },
  { id: 1283, name: "Technophobia", desc: "A side wins without ever building an air unit.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => { const w = winner(F); return w && w.players.every((p) => queued(p, isAir) <= 0 && builds(p, isAirFactory).length === 0) ? [{ side: w, text: "no aircraft, no air factory" }] : []; })) },
  { id: 1291, name: "Minimalist", desc: "A player wins having built 5 or fewer distinct unit types (economy excluded).", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => per(winners(F).filter((p) => p.cmds.length), (p) => { const d = new Set([...p.builds.map((b) => b.def), ...p.queue.filter((q) => q.n > 0).map((q) => q.def)].filter((x) => !isEco(x)).map((x) => x.id)); return d.size <= 5 && `${d.size} kinds of non-economy units`; }))) },
  { id: 1292, name: "Who Needs Relics?", desc: "A player wins with a single factory the entire game.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => per(winners(F).filter((p) => p.cmds.length), (p) => builds(p, isFactory).length === 1 && `one factory: ${builds(p, isFactory)[0].def.humanName}`))) },
  { id: 1317, name: "Spore Loser", desc: "Win a game without ever building a nano turret.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => { const w = winner(F); return w && w.players.every((p) => builds(p, isNano).length === 0) ? [{ side: w, text: "no construction turret ordered" }] : []; })) },
  { id: 1351, name: "Who Needs Infantry?", desc: "A winning player built no bots (only vehicles/air/ships).", need: "orders",
    check: () => skip("the unit-def table does not say which units are bots") },
  { id: 1358, name: "Expand Everywhere", desc: "A player builds mexes in every quarter of the map.", need: "orders",
    check: (F) => orders(F, () => { if (!F.map) return skip("the map's size is not known"); const { w, h } = F.map; return per(F.players, (p) => { const q = new Set(builds(p, isMex).map((b) => `${b.x < w / 2 ? 0 : 1}${b.z < h / 2 ? 0 : 1}`)); return q.size === 4 && `mexes in all four quarters`; }); }) },
  { id: 1370, name: "Engineering Upgrade", desc: "A player builds 3+ factories in the first 3 minutes.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const n = builds(p, isFactory).filter((b) => b.f < 180 * FPS).length; return n >= 3 && `${n} factories ordered by 3:00`; })) },
  { id: 1391, name: "No Towers Needed", desc: "A player wins having built no armed static defence in a game over 20 minutes.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => (F.endMin > 20 ? per(winners(F).filter((p) => p.cmds.length), (p) => builds(p, isDefence).length === 0 && "no static defence ordered") : []))) },
  { id: 1404, name: "Terrif-eyeing", desc: "A player builds 66+ radar towers/jammers/sonar.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isIntel).length >= 66 && `${builds(p, isIntel).length} intel buildings`)) },
  { id: 1405, name: "Ghoul Lumber", desc: "A player builds 30+ energy storages.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isEnergyStorage).length >= 30 && `${builds(p, isEnergyStorage).length} energy storages`)) },
  { id: 1490, name: "Field Marshal", desc: "A player on the winning side built no aircraft and no ships at all in a game over 25 minutes.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => (F.endMin > 25 ? per(winners(F).filter((p) => p.cmds.length), (p) => queued(p, isAir) <= 0 && queued(p, isShip) <= 0 && "no aircraft, no ships") : []))) },
  { id: 1519, name: "Embargo", desc: "A side wins a 30+ min game without building any metal or energy storage.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => { const w = winner(F); return w && F.endMin >= 30 && w.players.every((p) => builds(p, isStorage).length === 0) ? [{ side: w, text: "no storage ordered" }] : []; })) },
  { id: 1532, name: "Pole Position", desc: "The game is decided before any experimental is ordered, in a 20+ minute game.", need: "orders",
    check: (F) => orders(F, () => (F.endMin >= 20 && F.players.every((p) => queued(p, isExperimental) <= 0) ? gameHit(`${mins(F)} without an experimental`) : [])) },
  { id: 1536, name: "Portal Conservation Society", desc: "A player wins having built 5 or fewer factory buildings in total in a 20+ min game.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => (F.endMin >= 20 ? per(winners(F).filter((p) => p.cmds.length), (p) => { const n = builds(p, isFactory).length; return n <= 5 && `${n} factories`; }) : []))) },
  { id: 1565, name: "No Wheels", desc: "A winning side never built a long-range plasma cannon or nuke in a game of 30+ min.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => { const w = winner(F); return w && F.endMin >= 30 && w.players.every((p) => builds(p, (d) => isLRPC(d) || isRapidLRPC(d) || isNukeSilo(d)).length === 0) ? [{ side: w, text: "no long-range cannon, no nuke" }] : []; })) },
  { id: 1642, name: "No Time for Snoozing", desc: "A player starts building within 5 seconds of game start.", need: "orders",
    // BAR's pre-game queue hands the engine every planned opening on the
    // first frames, so only a player who did NOT plan one can earn this.
    check: (F) => orders(F, () => per(humans(F), (p) => p.builds[0] && p.builds[0].f > PREGAME && p.builds[0].f <= 5 * FPS && `first build order at ${clock(p.builds[0].f)}, with no pre-game queue`)) },
  { id: 1685, name: "Opening Gambit", desc: "Player's first 5 build orders match a named, common opening.", need: "orders",
    check: (F) => orders(F, () => per(humans(F), (p) => { const seq = firstBuilds(p, 5).join(","); const o = OPENINGS.find((x) => x.seq.test(seq)); return o && `${o.name}: ${p.builds.slice(0, 5).map((b) => b.def.humanName).join(", ")}`; })) },
  { id: 1686, name: "Never Seen Before", desc: "Player's first 6 build orders form a sequence no one has used in the 2-year history.", need: "orders",
    check: () => skip("needs every other game's openings (history)") },
  { id: 1687, name: "Speed Clicker", desc: "Player's actions per minute are the highest in the game and >= 150 averaged over the game.", need: "orders",
    check: (F) => { const t = top(humans(F), (p) => apm(F, p)); return t && t.value >= 150 ? [{ player: t.best, text: `${Math.round(t.value)} actions a minute` }] : []; } },
  { id: 1688, name: "Zen Commander", desc: "Player won with the lowest actions per minute in the game and < 20 a minute.", need: "orders",
    check: (F) => needWinner(F, () => { const t = top(humans(F), (p) => -apm(F, p)); return t && t.best.won && -t.value < 20 ? [{ player: t.best, text: `${Math.round(-t.value)} actions a minute` }] : []; }) },
  { id: 1689, name: "First Order", desc: "Player issued their first command within 1 s of game start, >= 3 s ahead of everyone.", need: "orders",
    check: (F) => { const firsts = humans(F).map((p) => ({ p, f: p.cmds[0]?.f ?? Infinity })).sort((a, b) => a.f - b.f); return firsts.length >= 2 && firsts[0].f <= FPS && firsts[1].f - firsts[0].f >= 3 * FPS ? [{ player: firsts[0].p, text: `first order at ${clock(firsts[0].f)}, next at ${clock(firsts[1].f)}` }] : []; } },
  { id: 1690, name: "Slow Starter", desc: "Player issued no order for the first 60 s of the game and still won.", need: "orders",
    check: (F) => needWinner(F, () => per(humans(F).filter((p) => p.won), (p) => (p.cmds[0]?.f ?? Infinity) >= 60 * FPS && `first order at ${p.cmds[0] ? clock(p.cmds[0].f) : "never"}`)) },
  { id: 1691, name: "Away from Keyboard", desc: "Player issued no orders for >= 5 consecutive minutes mid-game and came back to play.", need: "orders",
    check: (F) => per(humans(F), (p) => { if (p.cmds.length < 2) return null; const g = longestGap(p.acts.map((c) => c.f), p.cmds[0].f, last(p.cmds).f); return g.len >= 300 * FPS && `took a ${Math.round(g.len / FPS / 60)}-minute break from ${clock(g.at)}`; }, (p) => p.cmds.length ? longestGap(p.acts.map((c) => c.f), p.cmds[0].f, last(p.cmds).f).at : undefined) },
  { id: 1692, name: "Tea Break", desc: "The game was paused for a total of >= 5 minutes.", need: "orders",
    check: (F) => { const n = sum(F.pauses.map((x) => x.end - x.start)); return n >= 300 ? gameHit(`paused ${Math.round(n / 60)} minutes in all`) : []; } },
  { id: 1693, name: "Pause Champion", desc: "One player paused the game >= 4 separate times.", need: "orders",
    check: (F) => per(humans(F), (p) => { const n = count(F.pauses, (x) => x.player === p.id); return n >= 4 && `${n} pauses`; }) },
  { id: 1694, name: "Mex Grabber", desc: "Player ordered >= 12 metal extractors in the first 4 minutes.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const n = builds(p, isMex).filter((b) => b.f < 240 * FPS).length; return n >= 12 && `${n} mexes by 4:00`; })) },
  { id: 1695, name: "Wind Farmer", desc: "Player ordered >= 100 wind turbines over the game.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isWind).length >= 100 && `${builds(p, isWind).length} wind turbines`)) },
  { id: 1696, name: "Solar Enthusiast", desc: "Player ordered >= 60 solar collectors and no wind turbines.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isSolar).length >= 60 && builds(p, isWind).length === 0 && `${builds(p, isSolar).length} solar collectors, no wind`)) },
  { id: 1697, name: "The Great Wall", desc: "Player ordered >= 80 walls/dragon's teeth.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isWall).length >= 80 && `${builds(p, isWall).length} wall segments`)) },
  { id: 1698, name: "Bunker Mentality", desc: "Player ordered >= 40 defensive structures and >= 50% of their build orders were defences.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const n = builds(p, isDefence).length; return n >= 40 && n >= 0.5 * p.builds.length && `${n} of ${p.builds.length} buildings were defences`; })) },
  { id: 1699, name: "Factory Floor", desc: "Player ordered >= 5 different factory types in one game.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const d = new Set(builds(p, isFactory).map((b) => b.def.humanName ?? b.def.name)); return d.size >= 5 && `${d.size} kinds: ${[...d].join(", ")}`; })) },
  { id: 1700, name: "One Lab Wonder", desc: "Player won while ordering exactly one factory all game in a game >= 20 min.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => (F.endMin >= 20 ? per(winners(F).filter((p) => p.cmds.length), (p) => builds(p, isFactory).length === 1 && `one ${builds(p, isFactory)[0].def.humanName}`) : []))) },
  { id: 1701, name: "Infinite Queue", desc: "Player queued >= 500 units in a single factory order batch.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { let best = 0; for (let i = 0; i < p.queue.length; i++) { let n = 0; for (let j = i; j < p.queue.length && p.queue[j].f - p.queue[i].f <= 2 * FPS; j++) if (p.queue[j].def === p.queue[i].def) n += p.queue[j].n; best = Math.max(best, n); } return best >= 500 && `${best} units in one go`; })) },
  { id: 1702, name: "Nuclear Ambitions", desc: "Player ordered a nuclear silo.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const b = builds(p, isNukeSilo)[0]; return b && `${b.def.humanName} at ${clock(b.f)}`; }, (p) => builds(p, isNukeSilo)[0]?.f)) },
  { id: 1703, name: "Doomsday Clock", desc: "Player ordered >= 3 nuclear silos.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isNukeSilo).length >= 3 && `${builds(p, isNukeSilo).length} silos`)) },
  { id: 1704, name: "Shield Up", desc: "Player ordered an anti-nuke before any enemy ordered a nuke silo.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const a = p.builds.find((b) => isAntiNuke(b.def)) ?? p.queue.find((q) => q.n > 0 && isAntiNuke(q.def)); if (!a) return null; const nukes = F.players.filter((x) => x.ally !== p.ally).flatMap((x) => builds(x, isNukeSilo)).map((b) => b.f); return nukes.length > 0 && a.f < Math.min(...nukes) && `anti-nuke at ${clock(a.f)}, the enemy's first silo at ${clock(Math.min(...nukes))}`; })) },
  { id: 1705, name: "Called the Nuke", desc: "Player ordered an anti-nuke within 2 minutes after an enemy ordered a nuke silo.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const nukes = F.players.filter((x) => x.ally !== p.ally).flatMap((x) => builds(x, isNukeSilo)).map((b) => b.f); if (!nukes.length) return null; const n0 = Math.min(...nukes); const a = [...p.builds.filter((b) => isAntiNuke(b.def)), ...p.queue.filter((q) => q.n > 0 && isAntiNuke(q.def))].map((x) => x.f).filter((f) => f >= n0).sort((x, y) => x - y)[0]; return a !== undefined && a - n0 <= 120 * FPS && `anti-nuke ${Math.round((a - n0) / FPS)} s after the enemy's silo`; })) },
  { id: 1706, name: "Experimental Ambition", desc: "Player's build orders include >= 10 experimental units.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => queued(p, isExperimental) >= 10 && `${queued(p, isExperimental)} experimentals queued`)) },
  { id: 1707, name: "Fastest T2", desc: "Player ordered their first T2 factory earlier than anyone in the game, and before 5:00.", need: "orders",
    check: (F) => orders(F, () => { const t = F.players.map((p) => ({ p, b: builds(p, isT2Factory)[0] })).filter((x) => x.b).sort((a, b) => a.b.f - b.b.f); return t[0] && t[0].b.f < 300 * FPS && (!t[1] || t[1].b.f > t[0].b.f) ? [{ player: t[0].p, text: `${t[0].b.def.humanName} ordered at ${clock(t[0].b.f)}`, f: t[0].b.f }] : []; }) },
  { id: 1708, name: "Lightning Tech", desc: "Player ordered a T3 gantry before 12:00, the earliest on record for the map.", need: "orders",
    check: () => skip("needs every other game on the map (history)") },
  { id: 1709, name: "Never Teched", desc: "Player won a game >= 30 min without ever ordering a T2 factory.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => (F.endMin >= 30 ? per(winners(F).filter((p) => p.cmds.length), (p) => builds(p, isT2Factory).length === 0 && "no T2 factory ordered") : []))) },
  { id: 1710, name: "Built at the Front", desc: "Player ordered a factory closer to the enemy start positions than to their own.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const own = startOf(F, p); if (!own) return null; const enemy = F.players.filter((x) => x.ally !== p.ally).map((x) => startOf(F, x)).filter((x): x is [number, number] => !!x); if (!enemy.length) return null; const d = (a: [number, number], x: number, z: number) => Math.hypot(a[0] - x, a[1] - z); const b = builds(p, isFactory).find((f) => Math.min(...enemy.map((e) => d(e, f.x, f.z))) < d(own, f.x, f.z)); return b && `${b.def.humanName} at ${clock(b.f)}, nearer the enemy's start than their own`; }, (p) => builds(p, isFactory)[0]?.f)) },
  { id: 1711, name: "Over the Midline", desc: "Player ordered >= 10 buildings beyond the map's midline toward the enemy.", need: "orders",
    check: (F) => orders(F, () => { const t = two(F); if (!t) return []; const c = t.map((s) => { const ps = s.players.map((p) => startOf(F, p)).filter((x): x is [number, number] => !!x); return ps.length ? [avg(ps.map((x) => x[0])), avg(ps.map((x) => x[1]))] : null; }); if (!c[0] || !c[1]) return []; const [a, b] = c as [number[], number[]]; const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz; if (L === 0) return []; return per(F.players, (p) => { const toward = p.side === 0 ? 1 : -1; const n = count(p.builds, (x) => toward * (((x.x - a[0]) * dx + (x.z - a[1]) * dz) / L - 0.5) > 0); return n >= 10 && `${n} buildings over the middle`; }); }) },
  { id: 1712, name: "Corner Camper", desc: "All of a player's build orders were within 1500 elmos of their start over a game >= 25 min.", need: "orders",
    check: (F) => orders(F, () => (F.endMin >= 25 ? per(F.players, (p) => { const s = startOf(F, p); return s && p.builds.length >= 20 && p.builds.every((b) => Math.hypot(b.x - s[0], b.z - s[1]) <= 1500) && `${p.builds.length} buildings, none beyond 1500 elmos of the start`; }) : [])) },
  { id: 1713, name: "Sprawl", desc: "Player's build orders span >= 60% of the map area (bounding box).", need: "orders",
    check: (F) => orders(F, () => { if (!F.map) return skip("the map's size is not known"); const area = F.map.w * F.map.h; return per(F.players, (p) => { if (p.builds.length < 2) return null; const xs = p.builds.map((b) => b.x), zs = p.builds.map((b) => b.z); const a = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs)); return a >= 0.6 * area && `buildings spread over ${Math.round((100 * a) / area)}% of the map`; }); }) },
  { id: 1714, name: "Self-Destruct Sequence", desc: "Player self-destructed their commander.", need: "orders",
    check: (F) => { if (F.ins?.pov !== "full" || !F.ins.deaths.selfd) return skip("needs a full-view capture's deaths to know which unit was the commander"); return per(F.players, (p) => { const f = commanderSelfd(F, p); return f !== null && f >= 0 && `at ${clock(f)}`; }, (p) => commanderSelfd(F, p) ?? undefined); } },
  { id: 1715, name: "Self-Destruct Spree", desc: "Player ordered self-destruct on >= 30 units within 30 s (not as they left).", need: "orders",
    check: (F) => per(F.players, (p) => { const b = selfdBurst(p, 30 * FPS); if (b.n < 30) return null; if (p.leftAt >= 0 && p.leftAt - b.f <= 90 * FPS) return null; return `${b.n} units at ${clock(b.f)}`; }, (p) => selfdBurst(p, 30 * FPS).f) },
  { id: 1716, name: "Mass Reclaim", desc: "Player issued >= 200 reclaim orders.", need: "orders",
    check: (F) => per(humans(F), (p) => { const n = count(p.acts, (c) => c.id === CMD.reclaim); return n >= 200 && `${n} reclaim orders`; }) },
  { id: 1717, name: "Patrol Planner", desc: "Player issued >= 100 patrol orders.", need: "orders",
    check: (F) => per(humans(F), (p) => { const n = count(p.acts, (c) => c.id === CMD.patrol); return n >= 100 && `${n} patrol orders`; }) },
  { id: 1719, name: "Hold Fire", desc: "Player set hold-fire on units >= 20 times.", need: "orders",
    check: (F) => per(humans(F), (p) => { const n = count(p.acts, (c) => c.id === CMD.fireState && c.params[0] === 0); return n >= 20 && `${n} times`; }) },
  { id: 1720, name: "Micro Manager", desc: "Player issued >= 3000 move orders in a game.", need: "orders",
    check: (F) => per(humans(F), (p) => { const n = count(p.acts, (c) => c.id === CMD.move); return n >= 3000 && `${n} move orders`; }) },
  { id: 1721, name: "Macro Master", desc: "Player issued the most build orders in the game and >= 2x their side's average.", need: "orders",
    check: (F) => orders(F, () => { const nb = (p: Player) => p.builds.length + p.queue.length; const t = top(humans(F), nb); if (!t || t.value === t.next) return []; const s = sideOf(F, t.best).players; const a = avg(s.map(nb)); return s.length >= 2 && t.value >= 2 * a ? [{ player: t.best, text: `${t.value} build orders, the side averaged ${Math.round(a)}` }] : []; }) },
  { id: 1722, name: "Click Storm", desc: "Player's peak 1-minute command count >= 500.", need: "orders",
    check: (F) => per(humans(F), (p) => { const b = maxIn(p.acts.map((c) => c.f), 60 * FPS); return b.n >= 500 && `${b.n} orders in the minute from ${clock(b.f)}`; }, (p) => maxIn(p.acts.map((c) => c.f), 60 * FPS).f) },
  { id: 1723, name: "Selection Juggler", desc: "Player changed selection >= 5000 times.", need: "orders",
    check: (F) => per(humans(F), (p) => p.sel.length >= 5000 && `${p.sel.length} selections`) },
  { id: 1724, name: "The Long Pause", desc: "A single pause lasting >= 3 minutes.", need: "orders",
    check: (F) => F.pauses.filter((x) => x.end - x.start >= 180).slice(0, 1).map((x) => ({ text: `${Math.round((x.end - x.start) / 60)} minutes` })) },
  { id: 1725, name: "Unpause Diplomacy", desc: "The game was paused and unpaused by different players >= 3 times (pause wars).", need: "orders",
    check: (F) => { const n = count(F.pauses, (x) => x.player !== x.unpausedBy); return n >= 3 ? gameHit(`${n} pauses lifted by someone else`) : []; } },
  { id: 1726, name: "Gone Too Soon", desc: "A player left in the first 3 minutes and their team still won.", need: "orders",
    check: (F) => needWinner(F, () => per(humans(F).filter((p) => p.won), (p) => p.leftAt >= 0 && p.leftAt < 180 * FPS && `left at ${clock(p.leftAt)}; the side won anyway`, (p) => p.leftAt)) },
  { id: 1727, name: "Outnumbered and Winning", desc: "A side won after being a player down (a player left or dropped) for >= 10 minutes.", need: "orders",
    check: (F) => needWinner(F, () => { const w = winner(F); if (!w || !two(F)) return []; const h = shortHanded(F, w); return h.frames >= 600 * FPS ? [{ side: w, text: `${Math.round(h.frames / FPS / 60)} min a player down` }] : []; }) },
  { id: 1728, name: "Resign Vote Failed", desc: "A resign vote was called and failed, and that side went on to win.", need: "orders",
    check: (F) => needWinner(F, () => resignVotes(F).filter((v) => v.outcome === "failed").flatMap((v) => { const s = voteSide(F, v.caller); return s?.won ? [{ side: s, text: `vote at ${clock(v.f)} failed`, f: v.f }] : []; }).slice(0, 1)) },
  { id: 1729, name: "Not Yet", desc: "A player voted against resigning, and their side won.", need: "orders",
    check: (F) => needWinner(F, () => { const out: Hit[] = []; for (const v of resignVotes(F)) for (const n of v.no) { const p = F.players.find((x) => x.name === n); if (p?.won && voteSide(F, v.caller) === sideOf(F, p) && !out.some((h) => h.player === p)) out.push({ player: p, text: `voted no at ${clock(v.f)}`, f: v.f }); } return out; }) },
  { id: 1730, name: "The Holdout", desc: "Last player of a resigning side to stay, issuing orders >= 3 minutes after teammates left.", need: "orders",
    check: (F) => losers(F).flatMap((s) => { if (s.players.length < 2) return []; const gone = (p: Player) => Math.min(p.leftAt >= 0 ? p.leftAt : Infinity, p.resignedAt >= 0 ? p.resignedAt : Infinity); const ps = [...s.players].sort((a, b) => gone(b) - gone(a)); const others = Math.max(...ps.slice(1).map(gone)); if (!Number.isFinite(others)) return []; const lastCmd = last(ps[0].cmds)?.f ?? -1; return lastCmd - others >= 180 * FPS ? [{ player: ps[0], text: `still playing ${Math.round((lastCmd - others) / FPS / 60)} min after the last teammate went` }] : []; }) },
  { id: 1731, name: "Graceful Exit", desc: "A side resigned unanimously within 20 s of the first resign vote.", need: "orders",
    check: (F) => { const v = resignVotes(F)[0]; if (!v || v.outcome !== "passed" || v.endF - v.f > 20 * FPS) return []; const s = voteSide(F, v.caller); return s ? [{ side: s, text: `vote passed ${Math.round((v.endF - v.f) / FPS)} s after it was called`, f: v.f }] : []; } },
  { id: 1732, name: "Reconnected", desc: "A player disconnected and came back in the same game, then won.", need: "orders",
    check: (F) => needWinner(F, () => per(humans(F).filter((p) => p.won), (p) => { const l = F.demo.left.find((x) => x.player === p.id && x.reason === 0 && F.demo.rejoined.some((r) => r.player === p.id && r.f > x.f)); return l && `dropped at ${clock(l.f)} and came back`; })) },
  { id: 1734, name: "Thirty Mex Spots", desc: "Player ordered metal extractors on >= 30 distinct spots.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const spots: [number, number][] = []; for (const b of builds(p, isMex)) if (!spots.some((s) => Math.hypot(s[0] - b.x, s[1] - b.z) < 48)) spots.push([b.x, b.z]); return spots.length >= 30 && `${spots.length} spots`; })) },
  { id: 1735, name: "Mex Upgrader", desc: "Player ordered >= 20 T2 metal extractors.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isT2Mex).length >= 20 && `${builds(p, isT2Mex).length} advanced extractors`)) },
  { id: 1736, name: "Fusion Age", desc: "Player ordered a fusion reactor before 10:00.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const b = builds(p, isFusion).find((x) => x.f < 600 * FPS); return b && `${b.def.humanName} at ${clock(b.f)}`; }, (p) => builds(p, isFusion)[0]?.f)) },
  { id: 1737, name: "Converter King", desc: "Player ordered >= 50 energy converters.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isConverter).length >= 50 && `${builds(p, isConverter).length} converters`)) },
  { id: 1738, name: "Three Hundred Wings", desc: "Player's air factory queue orders total >= 300 aircraft.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => queued(p, isAir) >= 300 && `${queued(p, isAir)} aircraft queued`)) },
  { id: 1739, name: "Admiral's Order", desc: "Player queued >= 100 ships.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => queued(p, isShip) >= 100 && `${queued(p, isShip)} ships queued`)) },
  { id: 1740, name: "Artillery Park", desc: "Player ordered >= 5 long-range plasma cannons or >= 2 rapid-fire ones.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const a = builds(p, isLRPC).length, b = builds(p, isRapidLRPC).length; return (a >= 5 || b >= 2) && `${a} long-range cannons, ${b} rapid-fire`; })) },
  { id: 1741, name: "Bertha's Children", desc: "Player's first T2 structure order was a long-range gun.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const b = p.builds.find((x) => tech(x.def) >= 2 && !isFactory(x.def)); return b && (isLRPC(b.def) || isRapidLRPC(b.def)) && `${b.def.humanName} at ${clock(b.f)}`; })) },
  { id: 1742, name: "Unusual Choice", desc: "Player ordered a unit type used in < 1% of games in the 2-year history.", need: "orders",
    check: () => skip("needs every other game's orders (history)") },
  { id: 1743, name: "Spam Specialist", desc: "One unit type accounts for >= 80% of a player's factory queue (>= 100 units).", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const by = new Map<string, number>(); for (const q of p.queue) by.set(q.def.humanName ?? q.def.name, (by.get(q.def.humanName ?? q.def.name) ?? 0) + q.n); const all = sum([...by.values()].filter((x) => x > 0)); const t = top([...by], (x) => x[1]); return t && t.value >= 100 && t.value >= 0.8 * all && `${t.value} ${t.best[0]}, ${Math.round((100 * t.value) / all)}% of the queue`; })) },
  { id: 1744, name: "Variety Pack", desc: "Player queued >= 25 distinct unit types.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const n = new Set(p.queue.filter((q) => q.n > 0).map((q) => q.def.id)).size; return n >= 25 && `${n} kinds of units`; })) },
  { id: 1745, name: "Identical Openings", desc: "Both players in a duel ordered the same first 6 builds.", need: "orders",
    check: (F) => orders(F, () => { if (!isDuel(F)) return []; const [a, b] = F.sides.map((s) => firstBuilds(s.players[0], 6).join(",")); return a && a === b && a.split(",").length === 6 ? gameHit(a.split(",").join(", ")) : []; }) },
  { id: 1748, name: "All-In", desc: "Player issued no build order for >= 5 minutes while issuing >= 200 attack/move orders.", need: "orders",
    check: (F) => orders(F, () => per(humans(F), (p) => { const bf = [...p.builds.map((b) => b.f), ...p.queue.map((q) => q.f)].sort((x, y) => x - y); for (let i = 1; i < bf.length; i++) { if (bf[i] - bf[i - 1] < 300 * FPS) continue; const n = count(p.acts, (c) => c.f > bf[i - 1] && c.f < bf[i] && (c.id === CMD.move || c.id === CMD.attack || c.id === CMD.fight)); if (n >= 200) return `${n} fight orders and no building for ${Math.round((bf[i] - bf[i - 1]) / FPS / 60)} min from ${clock(bf[i - 1])}`; } return null; })) },
  { id: 1749, name: "Nano Forest", desc: "Player ordered >= 30 construction turrets.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isNano).length >= 30 && `${builds(p, isNano).length} construction turrets`)) },
  { id: 1750, name: "Seaplane Gambit", desc: "Player ordered a seaplane platform on a map with water.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const b = builds(p, isSeaplaneFactory)[0]; return b && `${b.def.humanName} at ${clock(b.f)}`; })) },
  { id: 1751, name: "Stealth Mode", desc: "Player ordered >= 3 radar jammers/stealth structures.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isJammer).length >= 3 && `${builds(p, isJammer).length} jammers`)) },
  { id: 1753, name: "Builder Swarm", desc: "Player queued >= 60 construction units.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => queued(p, isConstructor) >= 60 && `${queued(p, isConstructor)} constructors queued`)) },
  { id: 1754, name: "Late Shift", desc: "Player's last command came >= 30 minutes after their last build order: a pure fighting endgame.", need: "orders",
    check: (F) => orders(F, () => per(humans(F), (p) => { const lb = Math.max(-1, ...p.builds.map((b) => b.f), ...p.queue.map((q) => q.f)); const lc = last(p.cmds)?.f ?? -1; return lb >= 0 && lc - lb >= 1800 * FPS && `last build order at ${clock(lb)}, last order at ${clock(lc)}`; })) },
  { id: 1755, name: "Busy to the End", desc: "Player issued an order in the last 1 s before the game ended.", need: "orders",
    check: (F) => per(humans(F), (p) => { const c = last(p.cmds); return c && c.f >= F.endF - FPS && p.leftAt < 0 && p.resignedAt < 0 && `an order at ${clock(c.f)}`; }) },
  { id: 1756, name: "Steady Hands", desc: "Player's actions per minute stayed within ±20% in every 5-minute window of a >= 30 min game.", need: "orders",
    check: (F) => { if (F.endMin < 30) return []; return per(humans(F), (p) => { const pm = perMinute([...p.acts.map((c) => c.f), ...p.sel], F.endF); const w: number[] = []; for (let i = 0; i + 5 <= pm.length; i += 5) w.push(sum(pm.slice(i, i + 5)) / 5); const a = avg(w); return w.length >= 6 && a >= 10 && w.every((x) => Math.abs(x - a) <= 0.2 * a) && `${Math.round(a)} a minute, every five minutes`; }); } },
  { id: 1757, name: "Second Wind", desc: "Player's actions per minute in the last third of the game are >= 2x the first third.", need: "orders",
    check: (F) => per(humans(F), (p) => { const fr = [...p.acts.map((c) => c.f), ...p.sel]; const a = count(fr, (f) => f < F.endF / 3), b = count(fr, (f) => f >= (2 * F.endF) / 3); return F.endMin >= 15 && a >= 30 && b >= 2 * a && `${Math.round(b / (F.endMin / 3))} a minute at the end against ${Math.round(a / (F.endMin / 3))} at the start`; }) },
  { id: 1760, name: "Cancel Culture", desc: "Player issued >= 100 stop orders.", need: "orders",
    check: (F) => per(humans(F), (p) => { const n = count(p.acts, (c) => c.id === CMD.stop); return n >= 100 && `${n} stop orders`; }) },
  { id: 1761, name: "Firing Squad", desc: "Player issued attack orders on >= 50 distinct units in one minute.", need: "orders",
    check: (F) => per(humans(F), (p) => { const at = p.cmds.filter((c) => c.id === CMD.attack && c.params.length === 1); for (let i = 0; i < at.length; i++) { const ids = new Set(at.filter((c) => c.f >= at[i].f && c.f < at[i].f + 60 * FPS).map((c) => c.params[0])); if (ids.size >= 50) return `${ids.size} targets in the minute from ${clock(at[i].f)}`; } return null; }) },
  { id: 1762, name: "Ground Pounder", desc: "Player issued >= 100 attack-ground orders.", need: "orders",
    check: (F) => per(humans(F), (p) => { const n = count(p.acts, (c) => c.id === CMD.attack && c.params.length >= 3); return n >= 100 && `${n} attack-ground orders`; }) },
  { id: 1763, name: "Area Denial", desc: "Player issued >= 20 area-attack orders.", need: "orders",
    check: (F) => per(humans(F), (p) => { const n = count(p.acts, (c) => c.id === CMD.areaAttack || (c.id === CMD.attack && c.params.length >= 4 && c.params[3] > 0)); return n >= 20 && `${n} area attacks`; }) },
  { id: 1764, name: "Airlift Minute", desc: "Player gave >= 20 transport load/unload commands in a single minute.", need: "orders",
    check: (F) => per(humans(F), (p) => { const b = maxIn(p.acts.filter((c) => c.id === CMD.loadUnits || c.id === CMD.loadOnto || c.id === CMD.unloadUnits || c.id === CMD.unloadUnit).map((c) => c.f), 60 * FPS); return b.n >= 20 && `${b.n} in the minute from ${clock(b.f)}`; }) },
  { id: 1765, name: "Trickle Feeder", desc: "Player issued no factory queue orders for the last 10 minutes of a game >= 30 min.", need: "orders",
    check: (F) => orders(F, () => (F.endMin >= 30 ? per(humans(F), (p) => p.queue.length >= 10 && p.queue.every((q) => q.f < F.endF - 600 * FPS) && `last unit queued at ${clock(last(p.queue).f)}`) : [])) },
  { id: 1871, name: "Fast Hands, Big Bucks", desc: "Player had both the highest actions per minute and the most metal produced in the game.", need: "orders",
    check: (F) => endstats(F, () => { const a = top(humans(F), (p) => apm(F, p)), b = top(withStats(F), (p) => st(p).metalProduced); return playerCount(F) >= 4 && a && b && a.best === b.best ? [{ player: a.best, text: `${Math.round(a.value)} actions a minute, ${k(b.value)} metal` }] : []; }) },
  { id: 1872, name: "Built It, Won It", desc: "The player with the most build orders on the winning side also had the most units produced in the game.", need: "orders",
    check: (F) => needWinner(F, () => orders(F, () => endstats(F, () => { const w = winner(F); if (!w) return []; const a = top(w.players, (p) => p.builds.length + p.queue.length), b = top(withStats(F), (p) => st(p).unitsProduced); return a && b && a.best === b.best && w.players.length >= 2 ? [{ player: a.best, text: `${a.value} build orders, ${b.value} units built` }] : []; }))) },
  { id: 1873, name: "Commander's Last Order", desc: "A player's final command was a self-destruct of their commander, then they left.", need: "orders",
    check: (F) => { if (F.ins?.pov !== "full" || !F.ins.deaths.selfd) return skip("needs a full-view capture's deaths to know which unit was the commander"); return per(humans(F), (p) => { const c = last(p.cmds); const f = commanderSelfd(F, p); return c?.id === CMD.selfd && f !== null && f >= 0 && p.leftAt >= 0 && `self-destructed at ${clock(c.f)} and left`; }); } },
  { id: 1874, name: "Defiant", desc: "A side voted no to resigning, kept playing >= 10 minutes, and lost anyway.", need: "orders",
    check: (F) => needWinner(F, () => resignVotes(F).filter((v) => v.outcome === "failed").flatMap((v) => { const s = voteSide(F, v.caller); return s && s.won === false && F.endF - v.endF >= 600 * FPS ? [{ side: s, text: `refused to resign at ${clock(v.f)}, played ${Math.round((F.endF - v.endF) / FPS / 60)} more min`, f: v.f }] : []; }).slice(0, 1)) },
  { id: 1875, name: "Early Retirement", desc: "A side resigned before 8:00 in a game of >= 6 players.", need: "orders",
    check: (F) => (playerCount(F) >= 6 ? losers(F).flatMap((s) => { const r = Math.min(...s.players.map((p) => (p.resignedAt >= 0 ? p.resignedAt : Infinity))); return r < 480 * FPS ? [{ side: s, text: `resigned at ${clock(r)}`, f: r }] : []; }) : []) },
  { id: 1876, name: "Pause and Plan", desc: "After a pause of >= 30 s, the pausing player's side issued >= 3x their usual commands in the next minute.", need: "orders",
    check: (F) => { const out: Hit[] = []; for (const pz of F.pauses) { if (pz.end - pz.start < 30) continue; const p = F.players.find((x) => x.id === pz.player); if (!p) continue; const s = sideOf(F, p); const f = F.demo.pauses.find((x) => x.t === pz.end)?.f ?? -1; if (f < 0) continue; const all = sum(s.players.map((x) => x.cmds.length)); const usual = all / Math.max(1, F.endMin); const next = sum(s.players.map((x) => count(x.cmds, (c) => c.f >= f && c.f < f + 60 * FPS))); if (usual > 0 && next >= 3 * usual) out.push({ side: s, text: `${next} orders in the minute after a ${Math.round(pz.end - pz.start)} s pause (usually ${Math.round(usual)})`, f }); } return out.slice(0, 1); } },
  { id: 1877, name: "Swift Surrender", desc: "The game ended within 2 minutes of the losing side's first resign vote, in a game >= 30 min.", need: "orders",
    check: (F) => { if (F.endMin < 30) return []; const v = resignVotes(F).find((x) => voteSide(F, x.caller)?.won === false); return v && F.endF - v.f <= 120 * FPS ? gameHit(`first resign vote at ${clock(v.f)}, over at ${mins(F)}`, v.f) : []; } },
  { id: 1878, name: "Build Order Copycat", desc: "In a team game, two allies ordered an identical first 8 builds.", need: "orders",
    check: (F) => orders(F, () => { if (!isTeamGame(F)) return []; const out: Hit[] = []; for (const s of F.sides) { const seqs = s.players.map((p) => ({ p, q: firstBuilds(p, 8).join(",") })).filter((x) => x.q.split(",").length === 8); for (let i = 0; i < seqs.length; i++) for (let j = i + 1; j < seqs.length; j++) if (seqs[i].q === seqs[j].q) out.push({ side: s, text: `${seqs[i].p.name} and ${seqs[j].p.name}: ${seqs[i].q.split(",").join(", ")}` }); } return out.slice(0, 2); }) },
  { id: 1879, name: "Geothermal Prospector", desc: "Player ordered >= 4 geothermal plants.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isGeo).length >= 4 && `${builds(p, isGeo).length} geothermal plants`)) },
  { id: 1880, name: "Tidal Farm", desc: "Player ordered >= 40 tidal generators.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isTidal).length >= 40 && `${builds(p, isTidal).length} tidal generators`)) },
  { id: 1881, name: "Storage Wars", desc: "Player ordered >= 15 metal or energy storages.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isStorage).length >= 15 && `${builds(p, isStorage).length} storages`)) },
  { id: 1882, name: "Airport Tycoon", desc: "Player ordered >= 4 air factories (T1/T2 combined).", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isAirFactory).length >= 4 && `${builds(p, isAirFactory).length} air factories`)) },
  { id: 1883, name: "Shipyard Sprawl", desc: "Player ordered >= 4 shipyards.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => builds(p, isShipyard).length >= 4 && `${builds(p, isShipyard).length} shipyards`)) },
  { id: 1884, name: "Commander Builder", desc: "Player's first 10 build orders were all within 300 elmos of each other (a tight base).", need: "orders",
    check: (F) => orders(F, () => per(humans(F), (p) => { const b = p.builds.slice(0, 10); if (b.length < 10) return null; for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) if (Math.hypot(b[i].x - b[j].x, b[i].z - b[j].z) > 300) return null; return "the first ten buildings within 300 elmos"; })) },
  { id: 1886, name: "Juggernaut Program", desc: "Player queued >= 5 of the same experimental unit.", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const by = new Map<string, number>(); for (const q of p.queue) if (isExperimental(q.def)) by.set(q.def.humanName ?? q.def.name, (by.get(q.def.humanName ?? q.def.name) ?? 0) + q.n); const t = top([...by], (x) => x[1]); return t && t.value >= 5 && `${t.value} ${t.best[0]}`; })) },
  { id: 1887, name: "Mobile Fortress", desc: "Player queued a T3 experimental before any T2 unit (gantry-first).", need: "orders",
    check: (F) => orders(F, () => per(F.players, (p) => { const t3 = p.queue.find((q) => q.n > 0 && isExperimental(q.def) && tech(q.def) >= 3); if (!t3) return null; const t2 = p.queue.find((q) => q.n > 0 && isMobile(q.def) && tech(q.def) === 2); return (!t2 || t2.f > t3.f) && `${t3.def.humanName} at ${clock(t3.f)} before any T2 unit`; })) },
];

// Used by rules that only care whether something was ordered at all.
void isStructure;
