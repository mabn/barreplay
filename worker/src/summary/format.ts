// Number and time formatting. Pure, so the node tests can pin it.

/** fmtClock renders game seconds as m:ss, or h:mm:ss past an hour. */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** fmtMetal renders a metal amount the way BAR's own UI does: 950, 7.0k,
 * 504k, 3.7M. Fixed precision per band, so a value does not jitter in width. */
export function fmtMetal(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e6) return sign + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e5) return sign + Math.round(a / 1e3) + "k";
  if (a >= 1e3) return sign + (a / 1e3).toFixed(1) + "k";
  return sign + Math.round(a);
}

/** niceStep picks a round axis step (1, 2 or 5 times a power of ten) that
 * splits span into at most `ticks` intervals. */
export function niceStep(span: number, ticks: number): number {
  if (!(span > 0) || ticks < 1) return 1;
  const raw = span / ticks;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** timeStep picks a round step for a time axis: 1, 2, 5, 10, 15, 20, 30 or 60
 * minutes, in seconds. */
export function timeStep(spanSec: number, ticks: number): number {
  for (const m of [1, 2, 5, 10, 15, 20, 30, 60]) if (spanSec / (m * 60) <= ticks) return m * 60;
  return 3600;
}
