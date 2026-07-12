// .brepstream -> R2 static pieces, in TypeScript (no Go anywhere near a deploy).
//
// STATUS: PARKED. The viewer serves exactly one wire format — the version-4
// .brp pieces — because brepstream-encoded chunks are ~1.4x+ larger served.
// Nothing may upload this module's version-5 output for playback. The
// preamble/record-framing parsing below is kept (and test-pinned) as the
// foundation for the planned TS transcoder (brepstream -> .brp-wire pieces)
// that an in-worker upload API will need.
//
// The Replay uploader widget's binary stream (spec: docs/brepstream-format.md)
// was designed so a server can SPLIT it without transcoding: records are
// length-framed (<tag u8><len u32le><payload>), keyframes are flagged at a
// fixed offset and emitted every 64 samples (the same cadence as a .brp
// chunk), and restated units are absolute fixed-width columns. So this module
// never decodes frame semantics — it walks the framing, parses the small TEXT
// preamble, slices the F records into a keys stream + per-chunk delta files
// (the exact keyframe-outside-chunks model the .brp viewer already streams),
// and builds a head. The pieces reuse the deployed worker's URL scheme:
//
//   replays/<gameId>.brw    head: BRW1 container, version byte 5 ("breps1"),
//                           one J section = gzip(JSON) — meta, teams, players,
//                           unit defs, events, bounds, chunk index
//   replays/<gameId>.keys   gzip(concat of every keyframe F record, framed,
//                           in chunk order) — the keys-first download
//   replays/<gameId>/c<n>   gzip(chunk n's delta F records, framed); absent
//                           when the chunk has no deltas
//
// Version byte 5 is deliberate: the deployed viewer accepts only version 4
// (.brp wire), so until it grows a breps decoder it fails these replays with
// an accurate "unsupported payload version 5" instead of rendering garbage.
//
// Lockstep: this is the third reader of the format, after the Lua encoder
// (assets/lua/replay_uploader.lua) and the Go decoder (internal/capture/
// brep.go, the reference). worker/tests/split.test.ts pins this file against
// the same harness fixture that pins Lua<->Go. Evolve all three together.
//
// Chunks contain ONLY F records: E events are parsed into the head (they are
// tiny), X end markers are informational, and unknown record types are
// skipped exactly like the Go decoder — none of them is worth re-serving.
//
// Like the Go decoder, parsing is tolerant of truncation (a live game can end
// in a crash): a partial trailing record is dropped with a warning and
// everything before it is kept. A widget disabled and re-enabled mid-game
// APPENDS a whole new segment (header line + preamble + records); the header
// line's first byte 'B' where a tag would be marks the restart. A segment's
// first frame is always a keyframe, so a restart is also a chunk boundary.

/** One entry of the head's chunk index (mirrors the .brp wire index shape). */
export interface BrepsChunkIndex {
  /** Sim frame of the chunk's keyframe. */
  frame: number;
  /** Sampled frames in the chunk (keyframe + deltas), stale frames excluded. */
  count: number;
  /** RAW byte length of the keyframe record inside the decompressed .keys. */
  kLen: number;
  /** Compressed byte length of the chunk's delta file (0 = no file). */
  len: number;
}

export interface BrepsEvent {
  frame: number;
  kind: string;
  id: number;
  def: number;
  team: number;
}

export interface BrepsHead {
  format: "breps1";
  gameId: string;
  map: string;
  gameVersion: string;
  engineVersion: string;
  sampleEvery: number;
  gameSpeed: number;
  /** The raw GAME preamble line (first segment's): protocol, widgetVersion,
   * mode, recording player id/allyTeam/spectator, ... */
  game: Record<string, unknown> | null;
  teams: { team: number; allyTeam: number; side: string; color: string; playerName: string }[];
  players: { player: number; team: number; spectator: boolean; name: string }[];
  /** Full unit-def JSON objects from the DEF preamble lines, keyed by defID. */
  defs: Record<number, Record<string, unknown>>;
  events: BrepsEvent[];
  /** Union of restated unit positions (every unit appears absolutely in every
   * keyframe, so this tracks the decoded extent to within one keyframe
   * interval of drift). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Emitted (monotonic) sampled frames across all chunks. */
  frameCount: number;
  /** The X record's reason (gameover/shutdown/error), "" if the stream was
   * cut short. */
  endReason: string;
  chunks: BrepsChunkIndex[];
}

export interface SplitResult {
  gameId: string;
  head: BrepsHead;
  /** R2 object key -> bytes, ready to upload as-is. */
  files: Map<string, Uint8Array>;
  /** Non-fatal oddities observed while parsing (truncation, stale frames…). */
  warnings: string[];
}

export const BREP_HEADER = "BREPSTREAM 1";
export const BRW_MAGIC = "BRW1";
/** BRW payload version for brepstream-split replays (4 = .brp wire). */
export const BREPS_WIRE_VERSION = 5;
/** Records larger than this mean a corrupt stream (mirrors Go maxBrepRecord). */
const MAX_RECORD = 64 << 20;

const utf8 = new TextDecoder();

/** Split a raw .brepstream into its static R2 pieces. */
export async function splitBrepstream(data: Uint8Array): Promise<SplitResult> {
  const p = parse(data);
  if (!/^[0-9a-fA-F]{32}$/.test(p.gameId)) {
    throw new Error(`no GID record in the preamble (got ${JSON.stringify(p.gameId)}) — not a widget stream?`);
  }
  const id = p.gameId.toLowerCase();

  const files = new Map<string, Uint8Array>();
  const chunks: BrepsChunkIndex[] = [];
  const keyParts: Uint8Array[] = [];
  for (let i = 0; i < p.chunks.length; i++) {
    const c = p.chunks[i];
    keyParts.push(c.key);
    const entry: BrepsChunkIndex = { frame: c.frame, count: c.count, kLen: c.key.length, len: 0 };
    if (c.deltas.length > 0) {
      const gz = await gzip(concat(c.deltas));
      entry.len = gz.length;
      files.set(`replays/${id}/c${i}`, gz);
    }
    chunks.push(entry);
  }
  files.set(`replays/${id}.keys`, await gzip(concat(keyParts)));

  const head: BrepsHead = {
    format: "breps1",
    gameId: id,
    map: p.map,
    gameVersion: p.gameVersion,
    engineVersion: p.engineVersion,
    sampleEvery: p.sampleEvery,
    gameSpeed: p.gameSpeed,
    game: p.game,
    teams: p.teams,
    players: p.players,
    defs: p.defs,
    events: p.events,
    bounds: p.bounds,
    frameCount: p.frameCount,
    endReason: p.endReason,
    chunks,
  };
  files.set(`replays/${id}.brw`, brwContainer(await gzip(new TextEncoder().encode(JSON.stringify(head)))));

  return { gameId: id, head, files, warnings: p.warnings };
}

// ---------------------------------------------------------------------------
// Stream walking

interface RawChunk {
  frame: number;
  count: number;
  /** The framed keyframe record bytes (tag+len+payload). */
  key: Uint8Array;
  /** Framed delta F records, in stream order. */
  deltas: Uint8Array[];
}

interface Parsed {
  gameId: string;
  map: string;
  gameVersion: string;
  engineVersion: string;
  sampleEvery: number;
  gameSpeed: number;
  game: Record<string, unknown> | null;
  teams: BrepsHead["teams"];
  players: BrepsHead["players"];
  defs: BrepsHead["defs"];
  events: BrepsEvent[];
  bounds: BrepsHead["bounds"];
  frameCount: number;
  endReason: string;
  chunks: RawChunk[];
  warnings: string[];
}

function parse(data: Uint8Array): Parsed {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const p: Parsed = {
    gameId: "",
    map: "",
    gameVersion: "",
    engineVersion: "",
    sampleEvery: 0,
    gameSpeed: 30,
    game: null,
    teams: [],
    players: [],
    defs: {},
    events: [],
    bounds: { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
    frameCount: 0,
    endReason: "",
    chunks: [],
    warnings: [],
  };
  let pos = 0;

  // readLine returns the text up to (excluding) the next '\n', consuming it;
  // null at EOF.
  const readLine = (): string | null => {
    if (pos >= data.length) return null;
    let end = data.indexOf(0x0a, pos);
    if (end < 0) end = data.length;
    const line = utf8.decode(data.subarray(pos, end)).replace(/\r$/, "");
    pos = Math.min(end + 1, data.length);
    return line;
  };

  // Header + text preamble of one segment (mirrors capture.scanPreamble; the
  // preamble grammar is shared with .brsnap). First-seen values win, exactly
  // like the Go decoder seeding an empty Meta.
  const scanPreamble = () => {
    for (;;) {
      const line = readLine();
      if (line === null) return; // EOF mid-preamble: keep what we have
      if (!line.startsWith("BRSNAP ")) continue;
      const content = line.slice("BRSNAP ".length).trim();
      const fields = content.split(/\s+/);
      switch (fields[0]) {
        case "READY":
          return;
        case "GID":
          if (fields.length >= 2 && p.gameId === "") p.gameId = fields[1];
          break;
        case "GAME": {
          const g = tryJSON(content.slice(fields[0].length).trim(), p.warnings, "GAME");
          if (g) {
            if (p.game === null) p.game = g;
            if (p.map === "" && typeof g.map === "string") p.map = g.map;
            if (p.gameVersion === "" && typeof g.gameVersion === "string") p.gameVersion = g.gameVersion;
            if (p.engineVersion === "" && typeof g.engineVersion === "string") p.engineVersion = g.engineVersion;
            if (p.sampleEvery === 0 && typeof g.sampleEvery === "number" && g.sampleEvery > 0) p.sampleEvery = g.sampleEvery;
            if (typeof g.gameSpeed === "number" && g.gameSpeed > 0) p.gameSpeed = g.gameSpeed;
          }
          break;
        }
        case "DEF": {
          const d = tryJSON(content.slice(fields[0].length).trim(), p.warnings, "DEF");
          if (d && typeof d.id === "number" && !(d.id in p.defs)) p.defs[d.id] = d;
          break;
        }
        case "T": // T <teamID> <allyTeam> <side> <color>; side "_" = none
          if (fields.length >= 3) {
            const team = int(fields[1]);
            if (!p.teams.some((t) => t.team === team)) {
              p.teams.push({
                team,
                allyTeam: int(fields[2]),
                side: fields.length >= 4 && fields[3] !== "_" ? fields[3] : "",
                color: fields.length >= 5 && fields[4] !== "-" ? fields[4] : "",
                playerName: "",
              });
            }
          }
          break;
        case "P": // P <playerID> <team> <spectator> <name...>
          if (fields.length >= 5) {
            const player = int(fields[1]);
            if (!p.players.some((q) => q.player === player)) {
              p.players.push({
                player,
                team: int(fields[2]),
                spectator: fields[3] === "1",
                name: fields.slice(4).join(" "),
              });
            }
          }
          break;
        // GID/GAME/DEF/T/P/READY are the only preamble records the widget
        // writes; anything else is ignored for forward compatibility.
      }
    }
  };

  const header = readLine();
  if (header === null || header !== BREP_HEADER) {
    throw new Error(`not a brepstream (missing ${JSON.stringify(BREP_HEADER)} header line)`);
  }
  scanPreamble();

  // Binary record loop.
  let cur: RawChunk | null = null;
  let lastEmitted = -1;
  let staleWarned = false;
  const truncated = (what: string) => {
    p.warnings.push(`stream truncated ${what}; keeping ${p.frameCount} frames`);
  };
  records: for (;;) {
    if (pos >= data.length) break;
    if (data[pos] === 0x42 /* 'B' */) {
      // Segment restart: "BREPSTREAM 1" line + repeated preamble. The next
      // frame is a keyframe (fresh encoder state), so close the open chunk.
      const line = readLine();
      if (line !== BREP_HEADER) {
        p.warnings.push(`malformed segment header after ${p.frameCount} frames; stopping`);
        break;
      }
      scanPreamble();
      cur = null;
      continue;
    }
    if (pos + 5 > data.length) {
      truncated("mid record header");
      break;
    }
    const tag = data[pos];
    const len = dv.getUint32(pos + 1, true);
    if (len > MAX_RECORD) throw new Error(`record length ${len} exceeds limit (corrupt stream?)`);
    if (pos + 5 + len > data.length) {
      truncated("mid record");
      break;
    }
    const framed = data.subarray(pos, pos + 5 + len);
    const payload = data.subarray(pos + 5, pos + 5 + len);
    pos += 5 + len;

    switch (tag) {
      case 0x46 /* 'F' */: {
        if (payload.length < 10) {
          truncated("inside a frame record");
          break records;
        }
        const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const frame = pv.getUint32(0, true);
        const flags = pv.getUint8(4);
        const nUnits = pv.getUint16(5, true);
        const keyframe = (flags & 1) !== 0;
        scanBounds(payload, nUnits, p.bounds, p.warnings);

        // Mirror the Go decoder's monotonic-frame guard: an overlapping
        // segment's stale frames stay in the served bytes (the client decoder
        // needs them for prediction state) but are not counted.
        const emitted = frame > lastEmitted;
        if (!emitted && !staleWarned) {
          staleWarned = true;
          p.warnings.push(`segment overlaps frame ${frame} <= ${lastEmitted}; not counting stale frames`);
        }
        if (keyframe) {
          cur = { frame, count: 0, key: framed, deltas: [] };
          p.chunks.push(cur);
        } else if (cur === null) {
          // Spec says a segment's first frame is a keyframe; tolerate a
          // violating stream the way the Go decoder does (it decodes from
          // empty state) by opening a keyframe-less chunk.
          p.warnings.push(`delta frame ${frame} before any keyframe`);
          cur = { frame, count: 0, key: new Uint8Array(0), deltas: [framed] };
          p.chunks.push(cur);
        } else {
          cur.deltas.push(framed);
        }
        if (emitted) {
          lastEmitted = frame;
          cur.count++;
          p.frameCount++;
        }
        break;
      }
      case 0x45 /* 'E' */: {
        // Text payload "<frame> <kind> <id> <def> <team>" — events live in
        // the head, not in the chunk files.
        const f = utf8.decode(payload).trim().split(/\s+/);
        if (f.length >= 5) {
          p.events.push({ frame: int(f[0]), kind: f[1], id: int(f[2]), def: int(f[3]), team: int(f[4]) });
        }
        break;
      }
      case 0x58 /* 'X' */:
        p.endReason = utf8.decode(payload).trim();
        break;
      default:
        // Unknown record type: skip (forward compatibility), and don't
        // re-serve bytes we don't understand.
        break;
    }
  }

  if (p.sampleEvery === 0) p.sampleEvery = 30;
  if (!isFinite(p.bounds.minX)) p.bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  // Backfill each team's display player (first non-spectator on the team),
  // mirroring capture.backfillTeamPlayers.
  for (const t of p.teams) {
    const owner = p.players.find((q) => !q.spectator && q.team === t.team);
    if (owner) t.playerName = owner.name;
  }
  return p;
}

// scanBounds folds the restated units' absolute x/z columns into bounds. The
// columns sit at fixed offsets (id u16 + def u16 + team u8 = 5 bytes per unit
// before x): every unit is restated in every keyframe, so the union tracks
// the true extent to within one keyframe interval of movement.
function scanBounds(payload: Uint8Array, nUnits: number, b: BrepsHead["bounds"], warnings: string[]): void {
  const xOff = 10 + nUnits * 5;
  if (xOff + nUnits * 4 > payload.length) {
    warnings.push("frame record too short for its unit columns");
    return;
  }
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i < nUnits; i++) {
    const x = dv.getInt16(xOff + i * 2, true);
    const z = dv.getInt16(xOff + nUnits * 2 + i * 2, true);
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z;
    if (z > b.maxZ) b.maxZ = z;
  }
}

// ---------------------------------------------------------------------------
// Small helpers

function tryJSON(s: string, warnings: string[], what: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch (e) {
    warnings.push(`bad ${what} record: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

function int(s: string): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const q of parts) n += q.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const q of parts) {
    out.set(q, off);
    off += q.length;
  }
  return out;
}

/** brwContainer frames the gzipped head JSON as a BRW1 container (version
 * byte 5, one J section) — the same framing the .brp wire head uses, so the
 * viewer's container parser needs no new code, only a version branch. */
function brwContainer(gzJSON: Uint8Array): Uint8Array {
  const out = new Uint8Array(BRW_MAGIC.length + 1 + 5 + gzJSON.length);
  for (let i = 0; i < BRW_MAGIC.length; i++) out[i] = BRW_MAGIC.charCodeAt(i);
  out[BRW_MAGIC.length] = BREPS_WIRE_VERSION;
  let off = BRW_MAGIC.length + 1;
  out[off] = 0x4a; // 'J'
  new DataView(out.buffer).setUint32(off + 1, gzJSON.length, true);
  out.set(gzJSON, off + 5);
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const resp = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(cs));
  return new Uint8Array(await resp.arrayBuffer());
}
