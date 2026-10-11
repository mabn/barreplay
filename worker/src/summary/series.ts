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
