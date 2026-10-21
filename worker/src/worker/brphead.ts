// Minimal .brp head scan for the upload endpoint, the twin of preamble.ts for
// a capture uploaded already packed. Like there, the Worker decodes nothing it
// does not need: the gameId names the archive, the recorder record its suffix.
// The container (docs/brp-format.md) is "BRP1" <version u8> and then tagged
// sections <tag u8><len u32le><payload>, the M meta (one gzip stream of JSON)
// always first; its JSON is the writer's record,
// with the capture's Meta under "meta". The
// ingest daemon parses the whole file before publishing it; this only refuses
// what is plainly not one. Kept free of any workerd import so the node-side
// tests can use it directly.

import type { StreamPreamble } from "./preamble";

export const BRP_MAGIC = "BRP1";

/** The container versions the Go reader accepts (snapshot.BRPMinVersion..BRPVersion). */
export const BRP_VERSIONS = [5, 6];

/** A meta bigger than this, packed or unpacked, is not one of ours (a real one
 * is tens to a few hundred KB, nearly all of it the unit-def table). Bounds
 * the gunzip and the JSON parse. */
const MAX_META = 8 << 20;

/** isBrp says whether `data` starts with the .brp magic. */
export function isBrp(data: Uint8Array): boolean {
  return data.length >= 4 && String.fromCharCode(...data.subarray(0, 4)) === BRP_MAGIC;
}

/** scanBrpHead validates the container header and meta of a .brp and extracts
 * the fields the upload route needs — the same shape scanStreamPreamble
 * returns, so the archive is named the same way — or returns a string saying
 * why the upload is unacceptable. */
export async function scanBrpHead(data: Uint8Array): Promise<StreamPreamble | string> {
  if (!isBrp(data)) return `not a .brp (missing ${JSON.stringify(BRP_MAGIC)} magic)`;
  if (data.length < 10) return "truncated .brp header";
  const version = data[4];
  if (!BRP_VERSIONS.includes(version)) {
    return `unsupported .brp version ${version} (this server reads ${BRP_VERSIONS.join(", ")}; repack it from its .brepstream)`;
  }
  if (data[5] !== 0x4d /* 'M' */) return "malformed .brp: the meta section is not first";
  const len = new DataView(data.buffer, data.byteOffset + 6, 4).getUint32(0, true);
  if (len > MAX_META) return `malformed .brp: meta section of ${len} bytes`;
  if (10 + len > data.length) return "truncated .brp: the meta section runs past the end of the file";

  const raw = await gunzipCapped(data.subarray(10, 10 + len), MAX_META);
  if (raw === null) return "malformed .brp: the meta section is not a gzip stream of a sane size";
  let meta: unknown;
  try {
    meta = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return "malformed .brp: the meta section is not JSON";
  }
  if (typeof meta !== "object" || meta === null) return "malformed .brp: the meta section is not an object";
  // The section is the writer's whole M record (snapshot/brp.go brpMetaRecord):
  // the capture's Meta sits in its "meta" field, beside the counts and index.
  const inner = (meta as { meta?: unknown }).meta;
  if (typeof inner !== "object" || inner === null) return "the .brp names no game (its meta has no 32-hex gameId)";
  const m = inner as { gameId?: unknown; recorder?: { allyTeam?: unknown; spectator?: unknown } | null };
  if (typeof m.gameId !== "string" || !/^[0-9a-fA-F]{32}$/.test(m.gameId)) {
    return "the .brp names no game (its meta has no 32-hex gameId)";
  }
  const p: StreamPreamble = { gameId: m.gameId.toLowerCase(), allyTeam: null, spectator: null };
  const r = m.recorder;
  if (typeof r === "object" && r !== null) {
    if (typeof r.allyTeam === "number" && Number.isInteger(r.allyTeam) && r.allyTeam >= 0) p.allyTeam = r.allyTeam;
    // Go omits `spectator` when false, so a recorder record means a player
    // unless it says otherwise.
    p.spectator = r.spectator === true;
  }
  return p;
}

/** gunzipCapped inflates one gzip stream, or returns null when it is not one
 * or inflates past `cap` bytes (stopping there, so a gzip bomb costs nothing). */
async function gunzipCapped(gz: Uint8Array, cap: number): Promise<Uint8Array | null> {
  const reader = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
