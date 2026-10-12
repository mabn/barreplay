// A BAR demo (.sdfz), read in the browser: the startscript, the packet
// stream's orders, chat, drawings, pauses and departures, and the tail's
// winners and end-of-game team totals. This is the TypeScript twin of
// internal/demofile (Go), which reads only chat, drawings and self-destructs;
// everything else here is new, and is what the summary's achievements are
// computed from. A demo exists for EVERY game BAR hosted, re-simulated or
// not, which is why the achievements read it rather than the capture.
//
// Layouts are Recoil's: rts/System/LoadSave/demofile.h (the header and the
// tail), rts/Net/Protocol/BaseNetProtocol.cpp (the packets) and
// rts/Sim/Misc/TeamStatistics.h (the totals). A demo chunk holds exactly one
// packet, so every packet this does not decode is skipped by its length.

export interface DemoPlayer {
  /** The player number the packets carry. */
  id: number;
  name: string;
  team: number;
  spectator: boolean;
  /** OpenSkill rating and its uncertainty; NaN when the lobby gave none. */
  skill: number;
  sigma: number;
  /** BAR's chevron level, 0..7; -1 when unknown. */
  rank: number;
  country: string;
}

export interface DemoTeam {
  team: number;
  ally: number;
  /** The player leading it; -1 for an AI team. */
  leader: number;
  /** Set for an AI team: its short name (BARb, ...). */
  ai?: string;
}

/** One order a player gave: NETMSG_COMMAND (to the player's selection) or
 * an AI command (to one unit). */
export interface DemoCommand {
  f: number;
  player: number;
  /** CMD_*; negative = build the unit def -id. */
  id: number;
  opts: number;
  params: number[];
  /** The units it went to (the selection, or the AI command's one unit). */
  units: number[];
  /** Set when a skirmish AI gave it: the AI's instance number (its team is
   * Demo.aiTeams), the player being only the AI's host. */
  ai?: number;
}

export interface DemoChat {
  f: number;
  /** Player number; -1 for a battleroom message relayed by the autohost. */
  player: number;
  /** Set for a relayed battleroom message: who wrote it. */
  name?: string;
  /** server: the autohost's own announcements (vote results, ...). */
  dest: "all" | "ally" | "spec" | "private" | "lobby" | "server";
  text: string;
}

export interface DemoDraw {
  f: number;
  player: number;
  kind: "point" | "line" | "erase";
  x: number;
  z: number;
}

/** The engine's running totals for one team at the end of the game. */
export interface TeamStats {
  frame: number;
  metalUsed: number; energyUsed: number;
  metalProduced: number; energyProduced: number;
  metalExcess: number; energyExcess: number;
  metalReceived: number; energyReceived: number;
  metalSent: number; energySent: number;
  damageDealt: number; damageReceived: number;
  unitsProduced: number; unitsDied: number; unitsReceived: number; unitsSent: number;
  unitsCaptured: number; unitsOutCaptured: number; unitsKilled: number;
}

export interface Demo {
  gameId: string;
  engine: string;
  /** Game seconds the header says the game lasted. */
  gameTime: number;
  /** The last sim frame the stream reached. */
  lastFrame: number;
  mapName: string;
  modOptions: Record<string, string>;
  /** Start positions per team, when the startscript gives them. */
  startPos: Map<number, [number, number]>;
  players: DemoPlayer[];
  teams: DemoTeam[];
  /** Skirmish AI instance -> its team. */
  aiTeams: Map<number, number>;
  commands: DemoCommand[];
  /** Selection changes per player. */
  selections: Map<number, number[]>;
  chat: DemoChat[];
  draws: DemoDraw[];
  /** NETMSG_PAUSE: who paused or unpaused, at which frame and wall second
   * (the chunk's time stamp, which keeps running while the game is paused). */
  pauses: { f: number; t: number; player: number; paused: boolean }[];
  /** NETMSG_PLAYERLEFT; reason 0 lost connection, 1 left, 2 kicked. */
  left: { f: number; player: number; reason: number }[];
  /** A player who joined (again) mid-game: NETMSG_STARTPLAYING is not per
   * player, so this is a CREATE_NEWPLAYER or a second PLAYERNAME. */
  rejoined: { f: number; player: number }[];
  /** NETMSG_TEAM: 1 give everything away, 4 a team died. */
  teamMsgs: { f: number; player: number; action: number; param: number }[];
  /** NETMSG_SHARE: a player hands resources or their SELECTED units to
   * another team; `units` is how many were selected (0: resources only). */
  shares: { f: number; player: number; team: number; units: number; metal: number; energy: number }[];
  winners: number[] | null;
  /** By team; null when the demo has no totals (cut short, or older). */
  teamStats: Map<number, TeamStats> | null;
}

const NET = {
  keyframe: 1, newframe: 2, playerName: 6, chat: 7, command: 11, select: 12, pause: 13,
  aiCommand: 14, aiCommands: 15, share: 26, startPos: 36, playerLeft: 39, mapDraw: 32, team: 51, newPlayer: 75, aiCommandTracked: 76,
};
const MAX_PACKET = 1 << 20;
const HEADER_MIN = 352;

/** fetchDemo downloads and reads gameId's demo through a BAR API proxy that
 * serves /replays/<id> (for the file name) and /demos/<file>. The detail also
 * names the map's size (in map units of 512 elmos), returned beside it. */
export async function fetchDemo(api: string, gameId: string): Promise<{ demo: Demo; map: { w: number; h: number } | null }> {
  const r = await fetch(`${api}/replays/${encodeURIComponent(gameId)}`);
  if (!r.ok) throw new Error(`the BAR API does not know this game (HTTP ${r.status})`);
  const detail = (await r.json()) as { fileName?: string; Map?: { width?: number; height?: number } };
  if (!detail.fileName) throw new Error("the BAR API gives no demo file for this game");
  const d = await fetch(`${api}/demos/${encodeURIComponent(detail.fileName)}`);
  if (!d.ok) throw new Error(`the demo could not be downloaded (HTTP ${d.status})`);
  const demo = parseDemo(await gunzip(new Uint8Array(await d.arrayBuffer())));
  const mw = detail.Map?.width, mh = detail.Map?.height;
  return { demo, map: mw && mh ? { w: mw * 512, h: mh * 512 } : null };
}

export async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  if (b[0] !== 0x1f || b[1] !== 0x8b) return b; // already plain
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function cstr(b: Uint8Array, from: number, to = b.length): string {
  let end = from;
  while (end < to && b[end] !== 0) end++;
  return new TextDecoder().decode(b.subarray(from, end));
}

/** parseDemo reads an UNCOMPRESSED demo. Best-effort past the startscript:
 * a stream cut short keeps what came before the break, and the tail is
 * read only when the header says where the stream ends. */
export function parseDemo(b: Uint8Array): Demo {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < HEADER_MIN || cstr(b, 0, 16) !== "spring demofile") throw new Error("not a demo file");
  const headerSize = v.getInt32(20, true);
  const engine = cstr(b, 24, 280);
  const gameId = Array.from(b.subarray(280, 296), (x) => x.toString(16).padStart(2, "0")).join("");
  const scriptSize = v.getInt32(304, true);
  const streamSize = v.getInt32(308, true);
  const gameTime = v.getInt32(312, true);
  const numPlayers = v.getInt32(320, true);
  const playerStatSize = v.getInt32(324, true);
  const numTeams = v.getInt32(332, true);
  const teamStatSize = v.getInt32(336, true);
  const teamStatElem = v.getInt32(340, true);
  const winnersN = v.getInt32(348, true);

  const script = parseTDF(cstr(b, headerSize, headerSize + scriptSize));
  const game = script.sub.get("game") ?? script;
  const demo: Demo = {
    gameId, engine, gameTime, lastFrame: 0,
    mapName: game.val.get("mapname") ?? "",
    modOptions: Object.fromEntries(game.sub.get("modoptions")?.val ?? []),
    startPos: new Map(),
    players: [], teams: [], aiTeams: new Map(), commands: [], selections: new Map(), chat: [], draws: [],
    pauses: [], left: [], rejoined: [], teamMsgs: [], shares: [], winners: null, teamStats: null,
  };
  const ais = new Map<number, string>();
  for (const [name, sec] of game.sub) {
    const n = Number(name.replace(/^\D+/, ""));
    if (name.startsWith("player")) {
      const skill = (sec.val.get("skill") ?? "").replace(/[\[\]~#()]/g, "").trim();
      demo.players.push({
        id: n,
        name: sec.val.get("name") ?? `Player ${n}`,
        team: Number(sec.val.get("team") ?? -1),
        spectator: sec.val.get("spectator") === "1",
        skill: skill === "" ? NaN : Number(skill),
        sigma: sec.val.has("skilluncertainty") ? Number(sec.val.get("skilluncertainty")) : NaN,
        rank: sec.val.has("rank") ? Number(sec.val.get("rank")) : -1,
        country: (sec.val.get("countrycode") ?? "").toUpperCase(),
      });
    } else if (name.startsWith("ai")) {
      ais.set(Number(sec.val.get("team") ?? -1), sec.val.get("shortname") ?? sec.val.get("name") ?? "AI");
      demo.aiTeams.set(n, Number(sec.val.get("team") ?? -1));
    }
  }
  for (const [name, sec] of game.sub) {
    if (!/^team\d+$/.test(name)) continue;
    const team = Number(name.slice(4));
    const t: DemoTeam = { team, ally: Number(sec.val.get("allyteam") ?? -1), leader: Number(sec.val.get("teamleader") ?? -1) };
    const ai = ais.get(team);
    if (ai) {
      t.ai = ai;
      t.leader = -1;
    }
    demo.teams.push(t);
    const x = Number(sec.val.get("startposx")), z = Number(sec.val.get("startposz"));
    if (Number.isFinite(x) && Number.isFinite(z)) demo.startPos.set(team, [x, z]);
  }
  demo.players.sort((a, c) => a.id - c.id);
  demo.teams.sort((a, c) => a.team - c.team);

  const start = headerSize + scriptSize;
  const end = streamSize > 0 ? Math.min(b.length, start + streamSize) : b.length;
  scanStream(b, v, start, end, demo);
  if (streamSize > 0 && start + streamSize <= b.length) readTail(b, v, start + streamSize, { winnersN, numPlayers, playerStatSize, numTeams, teamStatSize, teamStatElem }, demo);
  return demo;
}

function scanStream(b: Uint8Array, v: DataView, p: number, end: number, demo: Demo) {
  let frame = 0;
  const selection = new Map<number, number[]>();
  const named = new Set<number>();
  const sel = (player: number) => {
    let a = demo.selections.get(player);
    if (!a) demo.selections.set(player, (a = []));
    return a;
  };
  while (p + 8 <= end) {
    const t = v.getFloat32(p, true);
    const n = v.getUint32(p + 4, true);
    p += 8;
    if (n === 0) continue;
    if (n > MAX_PACKET || p + n > end) break;
    const q = p;
    p += n;
    const id = b[q];
    switch (id) {
      case NET.keyframe:
        if (n >= 5) frame = v.getInt32(q + 1, true);
        break;
      case NET.newframe:
        frame++;
        break;
      case NET.select: {
        if (n < 4) break;
        const player = b[q + 3];
        const units: number[] = [];
        for (let i = q + 4; i + 2 <= q + n; i += 2) units.push(v.getInt16(i, true));
        selection.set(player, units);
        sel(player).push(frame);
        break;
      }
      case NET.command: {
        // uint16 size, uint8 player; int32 id, timeout; uint8 opts; uint32 nparams; floats
        if (n < 17) break;
        const player = b[q + 3];
        const cmd = v.getInt32(q + 4, true);
        const opts = b[q + 12];
        const np = Math.min(v.getUint32(q + 13, true), (n - 17) >> 2);
        const params: number[] = [];
        for (let i = 0; i < np; i++) params.push(v.getFloat32(q + 17 + 4 * i, true));
        demo.commands.push({ f: frame, player, id: cmd, opts, params, units: selection.get(player) ?? [] });
        break;
      }
      case NET.aiCommand:
      case NET.aiCommandTracked: {
        // uint16 size, uint8 player, aiInst, aiTeam; int16 unit; int32 id,
        // timeout; uint8 opts; uint32 nparams; [int32 aiCommandId]; floats
        if (n < 21) break;
        const cmd = v.getInt32(q + 8, true);
        const np = Math.max(0, Math.min(v.getUint32(q + 17, true), (n - 21) >> 2));
        const pp = q + 21 + (id === NET.aiCommandTracked ? 4 : 0);
        const params: number[] = [];
        for (let i = 0; i < np && pp + 4 * i + 4 <= q + n; i++) params.push(v.getFloat32(pp + 4 * i, true));
        demo.commands.push({ f: frame, player: b[q + 3], ai: aiOf(b[q + 4]), id: cmd, opts: b[q + 16], params, units: [v.getInt16(q + 6, true)] });
        break;
      }
      case NET.aiCommands:
        aiCommands(b, v, q, n, frame, demo);
        break;
      case NET.pause:
        if (n >= 3) demo.pauses.push({ f: frame, t, player: b[q + 1], paused: b[q + 2] !== 0 });
        break;
      case NET.startPos:
        // uint8 player, team, ready; float x, y, z: where a player put their
        // start, pre-game. The last one per team stands.
        if (n >= 16) demo.startPos.set(b[q + 2], [v.getFloat32(q + 4, true), v.getFloat32(q + 12, true)]);
        break;
      case NET.playerLeft:
        if (n >= 3) demo.left.push({ f: frame, player: b[q + 1], reason: b[q + 2] });
        break;
      case NET.share:
        // uint8 player, team, shareUnits; float metal, energy
        if (n >= 12) demo.shares.push({ f: frame, player: b[q + 1], team: b[q + 2], units: b[q + 3] ? (selection.get(b[q + 1])?.length ?? 0) : 0, metal: v.getFloat32(q + 4, true), energy: v.getFloat32(q + 8, true) });
        break;
      case NET.team:
        if (n >= 4) demo.teamMsgs.push({ f: frame, player: b[q + 1], action: b[q + 2], param: b[q + 3] });
        break;
      case NET.playerName:
        // uint8 size, player, name: sent as a player connects. A second one
        // during the game is a reconnect.
        if (n >= 3) {
          const player = b[q + 2];
          if (named.has(player) && frame > 0) demo.rejoined.push({ f: frame, player });
          named.add(player);
        }
        break;
      case NET.newPlayer:
        if (n >= 4 && frame > 0) demo.rejoined.push({ f: frame, player: b[q + 3] });
        break;
      case NET.chat: {
        if (n < 5) break;
        const from = b[q + 2], dest = b[q + 3];
        const text = cstr(b, q + 4, q + n).trimEnd();
        if (!text || text.startsWith("> :")) break;
        if (from === 255) {
          const m = /^<([^>]{1,64})> (.*)$/.exec(text);
          if (m && m[2]) demo.chat.push({ f: frame, player: -1, name: m[1], dest: "lobby", text: m[2] });
          else if (!m) demo.chat.push({ f: frame, player: -1, dest: "server", text });
          break;
        }
        demo.chat.push({ f: frame, player: from, dest: dest === 252 ? "ally" : dest === 253 ? "spec" : dest === 254 ? "all" : "private", text });
        break;
      }
      case NET.mapDraw: {
        if (n < 12) break;
        const kind = b[q + 3];
        const player = b[q + 2];
        if (kind === 0 || kind === 1 || kind === 2) {
          demo.draws.push({ f: frame, player, kind: kind === 0 ? "point" : kind === 1 ? "erase" : "line", x: v.getUint32(q + 4, true), z: v.getUint32(q + 8, true) });
        }
        break;
      }
    }
  }
  demo.lastFrame = frame;
}

/** aiOf reads an AI command's instance byte: MAX_AIS (255) is no AI at all,
 * the player's own Lua (BAR's area-mex and build-line widgets order this way). */
const aiOf = (inst: number) => (inst === 255 ? undefined : inst);

/** NETMSG_AICOMMANDS: uint16 size, uint8 player, aiInst, pairwise; uint32
 * sameCmdID; uint8 sameCmdOpt; uint16 sameCmdParamSize; int16 unitCount +
 * units; int16 commandCount + commands (see internal/demofile/orders.go). */
function aiCommands(b: Uint8Array, v: DataView, q: number, n: number, f: number, demo: Demo) {
  const lim = q + n;
  if (n < 17) return;
  const player = b[q + 3];
  const pairwise = b[q + 5] !== 0;
  const same = v.getInt32(q + 6, true);
  const sameOpt = b[q + 10];
  const sameParams = v.getUint16(q + 11, true);
  let p = q + 13;
  const nu = v.getInt16(p, true);
  p += 2;
  if (nu < 0 || p + 2 * nu + 2 > lim) return;
  const units: number[] = [];
  for (let i = 0; i < nu; i++, p += 2) units.push(v.getInt16(p, true));
  const nc = v.getInt16(p, true);
  p += 2;
  for (let c = 0; c < nc; c++) {
    let cmd = same;
    if (cmd === 0) {
      if (p + 4 > lim) return;
      cmd = v.getInt32(p, true);
      p += 4;
    }
    let opts = sameOpt;
    if (sameOpt === 0xff) {
      if (p + 1 > lim) return;
      opts = b[p++];
    }
    let np = sameParams;
    if (sameParams === 0xffff) {
      if (p + 2 > lim) return;
      np = v.getUint16(p, true);
      p += 2;
    }
    if (p + 4 * np > lim) return;
    const params: number[] = [];
    for (let i = 0; i < np; i++) params.push(v.getFloat32(p + 4 * i, true));
    p += 4 * np;
    demo.commands.push({ f, player, ai: aiOf(b[q + 4]), id: cmd, opts, params, units: pairwise ? (c < units.length ? [units[c]] : []) : units });
  }
}

interface TailSizes {
  winnersN: number; numPlayers: number; playerStatSize: number; numTeams: number; teamStatSize: number; teamStatElem: number;
}

/** readTail reads what follows the stream: one byte per winning ally team,
 * the player statistics (skipped), then per team a count of records and the
 * records themselves; the last record is the end-of-game total. */
function readTail(b: Uint8Array, v: DataView, p: number, s: TailSizes, demo: Demo) {
  if (s.winnersN > 0 && s.winnersN < 256 && p + s.winnersN <= b.length) {
    demo.winners = Array.from(b.subarray(p, p + s.winnersN));
  }
  p += Math.max(0, s.winnersN);
  p += Math.max(0, s.playerStatSize);
  if (s.numTeams <= 0 || s.teamStatElem < 80 || p + 4 * s.numTeams > b.length) return;
  const counts: number[] = [];
  for (let i = 0; i < s.numTeams; i++) counts.push(v.getInt32(p + 4 * i, true));
  p += 4 * s.numTeams;
  const total = counts.reduce((a, c) => a + c, 0);
  if (counts.some((c) => c < 0 || c > 100000) || p + total * s.teamStatElem > b.length) return;
  const out = new Map<number, TeamStats>();
  for (let team = 0; team < s.numTeams; team++) {
    if (counts[team] > 0) {
      const r = p + (counts[team] - 1) * s.teamStatElem;
      const fl = (i: number) => v.getFloat32(r + 4 + 4 * i, true);
      const it = (i: number) => v.getInt32(r + 52 + 4 * i, true);
      out.set(team, {
        frame: v.getInt32(r, true),
        metalUsed: fl(0), energyUsed: fl(1), metalProduced: fl(2), energyProduced: fl(3),
        metalExcess: fl(4), energyExcess: fl(5), metalReceived: fl(6), energyReceived: fl(7),
        metalSent: fl(8), energySent: fl(9), damageDealt: fl(10), damageReceived: fl(11),
        unitsProduced: it(0), unitsDied: it(1), unitsReceived: it(2), unitsSent: it(3),
        unitsCaptured: it(4), unitsOutCaptured: it(5), unitsKilled: it(6),
      });
    }
    p += counts[team] * s.teamStatElem;
  }
  demo.teamStats = out;
}

interface TDF {
  val: Map<string, string>;
  sub: Map<string, TDF>;
}

/** parseTDF reads the startscript's TDF ([section] { key=value; ... }),
 * lower-casing names like internal/demofile's parser does. */
export function parseTDF(src: string): TDF {
  const s = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const root: TDF = { val: new Map(), sub: new Map() };
  const stack = [root];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "[") {
      const e = s.indexOf("]", i);
      if (e < 0) break;
      const name = s.slice(i + 1, e).trim().toLowerCase();
      i = s.indexOf("{", e);
      if (i < 0) break;
      i++;
      const sec: TDF = { val: new Map(), sub: new Map() };
      stack[stack.length - 1].sub.set(name, sec);
      stack.push(sec);
    } else if (c === "}") {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (/\s|;/.test(c)) {
      i++;
    } else {
      let e = i;
      while (e < s.length && s[e] !== ";" && s[e] !== "\n" && s[e] !== "}") e++;
      const pair = s.slice(i, e);
      const eq = pair.indexOf("=");
      if (eq >= 0) stack[stack.length - 1].val.set(pair.slice(0, eq).trim().toLowerCase(), pair.slice(eq + 1).trim());
      i = e === i ? i + 1 : e;
    }
  }
  return root;
}

/** A unit def as the .brp's meta records it (snapshot.UnitDef). */
export interface BrpDef {
  id: number;
  name: string;
  humanName?: string;
  metalCost?: number;
  energyCost?: number;
  isBuilder?: boolean;
  isBuilding?: boolean;
  isFactory?: boolean;
  canFly?: boolean;
  canMove?: boolean;
  weaponCount?: number;
  techLevel?: number;
  unitGroup?: string;
  isCommander?: boolean;
  maxWeaponRange?: number;
  iconType?: string;
  speed?: number;
}

/** fetchBrpDefs reads the unit-def table out of a published .brp's meta
 * section (its first section): two Range reads, the 10-byte container
 * header + section header, then the gzipped JSON. Null for a replay with no
 * .brp (an older bundle). */
export async function fetchBrpDefs(url: string): Promise<Map<number, BrpDef> | null> {
  const head = await fetch(url, { headers: { range: "bytes=0-9" } });
  if (head.status === 404) return null;
  if (!head.ok) throw new Error(`the replay could not be read (HTTP ${head.status})`);
  let hb = new Uint8Array(await head.arrayBuffer());
  const whole = head.status === 200 ? hb : null; // a server ignoring Range
  if (hb.length < 10 || cstr(hb, 0, 4) !== "BRP1" || hb[5] !== 0x4d) throw new Error("not a .brp with a meta section");
  const len = new DataView(hb.buffer, hb.byteOffset).getUint32(6, true);
  if (whole) hb = whole.subarray(10, 10 + len);
  else {
    const r = await fetch(url, { headers: { range: `bytes=10-${10 + len - 1}` } });
    if (!r.ok) throw new Error(`the replay could not be read (HTTP ${r.status})`);
    hb = new Uint8Array(await r.arrayBuffer());
  }
  const rec = JSON.parse(new TextDecoder().decode(await gunzip(hb))) as { meta?: { unitDefs?: Record<string, BrpDef> } };
  const meta = rec.meta ?? {};
  const defs = new Map<number, BrpDef>();
  for (const d of Object.values(meta.unitDefs ?? {})) if (d && typeof d.id === "number") defs.set(d.id, d);
  return defs;
}
