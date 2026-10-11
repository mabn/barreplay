// Who was ahead, and why: the swing chart (a win probability, swing.ts) when
// the file carries one; under it, on the same time axis and one shared
// crosshair, the two inputs that move it most — army value and metal income —
// each as a RATIO between the sides by default (how far ahead the leader is)
// or as both sides' VALUES. Stacked that way a shift in the line sits right
// above the army or the economy that caused it.
import { h, s, section } from "../dom";
import { fmtMetal } from "../format";
import { bandPath, chartGroup, fadeMask, linePath, stepAt, timeChart, type ChartGroup } from "../chart";
import { mirrorKey } from "../legend";
import { comparable, sideColor, sideName } from "../model";
import { swingChart } from "./swing";
import { leadPct, maxOf, ratioDomain, stepTimes } from "../series";
import { pairToggle, scaleToggle } from "../scale";
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
  const sw = swingChart(ins, opts, watch, group);
  const top: Node[] = sw ? [sw.key, sw.hint, sw.svg] : [mirrorKey(ins)];
  return section(sw ? "Who was winning" : "Army advantage",
    ...top,
    ...comparePanel(ins, watch, group, t, {
      name: "Army value", lead: "Army lead", values: ins.series.army, k: ARMY_K, fmt: fmtMetal, logUnit: 100, height: 130, xAxis: false,
      info: "The metal in each side's armed mobile units (commanders excluded), weighted by how far each is built.",
    }),
    ...comparePanel(ins, watch, group, t, {
      name: "Metal income", lead: "Income lead", values: ins.series.metalIncome, k: INCOME_K, fmt: (v) => `${Math.round(v)}/s`, logUnit: 1, height: 130, xAxis: true,
      info: "The metal each side made per second, averaged over each step.",
    }),
    sw?.list ? h("h3", { style: "margin-top: 16px" }, "Biggest swings") : null,
    sw?.list ?? null);
}

/** The ratio charts' smoothing (leadPct's k), the win model's own constants
 * (internal/insights/swing.go swingArmyK, swingIncomeK), so the line reads
 * what the model reads: metal for army, metal/s for income. */
const ARMY_K = 300;
const INCOME_K = 3;

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

/** CompareSpec describes one two-mode panel comparing the sides on one
 * measure. */
interface CompareSpec {
  name: string;
  /** The tooltip line saying who leads it, unique within the group. */
  lead: string;
  /** What the label's (i) says about the measure itself. */
  info: string;
  values: number[][];
  /** Added to both sides before taking the ratio (see leadPct). */
  k: number;
  /** Formats a value for the tooltip and a value-mode tick. */
  fmt: (v: number) => string;
  /** The log axis's linear stretch near zero. */
  logUnit: number;
  height: number;
  /** Draws the minutes axis (the bottom panel of the stack). */
  xAxis: boolean;
}

/** comparePanel is a label with its switches and a chart redrawn in place on
 * a switch. RATIO (the default) is how far ahead one side is: the first side
 * a flat line at 0%, the second plotted at how much bigger it is (+20%) or
 * how much bigger the first is (-20%), so the gap reads directly and the
 * same at minute five as at minute fifty. VALUE is both sides' absolute
 * numbers, with a Linear/Log switch of its own (log by default) that the
 * ratio, being a percentage, has no use for and hides. */
function comparePanel(ins: Insights, watch: Watch | null, group: ChartGroup, t: number[], spec: CompareSpec): HTMLElement[] {
  const holder = h("div");
  let value = false;
  let log = true;
  const draw = () => {
    const old = holder.firstElementChild;
    // The old chart leaves the shared crosshair with its svg.
    if (old) group.members = group.members.filter((m) => !old.contains(m.hair));
    holder.replaceChildren(value ? valueChart(ins, watch, group, t, spec, log) : ratioChart(ins, watch, group, t, spec));
  };
  draw();
  const scale = scaleToggle(log, (l) => { log = l; draw(); });
  scale.hidden = true;
  const mode = pairToggle(["Ratio", "Value"], value, (v) => { value = v; scale.hidden = !v; draw(); }, "Show");
  const lab = label(spec.name, `${spec.info} Ratio shows how far ahead the leading side is: ${sideName(ins, 0)} is the flat line at 0%, and the other line is ${sideName(ins, 1)} — at +20% when it has 20% more, at -20% when ${sideName(ins, 0)} has 20% more. Value shows both sides' own numbers.`);
  lab.append(mode, scale);
  return [lab, holder];
}

/** pctText is a lead in percent, signless (the tooltip names the leader). */
function pctText(v: number): string {
  const a = Math.abs(v);
  return `${a < 10 ? a.toFixed(1).replace(/\.0$/, "") : Math.round(a)}%`;
}

/** OVERFLOW is how far, in chart pixels, a ratio line runs past its scale
 * before it has faded out (chart.ts fadeMask). */
const OVERFLOW = 16;

function ratioChart(ins: Insights, watch: Watch | null, group: ChartGroup, t: number[], spec: CompareSpec): SVGSVGElement {
  const [a, b] = spec.values;
  const r = leadPct(a, b, spec.k);
  // Scaled to the middle-to-late game (ratioDomain); outside it the lead
  // runs off the edge into a strip where it fades out, and the tooltip has
  // the number.
  const [lo, hi] = ratioDomain(t, r, ins.durationSec);
  const overflow = { top: r.some((v) => v > hi) ? OVERFLOW : 0, bottom: r.some((v) => v < lo) ? OVERFLOW : 0 };
  const c = timeChart({
    height: spec.height, durationSec: ins.durationSec, yMin: lo, yMax: hi, zeroLine: true, xAxis: spec.xAxis, overflow,
    yTick: (v) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${pctText(v)}`, gutter: GUTTER, watch, group,
    readout: (tt) => {
      const i = stepAt(t, tt);
      if (i < 0) return null;
      const lead = r[i];
      const ahead = Math.abs(lead) < 0.5 ? -1 : lead > 0 ? 1 : 0;
      return [0, 1].flatMap((sd): TipRow[] => [
        { color: sideColor(ins, sd), label: sideName(ins, sd), metric: spec.name, value: spec.fmt(spec.values[sd][i] ?? 0) },
        { color: sideColor(ins, sd), label: sideName(ins, sd), metric: spec.lead, value: ahead < 0 ? "even" : ahead === sd ? pctText(lead) : "" },
      ]);
    },
  });
  // The lead shaded in the leader's colour: above the line the second side,
  // below it the first.
  const zero = t.map(() => 0);
  // Past the strip a lead is clamped to the chart's very edge, where the
  // mask has faded it to nothing.
  const perPx = (hi - lo) / Math.max(1, c.y(lo) - c.y(hi));
  const edgeHi = hi + overflow.top * perPx;
  const edgeLo = lo - overflow.bottom * perPx;
  const shown = r.map((v) => Math.max(edgeLo, Math.min(edgeHi, v)));
  const marks = s("g", overflow.top || overflow.bottom ? { mask: `url(#${fadeMask(c, overflow)})` } : {});
  c.plot.append(marks);
  marks.append(
    s("path", { d: bandPath(c, t, zero, shown.map((v) => Math.max(0, v))), fill: sideColor(ins, 1), "fill-opacity": 0.25 }),
    s("path", { d: bandPath(c, t, shown.map((v) => Math.min(0, v)), zero), fill: sideColor(ins, 0), "fill-opacity": 0.25 }),
    s("path", { d: linePath(c, t, zero), fill: "none", stroke: sideColor(ins, 0), "stroke-width": 2 }),
    s("path", { d: linePath(c, t, shown), fill: "none", stroke: sideColor(ins, 1), "stroke-width": 2 }),
  );
  return c.svg;
}

function valueChart(ins: Insights, watch: Watch | null, group: ChartGroup, t: number[], spec: CompareSpec, log: boolean): SVGSVGElement {
  const v = spec.values;
  const peak = Math.max(1, maxOf(v[0], v[1]));
  const c = timeChart({
    height: spec.height, durationSec: ins.durationSec, yMin: 0, yMax: peak * 1.05, xAxis: spec.xAxis, log: log ? { unit: spec.logUnit } : undefined,
    yTick: (y) => (y >= 1000 ? fmtMetal(y) : String(Math.round(y))), gutter: GUTTER, watch, group,
    readout: (tt) => {
      const i = stepAt(t, tt);
      return i < 0 ? null : [0, 1].map((sd) => ({ color: sideColor(ins, sd), label: sideName(ins, sd), metric: spec.name, value: spec.fmt(v[sd][i] ?? 0) }));
    },
  });
  for (const side of [0, 1]) {
    c.plot.append(s("path", { d: linePath(c, t, v[side]), fill: "none", stroke: sideColor(ins, side), "stroke-width": 2 }));
  }
  return c.svg;
}
