// Small helpers over the insights series. Pure.
import type { Insights } from "./types";

/** stepTimes places each step at the END of its window (clamped to the game's
 * length): a step holds its window's last army sample and the mean income
 * over it, so the end is when that value was true. */
export function stepTimes(ins: Insights): number[] {
  return ins.series.t.map((t) => Math.min(ins.durationSec, t + ins.stepSec));
}

/** maxOf is the largest value in any of the arrays (0 when all are empty). */
export function maxOf(...arrays: number[][]): number {
  let m = 0;
  for (const a of arrays) for (const v of a) if (v > m) m = v;
  return m;
}

/** diff is a[i] - b[i]. */
export function diff(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - (b[i] ?? 0));
}

/** leadPct is how much bigger the larger of two sides is than the smaller, in
 * percent: positive when b leads (b 20% above a reads +20), negative when a
 * does (a 20% above b reads -20). Reading the leader against the trailer both
 * ways keeps the axis symmetric — "a third smaller" and "half again bigger"
 * are the same gap. k is added to both sides first, so the opening minutes,
 * when both are near zero, read as even rather than as an infinite lead
 * (the win model smooths its inputs the same way). */
export function leadPct(a: number[], b: number[], k: number): number[] {
  return a.map((va, i) => {
    const x = Math.max(0, va) + k;
    const y = Math.max(0, b[i] ?? 0) + k;
    return y >= x ? 100 * (y / x - 1) : -100 * (x / y - 1);
  });
}

/** The share of a game a ratio chart scales to: from 40% to 95% of it.
 * Before that both sides own next to nothing and the ratio runs to
 * thousands of percent; the last minutes of a decided game do the same. */
export const RATIO_WINDOW: [number, number] = [0.4, 0.95];

/** ratioDomain is the y range a lead chart (leadPct) is drawn over: the
 * lowest and highest lead inside RATIO_WINDOW of the game, with zero (the
 * first side's line) always in it and a little room either side. Leads
 * outside it run off the chart's edge. */
export function ratioDomain(t: number[], lead: number[], durationSec: number): [number, number] {
  const [w0, w1] = RATIO_WINDOW.map((x) => x * durationSec);
  let inWin = lead.filter((v, i) => Number.isFinite(v) && t[i] >= w0 && t[i] <= w1);
  if (!inWin.length) inWin = lead.filter(Number.isFinite);
  let lo = Math.min(0, ...inWin);
  let hi = Math.max(0, ...inWin);
  const pad = Math.max(2, (hi - lo) * 0.05);
  if (lo < 0) lo -= pad;
  if (hi > 0) hi += pad;
  if (hi - lo < 10) {
    // A dead even game still gets a readable axis.
    const grow = (10 - (hi - lo)) / 2;
    lo -= grow;
    hi += grow;
  }
  return [lo, hi];
}
