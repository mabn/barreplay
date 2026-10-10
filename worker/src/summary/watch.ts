// Watching a moment. Every link in the summary that shows the game asks for a
// CLIP — a span of sim frames, and where on the map it happened when that is
// known — rather than a bare frame, so a host can play it in place (the
// viewer opens a small player over the summary) instead of leaving the page.
// A host that only offers onSeek gets the clip's first frame.
import { SIM_FPS, type Clip, type SummaryOptions } from "./types";

/** Seconds of lead-in before a moment: enough to see it arrive, short enough
 * that whoever opens the clip is not left waiting for it. */
export const LEAD_IN_SEC = 5;
/** Seconds a clip runs on past its moment. */
export const TAIL_SEC = 5;
/** How long a clip around a single instant runs after it. */
export const AFTER_SEC = 20;
/** The longest a clip runs past its instant, however long the span it
 * explains: past that the moment is lost in what follows. */
export const MAX_AFTER_SEC = 60;

export type Watch = (clip: Clip) => void;

/** watcher is how this host shows a clip, or null when it cannot (and then
 * nothing in the summary is clickable). */
export function watcher(opts: SummaryOptions): Watch | null {
  if (opts.onClip) return opts.onClip;
  if (opts.onSeek) {
    const seek = opts.onSeek;
    return (c) => seek(c.f0);
  }
  return null;
}

/** clipAround is a clip around one instant: a lead-in, then a while after,
 * with the instant marked (Clip.at) so the host can show when it comes. */
export function clipAround(f: number, extra: Partial<Clip> = {}): Clip {
  return { ...extra, at: Math.round(f), f0: Math.max(0, Math.round(f - LEAD_IN_SEC * SIM_FPS)), f1: Math.round(f + AFTER_SEC * SIM_FPS) };
}

/** clipSpan is a clip over [f0, f1], with a lead-in and a short tail; its
 * start is the instant marked. */
export function clipSpan(f0: number, f1: number, extra: Partial<Clip> = {}): Clip {
  return { ...extra, at: Math.round(f0), f0: Math.max(0, Math.round(f0 - LEAD_IN_SEC * SIM_FPS)), f1: Math.round(f1 + TAIL_SEC * SIM_FPS) };
}

/** clipAt is a clip of the instant at that explains a span ending at end:
 * it opens a lead-in before the instant, not at the span's start, and runs
 * on to the span's end (at least AFTER_SEC, at most MAX_AFTER_SEC). */
export function clipAt(at: number, end: number, extra: Partial<Clip> = {}): Clip {
  const f1 = Math.min(at + MAX_AFTER_SEC * SIM_FPS, Math.max(at + AFTER_SEC * SIM_FPS, end + TAIL_SEC * SIM_FPS));
  return { ...extra, at: Math.round(at), f0: Math.max(0, Math.round(at - LEAD_IN_SEC * SIM_FPS)), f1: Math.round(f1) };
}

/** watchNote is the tooltip line saying what a click does. */
export function watchNote(w: Watch | null): string | undefined {
  return w ? "Click to watch" : undefined;
}
