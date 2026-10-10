// Who was ahead, and why: the swing chart (a win probability, swing.ts) when
// the file carries one, else the plain difference in army value a version 1
// file can give; under it, on the same time axis and one shared crosshair,
// the metal each side LOST and the metal income each side made. Stacked that
// way a shift in the line sits right above the fight or the economy that
// caused it.
import { h, s, section } from "../dom";
import { fmtMetal } from "../format";
import { bandPath, chartGroup, linePath, stepAt, timeChart, type ChartGroup } from "../chart";
import { mirrorKey } from "../legend";
import { lossesByStep } from "../losses";
import { comparable, sideColor, sideName } from "../model";
import { swingChart } from "./swing";
import { diff, maxOf, stepTimes } from "../series";
import { tip, type TipRow } from "../tooltip";
import { watcher, type Watch } from "../watch";
import type { Insights, SummaryOptions } from "../types";

/** Every chart here lines up on this gutter, so their time axes match. */
const GUTTER = 52;

export function advantage(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  if (!comparable(ins) || ins.series.t.length < 2) return null;
  const watch = watcher(opts);
  const group = chartGroup();
  const t = stepTimes(ins);
  const sw = swingChart(ins, watch, group);
  const top: Node[] = sw ? [sw.key, sw.hint, sw.svg] : armyLead(ins, watch, group, t);
  return section(sw ? "Who was winning" : "Army advantage",
    ...top,
    label(...lossLabel(ins)), lossChart(ins, watch, group),
    label("Metal income"), incomeChart(ins, watch, group, t),
    sw?.list ? h("h3", { style: "margin-top: 16px" }, "Biggest swings") : null,
    sw?.list ?? null);
}

/** label names a stacked panel, set in from the gutter like its plot, with
 * an (i) that explains it on hover when there is more to say. */
function label(text: string, info?: string): HTMLElement {
  const el = h("div", { class: "brs-panel-label", style: `padding-left: ${(GUTTER / 10).toFixed(1)}%` }, text);
  if (info) {
    const i = h("span", { class: "brs-info", tabindex: "0", "aria-label": info }, "i");
    tip(i, info);
    el.append(" ", i);
  }
  return el;
}

/** lossLabel names the losses panel and says what its bars measure. */
function lossLabel(ins: Insights): [string, string] {
  const L = lossesByStep(ins);
  const step = `${ins.stepSec} s`;
  const faint = " Faint bars on top are units that went down with an eliminated player rather than in a fight; they are left out of the scale.";
  if (L.owned) {
    return ["Metal lost", `Each bar is the metal a side lost in ${step}, as a share of everything it owned (units and buildings) when those ${step} began. A late unit costs a hundred times an early one, so the share makes a blow early and a blow late comparable; the tooltip also gives the metal. ${sideName(ins, 0)} is drawn above the line, ${sideName(ins, 1)} below. Reclaims, upgrades and cancelled builds are not losses.${faint}`];
  }
  if (L.priced) return ["Metal lost", `The metal each side lost in every ${step}.${faint}`];
  return ["Units lost", `The number of units each side lost in every ${step} (this replay does not price every unit).${faint}`];
}

/** lossChart: each side's losses per step, mirrored like the line above it
 * (the first side's above the axis). Drawn as a SHARE of what the side owned
 * when the step began whenever the file says (version 4+): a late unit costs
 * a hundred times an early one, so in raw metal every early fight is an
 * empty line under the last few minutes, where losing 5% of everything is
 * the same blow at minute five as at minute fifty. The scale is set by what
 * died FIGHTING;
 * units that went down with an eliminated team are drawn faint on top, and a
 * bar past the scale is cut at the edge with a notch, the full number in the
 * tooltip — at the end of a game they would otherwise flatten everything. */
function lossChart(ins: Insights, watch: Watch | null, group: ChartGroup): SVGSVGElement {
  const raw = lossesByStep(ins);
  const fmtRaw = (v: number) => (raw.priced ? fmtMetal(v) : String(Math.round(v)));
  const owned = raw.owned;
  // Plotted values: the share lost, in percent, when there is something to
  // share it of, else the raw loss.
  const plot = (rows: number[][]) => owned
    ? rows.map((row, sd) => row.map((v, i) => (owned[sd]?.[i] ?? 0) > 0 ? (100 * v) / owned[sd][i] : 0))
    : rows;
  const L = { combat: plot(raw.combat), wiped: plot(raw.wiped) };
  const fmt = (v: number) => (owned ? `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}%` : fmtRaw(v));
  const valueOf = (sd: number, i: number, rows: number[][], raws: number[][]) =>
    owned ? `${fmt(rows[sd]?.[i] ?? 0)} (${fmtRaw(raws[sd]?.[i] ?? 0)} metal)` : fmtRaw(raws[sd]?.[i] ?? 0);
  let top = Math.max(maxOf(L.combat[0] ?? [], L.combat[1] ?? []));
  if (top <= 0) top = Math.max(1, maxOf(L.wiped[0] ?? [], L.wiped[1] ?? []));
  const lim = top * 1.1;
  const n = ins.series.t.length;
  const c = timeChart({
    height: 120, durationSec: ins.durationSec, yMin: -lim, yMax: lim, zeroLine: true, xAxis: false,
    yTick: (v) => fmt(Math.abs(v)), gutter: GUTTER, watch, group,
    readout: (tt) => {
      const i = Math.min(n - 1, Math.floor(tt / ins.stepSec));
      if (i < 0) return null;
      return [0, 1].map((sd): TipRow => {
        const w = raw.wiped[sd]?.[i] ?? 0;
        return {
          color: sideColor(ins, sd), label: sideName(ins, sd), metric: "Metal lost",
          value: valueOf(sd, i, L.combat, raw.combat) + (w ? ` (+${valueOf(sd, i, L.wiped, raw.wiped)} eliminated)` : ""),
        };
      });
    },
  });
  for (const sd of [0, 1]) {
    const sign = sd === 0 ? 1 : -1;
    const color = sideColor(ins, sd);
    for (let i = 0; i < n; i++) {
      const a = L.combat[sd]?.[i] ?? 0;
      const w = L.wiped[sd]?.[i] ?? 0;
      if (!a && !w) continue;
      const x0 = c.x(i * ins.stepSec) + 0.5;
      const x1 = c.x((i + 1) * ins.stepSec) - 0.5;
      const bar = (from: number, to: number, opacity: number) => {
        const y0 = c.y(sign * Math.min(lim, from));
        const y1 = c.y(sign * Math.min(lim, to));
        c.plot.append(s("rect", { x: x0, y: Math.min(y0, y1), width: Math.max(1, x1 - x0), height: Math.abs(y1 - y0), fill: color, "fill-opacity": opacity }));
      };
      if (a) bar(0, a, 0.85);
      if (w) bar(a, a + w, 0.3);
      if (a + w > lim) {
        const ye = c.y(sign * lim);
        const xm = (x0 + x1) / 2;
        c.plot.append(s("path", { d: `M${x0},${ye}L${xm},${ye + sign * 5}L${x1},${ye}Z`, fill: "var(--brs-panel)" }));
      }
    }
  }
  return c.svg;
}

function incomeChart(ins: Insights, watch: Watch | null, group: ChartGroup, t: number[]): SVGSVGElement {
  const mi = ins.series.metalIncome;
  const peak = Math.max(1, maxOf(mi[0], mi[1]));
  const c = timeChart({
    height: 130, durationSec: ins.durationSec, yMin: 0, yMax: peak * 1.05,
    yTick: (v) => String(Math.round(v)), gutter: GUTTER, watch, group,
    readout: (tt) => {
      const i = stepAt(t, tt);
      return i < 0 ? null : [0, 1].map((sd) => ({ color: sideColor(ins, sd), label: sideName(ins, sd), metric: "Metal income", value: `${Math.round(mi[sd][i])}/s` }));
    },
  });
  for (const side of [0, 1]) {
    c.plot.append(s("path", { d: linePath(c, t, mi[side]), fill: "none", stroke: sideColor(ins, side), "stroke-width": 2 }));
  }
  return c.svg;
}

/** armyLead is the version 1 chart: the difference in army value. */
function armyLead(ins: Insights, watch: Watch | null, group: ChartGroup, t: number[]): Node[] {
  const [a, b] = ins.series.army;
  const d = diff(a, b);
  const lim = Math.max(1, maxOf(d.map(Math.abs)));
  const c = timeChart({
    height: 200, durationSec: ins.durationSec, yMin: -lim, yMax: lim, zeroLine: true, xAxis: false,
    yTick: (v) => fmtMetal(Math.abs(v)), gutter: GUTTER, watch, group,
    readout: (tt) => {
      const i = stepAt(t, tt);
      if (i < 0) return null;
      return [0, 1].map((sd) => ({ color: sideColor(ins, sd), label: sideName(ins, sd), metric: "Army value", value: fmtMetal(ins.series.army[sd][i]) }));
    },
  });
  // One band above the zero line in side 0's colour, one below in side 1's.
  const zero = t.map(() => 0);
  c.plot.append(
    s("path", { d: bandPath(c, t, zero, d.map((v) => Math.max(0, v))), fill: sideColor(ins, 0), "fill-opacity": 0.35 }),
    s("path", { d: bandPath(c, t, d.map((v) => Math.min(0, v)), zero), fill: sideColor(ins, 1), "fill-opacity": 0.35 }),
    s("path", { d: linePath(c, t, d), fill: "none", stroke: "var(--brs-text)", "stroke-width": 1.5 }),
  );
  return [
    mirrorKey(ins),
    h("p", { class: "brs-hint" }, "Difference in army value (metal in armed mobile units, commanders excluded). Above the line, the first side is ahead."),
    c.svg,
  ];
}
