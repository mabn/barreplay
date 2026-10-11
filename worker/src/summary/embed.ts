// The summary for a site that is not the replay viewer: given a game id,
// find the replay's published revision, fetch its insights and mount them.
// It exists so that the knowledge of WHERE things are — the catalog route,
// the data origin, how a rid becomes a path, which insights versions exist —
// stays in this repo, next to the code that publishes them. A host imports
// it at run time from https://replay.fogofwar.dev/embed/summary.js (a stable,
// no-cache name forwarding to this module's fingerprinted build; see
// vite.config.ts) and calls mountGameSummary; it never learns what a rid is,
// and a deploy here reaches it with no change on its side.
//
// Everything is fetched from the replay viewer's deployment at run time, so
// nothing is copied between the two sites. The catalog route and the data
// bucket both answer cross-origin reads for that reason (app.ts, r2-cors.json).
import { INSIGHTS_VERSIONS, mountLoading, mountSummary } from "./index";
import type { Clip, Insights, SummaryHandle, SummaryOptions } from "./types";

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

/** clipPlayer returns an onClip that plays each clip in a window over the
 * host page: the replay viewer's own clip player, framed (app.js
 * ?embed=clip), so the map, its streaming and its drawing are the viewer's
 * and nothing is reimplemented here. The frame is made on the first clip and
 * kept, hidden, between clips, so a second clip needs no reload; clips go to
 * it by postMessage once it says it is ready. Escape, the window's close
 * button, or a click outside hides it. */
export function clipPlayer(gameId: string, origin = REPLAY_ORIGIN): (c: Clip) => void {
  let box: HTMLDivElement | null = null;
  let frame: HTMLIFrameElement | null = null;
  let ready = false;
  let pending: Clip | null = null;
  const send = (c: Clip) => frame?.contentWindow?.postMessage({ type: "barreplay:clip", clip: c }, origin);
  const hide = () => {
    if (box) box.style.display = "none";
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && box?.style.display !== "none") hide();
  };
  return (c: Clip) => {
    if (!box) {
      box = document.createElement("div");
      box.style.cssText =
        "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)";
      box.addEventListener("click", (e) => {
        if (e.target === box) hide();
      });
      frame = document.createElement("iframe");
      frame.title = "Replay clip";
      frame.allow = "fullscreen";
      frame.style.cssText =
        "width:min(960px,calc(100vw - 32px));height:min(640px,calc(100vh - 32px));border:1px solid #3a4856;border-radius:8px;background:#11151a;box-shadow:0 14px 44px rgba(0,0,0,.6)";
      frame.src = `${replayLink(gameId, undefined, origin)}?embed=clip`;
      box.append(frame);
      document.body.append(box);
      window.addEventListener("keydown", onKey);
      window.addEventListener("message", (e) => {
        if (e.origin !== origin || e.source !== frame?.contentWindow) return;
        const t = (e.data as { type?: string } | null)?.type;
        if (t === "barreplay:ready") {
          ready = true;
          if (pending) send(pending);
          pending = null;
        } else if (t === "barreplay:close") {
          hide();
        }
      });
    }
    box.style.display = "flex";
    if (ready) send(c);
    else pending = c;
    frame?.focus();
  };
}

/** ridPath turns a rid (a relative path since month folders) into a URL
 * path, escaping each segment — the twin of app.js ridPath. */
function ridPath(rid: string): string {
  return rid.split("/").map(encodeURIComponent).join("/");
}

/** findInsights returns the newest insights file for gameId, or null when
 * the game has no playable replay or no summary could be had. One older than
 * this build draws, or missing at every version, is computed on demand and
 * WAITED for (POST /api/insights); an older one is the fallback only when that
 * request cannot answer. onWait is called once, just before that wait starts
 * (mountGameSummary draws the loading scene there). A failure other than
 * "not there" throws. */
export async function findInsights(gameId: string, opts: EmbedOptions = {}, onWait?: () => void): Promise<Insights | null> {
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
    const ins = (await r.json()) as Insights;
    if (v === INSIGHTS_VERSIONS[0]) return ins;
    // Older than this build draws: wait for the current one, computed on
    // demand, and fall back to this one only when that cannot answer.
    onWait?.();
    return (await requestSummary(replayOrigin, rid)) ?? ins;
  }
  // None at all: worth waiting for, since there is nothing else to show —
  // past the hub's 15 s too, for a big game whose summary takes longer.
  onWait?.();
  return requestSummary(replayOrigin, rid, NO_SUMMARY_WAIT_MS);
}

/** How long a page with NO summary at all keeps waiting for one. Each
 * request answers within the hub's 15 s; one that runs out (504) is asked
 * again, which joins the computation still running rather than starting
 * another, until this much time has passed. A big game takes longer than
 * 15 s to download and compute, and without this its first reader was told
 * the summary "has not been built" while it was being built. */
export const NO_SUMMARY_WAIT_MS = 120_000;

/** requestSummary asks the viewer's worker for rid's summary at the newest
 * version (POST /api/insights), which computes it on demand and answers with
 * it; null when it cannot (no daemon, too busy, failed). A timeout is asked
 * again while waitMs (from the first request) lasts. A text/plain body
 * keeps the cross-origin POST a simple request — no preflight — and the
 * route answers any origin, so the reply can be read. */
async function requestSummary(replayOrigin: string, rid: string, waitMs = 0): Promise<Insights | null> {
  const until = Date.now() + waitMs;
  try {
    for (;;) {
      const r = await fetch(`${replayOrigin}/api/insights`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ rid, version: INSIGHTS_VERSIONS[0] }),
      });
      if (r.ok) return (await r.json()) as Insights;
      if (r.status !== 504 || Date.now() >= until) return null;
    }
  } catch {
    return null;
  }
}

/** mountGameSummary draws gameId's summary into el and returns its handle,
 * or null (el untouched) when the game has no summary to show. A click on a
 * moment plays it in a clip window over the page (clipPlayer), like the
 * viewer's own summary does, unless the host passes its own onClip/onSeek. */
export async function mountGameSummary(el: HTMLElement, gameId: string, opts: EmbedOptions = {}): Promise<SummaryHandle | null> {
  let loading: SummaryHandle | null = null;
  let ins: Insights | null;
  try {
    ins = await findInsights(gameId, opts, () => (loading = mountLoading(el)));
  } finally {
    (loading as SummaryHandle | null)?.destroy();
  }
  if (!ins) return null;
  const { replayOrigin = REPLAY_ORIGIN, dataOrigin: _d, ...rest } = opts;
  // Icons live beside the viewer; bundled into another site, the module's
  // own origin (icons.ts's default) would be that site's. Maps go through the
  // viewer's caching BAR API proxy (app.ts barProxy) for the same reason.
  const summaryOpts: SummaryOptions = { iconBase: replayOrigin, mapApi: `${replayOrigin}/api/bar`, ...rest };
  if (!summaryOpts.onClip && !summaryOpts.onSeek) {
    summaryOpts.onClip = clipPlayer(gameId, replayOrigin);
    summaryOpts.onSeek = (f) => window.open(replayLink(gameId, f, replayOrigin), "_blank", "noopener");
  }
  return mountSummary(el, ins, summaryOpts);
}
