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
