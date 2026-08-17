// Pull a BAR gameId out of whatever a person pasted. The re-sim request box
// takes a replay link, and every site that shows a BAR replay carries the same
// 32-hex game id somewhere in its URL:
//
//   https://gex.honu.pw/match/<id>                         last path segment
//   https://bar-rts.com/replays/<id>                       last path segment
//   https://www.beyondallreason.info/replays?gameId=<id>   query parameter
//   https://api.bar-rts.com/replays/<id>                   last path segment
//   <id>                                                   pasted bare
//
// This is the TypeScript twin of barapi.ParseGameID (internal/barapi/barapi.go)
// and must stay in lockstep with it. Deliberately host-agnostic, exactly like
// the Go original: the id is the only thing that matters, and the only thing
// done with it afterwards is a lookup against api.bar-rts.com, so accepting
// `https://anywhere.example/<id>` costs nothing.
//
// The splitting is done by hand rather than with `new URL`, which would look
// like the obvious way to mirror Go's url.Parse and is not: `new URL` REQUIRES
// a scheme and throws without one, while url.Parse treats a bare
// "bar-rts.com/replays/<id>" as a path and finds the id. A copy-pasted URL is
// routinely missing its scheme, so that difference is not a corner case — it
// is the twin rejecting what the original accepts.
//
// Kept free of any workerd import so the node-side tests (tsx --test) can use
// it directly.

const GAME_ID_RE = /^[0-9a-fA-F]{32}$/;

/** parseGameId returns the lowercased gameId found in `input`, or null when
 * there is none. */
export function parseGameId(input: string): string | null {
  const s = input.trim();
  if (GAME_ID_RE.test(s)) return s.toLowerCase();

  let rest = s;
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  let query = "";
  const qm = rest.indexOf("?");
  if (qm >= 0) {
    query = rest.slice(qm + 1);
    rest = rest.slice(0, qm);
  }

  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq) !== "gameId") continue;
    let v = pair.slice(eq + 1);
    try {
      v = decodeURIComponent(v);
    } catch {
      // A malformed escape is not a gameId either way; test the raw value.
    }
    if (GAME_ID_RE.test(v)) return v.toLowerCase();
  }

  // The LAST path segment, like the Go original — the scheme and host end up
  // in this split too, but only the final segment is ever looked at.
  const parts = rest.split("/").filter((p) => p !== "");
  const last = parts.length > 0 ? parts[parts.length - 1] : "";
  return GAME_ID_RE.test(last) ? last.toLowerCase() : null;
}
