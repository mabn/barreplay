// A time-axis chart frame shared by the summary's charts: an SVG with a
// viewBox (so it scales with its container), the plot area, a minutes axis,
// horizontal grid, and a crosshair whose readout opens in the shared
// tooltip. Charts in one group share the crosshair — hovering one draws it
// through all of them and the tooltip lists every chart's readout — which is
// how stacked charts on the same time axis read as one figure. A click plays
// the moment under the pointer when the host can.
import { s } from "./dom";
import { fmtClock, niceStep, timeStep } from "./format";
import { hideTip, showTip, type TipRow } from "./tooltip";
import { clipAround, type Watch } from "./watch";
import { SIM_FPS } from "./types";

export const CHART_W = 1000;

export interface TimeChart {
  svg: SVGSVGElement;
  /** The layer marks are drawn into, under the crosshair. */
  plot: SVGGElement;
  x(t: number): number;
  y(v: number): number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface TimeChartSpec {
  height: number;
  durationSec: number;
  yMin: number;
  yMax: number;
  /** Formats a y tick. Null draws no y axis. */
  yTick: ((v: number) => string) | null;
  /** The tooltip rows for the game time under the pointer. */
  readout?: (t: number) => TipRow[] | null;
  /** Plays the moment under the pointer on a click. */
  watch?: Watch | null;
  /** Charts sharing one crosshair and one tooltip. */
  group?: ChartGroup;
  /** False leaves out the minutes axis (a chart stacked above another
   * that draws it). */
  xAxis?: boolean;
  /** Draws the zero line strongly (a difference chart). */
  zeroLine?: boolean;
  /** Width of the left gutter, overriding the y axis's; row labels live in
   * it so they never sit on the data. */
  gutter?: number;
  /** A LOG y scale whose linear stretch near zero is `unit` wide (symlog:
   * sign(v)·log10(1 + |v|/unit)), so zero and negatives — a mirrored chart's
   * lower half — still have a place. Ticks fall on powers of ten. */
  log?: { unit: number };
  /** Pixels kept free above yMax and below yMin, for marks that run past
   * the range to fade out in (fadeMask). */
  overflow?: { top: number; bottom: number };
}

/** tickText drops a ".0" from an axis label ("1.0k" -> "1k", "2.0M" ->
 * "2M"): a tick is a round number, and the summary is not that precise.
 * Tooltips keep their decimals. */
export function tickText(t: string): string {
  return t.replace(/\.0+(?=\D|$)/g, "");
}

/** symlog is the log scale's transform. */
export function symlog(v: number, unit: number): number {
  return Math.sign(v) * Math.log10(1 + Math.abs(v) / unit);
}

/** logTicks are the values a log axis over [lo, hi] marks: zero when it is in
 * range, and every power of ten from unit up, either side. */
export function logTicks(lo: number, hi: number, unit: number): number[] {
  const out: number[] = [];
  if (lo <= 0 && hi >= 0) out.push(0);
  for (let p = Math.pow(10, Math.ceil(Math.log10(unit))); p <= Math.max(Math.abs(lo), Math.abs(hi)) * 1.0001; p *= 10) {
    if (p <= hi) out.push(p);
    if (-p >= lo) out.push(-p);
  }
  return out.sort((a, b) => a - b);
}

/** ChartGroup ties charts to one crosshair. */
export interface ChartGroup {
  members: { hair: SVGLineElement; x: (t: number) => number; readout?: (t: number) => TipRow[] | null }[];
}

export function chartGroup(): ChartGroup {
  return { members: [] };
}

export function timeChart(spec: TimeChartSpec): TimeChart {
  const left = spec.gutter ?? (spec.yTick ? 52 : 8);
  const right = CHART_W - 10;
  const top = 8;
  const bottom = spec.height - (spec.xAxis === false ? 4 : 22);
  const dur = Math.max(1, spec.durationSec);
  const span = spec.yMax - spec.yMin || 1;
  const x = (t: number) => left + (Math.max(0, Math.min(dur, t)) / dur) * (right - left);
  const log = spec.log;
  const tf = (v: number) => (log ? symlog(v, log.unit) : v);
  const t0 = tf(spec.yMin);
  const tspan = tf(spec.yMax) - t0 || 1;
  const ov = spec.overflow ?? { top: 0, bottom: 0 };
  const y = (v: number) => bottom - ov.bottom - ((tf(v) - t0) / tspan) * (bottom - top - ov.top - ov.bottom);

  const svg = s("svg", { viewBox: `0 0 ${CHART_W} ${spec.height}`, role: "img" });
  const grid = s("g", { stroke: "var(--brs-grid)", "stroke-width": 1 });
  svg.append(grid);
  if (spec.yTick) {
    const step = niceStep(span, 4);
    const ticks: number[] = [];
    if (log) ticks.push(...logTicks(spec.yMin, spec.yMax, log.unit));
    else for (let v = Math.ceil(spec.yMin / step) * step; v <= spec.yMax + 1e-9; v += step) ticks.push(v);
    // Labels closer than a line apart would print over each other (a log
    // axis's first power of ten sits just off zero): zero wins, then the rest
    // in order.
    const drawn: number[] = [];
    for (const v of ticks.sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : 0))) {
      const yy = y(v);
      if (drawn.some((d) => Math.abs(d - yy) < 14)) continue;
      drawn.push(yy);
      grid.append(s("line", { x1: left, x2: right, y1: yy, y2: yy }));
      svg.append(s("text", { x: left - 6, y: yy + 4, "text-anchor": "end" }, tickText(spec.yTick(v))));
    }
  }
  if (spec.zeroLine && spec.yMin < 0 && spec.yMax > 0) {
    svg.append(s("line", { x1: left, x2: right, y1: y(0), y2: y(0), stroke: "var(--brs-muted)", "stroke-width": 1 }));
  }
  if (spec.xAxis !== false) {
    const tStep = timeStep(dur, 10);
    for (let t = 0; t <= dur; t += tStep) {
      svg.append(s("text", { x: x(t), y: spec.height - 6, "text-anchor": "middle" }, String(Math.round(t / 60)) + "m"));
    }
    svg.append(s("line", { x1: left, x2: right, y1: bottom, y2: bottom, stroke: "var(--brs-line)" }));
  }

  const plot = s("g");
  svg.append(plot);

  // Crosshair, and the hit area that drives it and the tooltip.
  const hair = s("line", { y1: top, y2: bottom, stroke: "var(--brs-text)", "stroke-opacity": 0.5, visibility: "hidden", "pointer-events": "none" });
  const hit = s("rect", {
    x: left, y: top, width: right - left, height: bottom - top, fill: "transparent",
    class: spec.watch ? "brs-clickable" : null,
  });
  svg.append(hair, hit);
  const group = spec.group ?? chartGroup();
  group.members.push({ hair, x, readout: spec.readout });
  const timeAt = (ev: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * CHART_W;
    return ((Math.max(left, Math.min(right, px)) - left) / (right - left)) * dur;
  };
  hit.addEventListener("pointermove", (ev) => {
    const t = timeAt(ev);
    const rows: TipRow[] = [];
    for (const m of group.members) {
      const xx = String(m.x(t));
      m.hair.setAttribute("x1", xx);
      m.hair.setAttribute("x2", xx);
      m.hair.setAttribute("visibility", "visible");
      rows.push(...(m.readout?.(t) ?? []));
    }
    showTip(svg, ev.clientX, ev.clientY, { title: fmtClock(t), rows, note: spec.watch ? "Click to watch from here" : undefined });
  });
  hit.addEventListener("pointerleave", () => {
    for (const m of group.members) m.hair.setAttribute("visibility", "hidden");
    hideTip(svg);
  });
  if (spec.watch) {
    const watch = spec.watch;
    hit.addEventListener("click", (ev) => watch(clipAround(Math.round(timeAt(ev) * SIM_FPS))));
  }
  return { svg, plot, x, y, left, right, top, bottom };
}

/** linePath draws a polyline through (t[i], v[i]), skipping NaN gaps. */
export function linePath(c: TimeChart, t: number[], v: number[]): string {
  let d = "";
  let pen = false;
  for (let i = 0; i < t.length; i++) {
    if (!Number.isFinite(v[i])) {
      pen = false;
      continue;
    }
    d += (pen ? "L" : "M") + c.x(t[i]).toFixed(1) + "," + c.y(v[i]).toFixed(1);
    pen = true;
  }
  return d;
}

/** bandPath fills between lo[i] and hi[i]. */
export function bandPath(c: TimeChart, t: number[], lo: number[], hi: number[]): string {
  if (t.length === 0) return "";
  let d = "";
  for (let i = 0; i < t.length; i++) d += (i ? "L" : "M") + c.x(t[i]).toFixed(1) + "," + c.y(hi[i]).toFixed(1);
  for (let i = t.length - 1; i >= 0; i--) d += "L" + c.x(t[i]).toFixed(1) + "," + c.y(lo[i]).toFixed(1);
  return d + "Z";
}

/** stepAt is the series index holding game time t. */
export function stepAt(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

let maskSeq = 0;

/** fadeMask hides what a chart draws past its range gradually: marks in
 * the overflow strips above yMax and below yMin (TimeChartSpec.overflow)
 * fade out fast, so a line that runs off the scale reads as going on out of
 * sight rather than as a value sitting on the edge. Apply the returned id
 * as mask="url(#id)" on the group holding those marks. */
export function fadeMask(c: TimeChart, overflow: { top: number; bottom: number }): string {
  const id = `brs-fade-${++maskSeq}`;
  const h = c.bottom - c.top || 1;
  const stops: [number, number][] = [];
  // Opacity falls off steeply: half gone a quarter of the way out.
  if (overflow.top > 0) stops.push([0, 0], [overflow.top * 0.5 / h, 0.15], [overflow.top * 0.75 / h, 0.5]);
  stops.push([overflow.top / h, 1], [1 - overflow.bottom / h, 1]);
  if (overflow.bottom > 0) stops.push([1 - overflow.bottom * 0.75 / h, 0.5], [1 - overflow.bottom * 0.5 / h, 0.15], [1, 0]);
  const grad = s("linearGradient", { id: `${id}-g`, gradientUnits: "userSpaceOnUse", x1: 0, x2: 0, y1: c.top, y2: c.bottom },
    ...stops.map(([o, a]) => s("stop", { offset: o.toFixed(4), "stop-color": "#fff", "stop-opacity": a })));
  const mask = s("mask", { id, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: CHART_W, height: c.bottom + 4 },
    s("rect", { x: 0, y: c.top, width: CHART_W, height: h, fill: `url(#${id}-g)` }));
  c.svg.prepend(s("defs", {}, grad, mask));
  return id;
}
