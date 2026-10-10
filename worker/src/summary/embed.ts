// The summary for a site that is not the replay viewer: given a game id,
// find the replay's published revision, fetch its insights and mount them.
// It exists so that the knowledge of WHERE things are — the catalog route,
// the data origin, how a rid becomes a path, which insights versions exist —
// stays in this repo, next to the code that publishes them. A host bundles
// this package (pinned to a commit) and calls mountGameSummary; it never
// learns what a rid is.
//
// Everything is fetched from the replay viewer's deployment at run time, so
// nothing is copied between the two sites. The catalog route and the data
// bucket both answer cross-origin reads for that reason (app.ts, r2-cors.json).
import { INSIGHTS_VERSIONS, mountSummary } from "./index";
import type { Insights, SummaryHandle, SummaryOptions } from "./types";

/** The replay viewer: the catalog route and the replay pages. */
export const REPLAY_ORIGIN = "https://replay.fogofwar.dev";
/** The bucket the published pieces (and the insights files) are served from. */
export const DATA_ORIGIN = "https://cdn-bar.fogofwar.dev";

export interface EmbedOptions extends SummaryOptions {
  /** Replay viewer origin; defaults to REPLAY_ORIGIN. */
  replayOrigin?: string;
  /** Data origin; defaults to DATA_ORIGIN. */
  dataOrigin?: string;
}

/** replayLink is the replay page for a game, opened at a sim frame if given
 * (the viewer reads ?f= once the replay loads). */
export function replayLink(gameId: string, frame?: number, origin = REPLAY_ORIGIN): string {
  const base = `${origin}/replays/${encodeURIComponent(gameId)}`;
  return frame != null && frame > 0 ? `${base}?f=${Math.round(frame)}` : base;
}

/** ridPath turns a rid (a relative path since month folders) into a URL
 * path, escaping each segment — the twin of app.js ridPath. */
function ridPath(rid: string): string {
  return rid.split("/").map(encodeURIComponent).join("/");
}

/** findInsights returns the newest insights file published for gameId, or
 * null when the game has no playable replay or no summary built yet. A
 * failure other than "not there" throws. */
export async function findInsights(gameId: string, opts: EmbedOptions = {}): Promise<Insights | null> {
  const replayOrigin = opts.replayOrigin ?? REPLAY_ORIGIN;
  const dataOrigin = opts.dataOrigin ?? DATA_ORIGIN;
  const res = await fetch(`${replayOrigin}/api/replays?id=${encodeURIComponent(gameId)}&limit=2`);
  if (!res.ok) throw new Error(`replay catalog: HTTP ${res.status}`);
  const rows = (await res.json()) as { id: string; rid?: string | null; placeholder?: boolean }[];
  // ?id= is a PREFIX match, so the row must be checked to be this game; a
  // placeholder is a game still being worked on, with nothing published.
  const row = Array.isArray(rows) ? rows.find((r) => r.id === gameId && !r.placeholder) : undefined;
  if (!row) return null;
  const rid = row.rid ?? row.id;
  for (const v of INSIGHTS_VERSIONS) {
    const r = await fetch(`${dataOrigin}/replays/${ridPath(rid)}.insights${v}.json`);
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`insights: HTTP ${r.status}`);
    return (await r.json()) as Insights;
  }
  return null;
}

/** mountGameSummary draws gameId's summary into el and returns its handle,
 * or null (el untouched) when the game has no summary to show. A click on a
 * moment opens the replay at it in a new tab unless the host passes its own
 * onClip/onSeek. */
export async function mountGameSummary(el: HTMLElement, gameId: string, opts: EmbedOptions = {}): Promise<SummaryHandle | null> {
  const ins = await findInsights(gameId, opts);
  if (!ins) return null;
  const { replayOrigin = REPLAY_ORIGIN, dataOrigin: _d, ...rest } = opts;
  // Icons live beside the viewer; bundled into another site, the module's
  // own origin (icons.ts's default) would be that site's.
  const summaryOpts: SummaryOptions = { iconBase: replayOrigin, ...rest };
  if (!summaryOpts.onClip && !summaryOpts.onSeek) {
    summaryOpts.onSeek = (f) => window.open(replayLink(gameId, f, replayOrigin), "_blank", "noopener");
  }
  return mountSummary(el, ins, summaryOpts);
}
