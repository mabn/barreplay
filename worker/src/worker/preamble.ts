// Minimal .brepstream preamble scan for the upload endpoint. The Worker never
// transcodes (that is the ingest daemon's job, in Go) — it only needs the
// gameId to name the archived stream and the recorder's ally team / spectator
// flag for the archive suffix, all of which sit in the text preamble at the
// top of the file (spec: docs/brepstream-format.md). Kept free of any workerd
// import so the node-side tests (tsx --test) can use it directly.

export const BREP_HEADER = "BREPSTREAM 1";

/** How far into the upload the scan is willing to look for the preamble. The
 * preamble (GID/GAME/DEF/T/P lines up to READY) is DEF-dominated and measures
 * tens of KB in practice; a stream whose GID is not within this window is not
 * something the widget wrote. Bounds CPU on the free Workers plan. */
const SCAN_LIMIT = 1 << 20;

export interface StreamPreamble {
  /** Lowercased 32-hex game id from the GID record. */
  gameId: string;
  /** The recording player's ally team from the GAME record, null if absent. */
  allyTeam: number | null;
  /** Whether the recorder was spectating; null if the GAME record lacks it. */
  spectator: boolean | null;
}

/** scanStreamPreamble validates that `data` starts a .brepstream and extracts
 * the preamble fields the upload route needs, or returns a string describing
 * why the upload is unacceptable. */
export function scanStreamPreamble(data: Uint8Array, scanLimit = SCAN_LIMIT): StreamPreamble | string {
  const utf8 = new TextDecoder();
  const limit = Math.min(data.length, scanLimit);
  const p: StreamPreamble = { gameId: "", allyTeam: null, spectator: null };

  let pos = 0;
  const readLine = (): string | null => {
    if (pos >= limit) return null;
    let end = data.indexOf(0x0a, pos);
    if (end < 0 || end > limit) end = limit;
    const line = utf8.decode(data.subarray(pos, end)).replace(/\r$/, "");
    pos = end + 1;
    return line;
  };

  if (readLine() !== BREP_HEADER) {
    return `not a .brepstream (missing ${JSON.stringify(BREP_HEADER)} header line)`;
  }
  for (;;) {
    const line = readLine();
    if (line === null) break; // scan window exhausted mid-preamble
    if (!line.startsWith("BRSNAP ")) continue;
    const content = line.slice("BRSNAP ".length).trim();
    const fields = content.split(/\s+/);
    if (fields[0] === "READY") break;
    if (fields[0] === "GID" && fields.length >= 2 && p.gameId === "") {
      p.gameId = fields[1];
    } else if (fields[0] === "GAME") {
      try {
        const g = JSON.parse(content.slice(fields[0].length).trim());
        if (typeof g === "object" && g !== null) {
          if (p.allyTeam === null && typeof g.allyTeam === "number" && Number.isInteger(g.allyTeam) && g.allyTeam >= 0) {
            p.allyTeam = g.allyTeam;
          }
          if (p.spectator === null && typeof g.spectator === "boolean") p.spectator = g.spectator;
        }
      } catch {
        // A malformed GAME record only costs the archive suffix, not the upload.
      }
    }
  }

  if (!/^[0-9a-fA-F]{32}$/.test(p.gameId)) {
    return "no GID record in the preamble — not a Replay uploader widget stream?";
  }
  p.gameId = p.gameId.toLowerCase();
  return p;
}

/** archiveSuffix names the per-upload part of the archived stream key after
 * the timestamp: the recorder's perspective — "a<n>" for ally team n, "spec"
 * for a spectator (full view), "unk" when the GAME record predates those
 * fields. Future merge tooling keys off this. */
export function archiveSuffix(p: StreamPreamble): string {
  if (p.spectator === true) return "spec";
  if (p.allyTeam !== null) return `a${p.allyTeam}`;
  return "unk";
}
