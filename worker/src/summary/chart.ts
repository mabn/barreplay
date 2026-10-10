// A time-axis chart frame shared by the summary's charts: an SVG with a
// viewBox (so it scales with its container), the plot area, a minutes axis,
// horizontal grid, and a crosshair that reads the time under the pointer.
// A click seeks the replay to that moment when the host gave an onSeek.
import { s } from "./dom";
import { fmtClock, niceStep, timeStep } from "./format";
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
  /** Called with the game time under the pointer, for the readout. */
  readout?: (t: number) => string;
  onSeek?: (frame: number) => void;
  /** Draws the zero line strongly (a difference chart). */
  zeroLine?: boolean;
}

export function timeChart(spec: TimeChartSpec): TimeChart {
  const left = spec.yTick ? 52 : 8;
  const right = CHART_W - 10;
  const top = 8;
  const bottom = spec.height - 22;
  const dur = Math.max(1, spec.durationSec);
  const span = spec.yMax - spec.yMin || 1;
  const x = (t: number) => left + (Math.max(0, Math.min(dur, t)) / dur) * (right - left);
  const y = (v: number) => bottom - ((v - spec.yMin) / span) * (bottom - top);

  const svg = s("svg", { viewBox: `0 0 ${CHART_W} ${spec.height}`, role: "img" });
  const grid = s("g", { stroke: "var(--brs-grid)", "stroke-width": 1 });
  svg.append(grid);
  if (spec.yTick) {
    const step = niceStep(span, 4);
    for (let v = Math.ceil(spec.yMin / step) * step; v <= spec.yMax + 1e-9; v += step) {
      const yy = y(v);
      grid.append(s("line", { x1: left, x2: right, y1: yy, y2: yy }));
      svg.append(s("text", { x: left - 6, y: yy + 4, "text-anchor": "end" }, spec.yTick(v)));
    }
  }
  if (spec.zeroLine && spec.yMin < 0 && spec.yMax > 0) {
    svg.append(s("line", { x1: left, x2: right, y1: y(0), y2: y(0), stroke: "var(--brs-muted)", "stroke-width": 1 }));
  }
  const tStep = timeStep(dur, 10);
  for (let t = 0; t <= dur; t += tStep) {
    svg.append(s("text", { x: x(t), y: spec.height - 6, "text-anchor": "middle" }, String(Math.round(t / 60)) + "m"));
  }
  svg.append(s("line", { x1: left, x2: right, y1: bottom, y2: bottom, stroke: "var(--brs-line)" }));

  const plot = s("g");
  svg.append(plot);

  // Crosshair + readout, and the hit area that drives them.
  const hair = s("line", { y1: top, y2: bottom, stroke: "var(--brs-text)", "stroke-opacity": 0.5, visibility: "hidden" });
  const label = s("text", { y: top + 10, visibility: "hidden", style: "fill: var(--brs-text)" });
  const hit = s("rect", {
    x: left, y: top, width: right - left, height: bottom - top, fill: "transparent",
    class: spec.onSeek ? "brs-clickable" : null,
  });
  svg.append(hair, label, hit);
  const timeAt = (ev: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * CHART_W;
    return ((Math.max(left, Math.min(right, px)) - left) / (right - left)) * dur;
  };
  hit.addEventListener("mousemove", (ev) => {
    const t = timeAt(ev);
    const xx = x(t);
    hair.setAttribute("x1", String(xx));
    hair.setAttribute("x2", String(xx));
    hair.setAttribute("visibility", "visible");
    const text = fmtClock(t) + (spec.readout ? "  " + spec.readout(t) : "");
    label.textContent = text;
    const leftSide = xx > (left + right) / 2;
    label.setAttribute("x", String(leftSide ? xx - 6 : xx + 6));
    label.setAttribute("text-anchor", leftSide ? "end" : "start");
    label.setAttribute("visibility", "visible");
  });
  hit.addEventListener("mouseleave", () => {
    hair.setAttribute("visibility", "hidden");
    label.setAttribute("visibility", "hidden");
  });
  if (spec.onSeek) {
    const seek = spec.onSeek;
    hit.addEventListener("click", (ev) => seek(Math.round(timeAt(ev) * SIM_FPS)));
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
