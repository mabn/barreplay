// Watching a moment. Every link in the summary that shows the game asks for a
// CLIP — a span of sim frames, and where on the map it happened when that is
// known — rather than a bare frame, so a host can play it in place (the
// viewer opens a small player over the summary) instead of leaving the page.
// A host that only offers onSeek gets the frame playback would start at.
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
    return (c) => seek(c.start ?? c.f0);
  }
  return null;
}

/** Seconds of game a clip keeps BEFORE its moment at least, so the reader
 * can scroll back for context: the moment sits in the clip's middle (as much
 * before it as after), while playback still starts LEAD_IN_SEC before it. */
export const CONTEXT_SEC = 20;

/** framed puts the instant at in the middle of a clip ending at f1, with
 * playback starting LEAD_IN_SEC before it. */
function framed(at: number, f1: number, extra: Partial<Clip>): Clip {
  const f0 = Math.max(0, Math.round(at - Math.max(CONTEXT_SEC * SIM_FPS, f1 - at)));
  return { ...extra, at: Math.round(at), f0, start: Math.max(f0, Math.round(at - LEAD_IN_SEC * SIM_FPS)), f1: Math.round(f1) };
}

/** clipAround is a clip around one instant, AFTER_SEC either side of it,
 * with the instant marked (Clip.at) so the host can show when it comes. */
export function clipAround(f: number, extra: Partial<Clip> = {}): Clip {
  return framed(f, f + AFTER_SEC * SIM_FPS, extra);
}

/** clipSpan is a clip over [f0, f1] and a short tail; its start is the
 * instant marked. */
export function clipSpan(f0: number, f1: number, extra: Partial<Clip> = {}): Clip {
  return framed(f0, f1 + TAIL_SEC * SIM_FPS, extra);
}

/** clipAt is a clip of the instant at that explains a span ending at end:
 * it plays from a lead-in before the instant, not from the span's start, and
 * runs on to the span's end (at least AFTER_SEC, at most MAX_AFTER_SEC). */
export function clipAt(at: number, end: number, extra: Partial<Clip> = {}): Clip {
  return framed(at, Math.min(at + MAX_AFTER_SEC * SIM_FPS, Math.max(at + AFTER_SEC * SIM_FPS, end + TAIL_SEC * SIM_FPS)), extra);
}

/** clipEvent is a clip of an event with a START AND AN END (a raid, a
 * fight): CONTEXT_SEC before it, the WHOLE event — however long, since its
 * story counts what died to the end of it, and a clip cut at a minute showed
 * none of the losses a two-minute fight's last seconds held — and a short
 * tail, with the event marked as a band (Clip.atEnd). */
export function clipEvent(f0: number, f1: number, extra: Partial<Clip> = {}): Clip {
  const c0 = Math.max(0, Math.round(f0 - CONTEXT_SEC * SIM_FPS));
  return {
    ...extra, at: Math.round(f0), atEnd: Math.round(f1), f0: c0,
    start: Math.max(c0, Math.round(f0 - LEAD_IN_SEC * SIM_FPS)), f1: Math.round(f1 + TAIL_SEC * SIM_FPS),
  };
}

/** watchNote is the tooltip line saying what a click does. */
export function watchNote(w: Watch | null): string | undefined {
  return w ? "Click to watch" : undefined;
}
