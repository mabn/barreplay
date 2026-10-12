// Who was ahead, and why: the swing chart (a win probability, swing.ts) when
// the file carries one; under it, folded away until asked for, on the same
// time axis and one shared crosshair, three of the inputs that move it —
// army value, metal income and metal destroyed — each as a RATIO between the
// sides (how far ahead the leader is) or as the sides' VALUES (metal
// destroyed as per-step bars, one side up and one down). Opened, a shift in
// the line sits right above the army, economy or fighting that caused it.
import { h, s, section } from "../dom";
import { fmtMetal } from "../format";
import { bandPath, chartGroup, fadeMask, linePath, stepAt, timeChart, type ChartGroup } from "../chart";
import { mirrorKey } from "../legend";
import { comparable, sideColor, sideName } from "../model";
import { swingChart } from "./swing";
import { destroyedBySide } from "../losses";
import { leadPct, maxOf, ratioDomain, stepTimes, windowSums } from "../series";
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
  const destroyed = destroyedBySide(ins);
  const panels = [
    ...comparePanel(ins, watch, group, t, {
      name: "Army value", lead: "Army lead", values: ins.series.army, k: ARMY_K, fmt: fmtMetal, logUnit: 100, height: 130, xAxis: false,
      info: "The metal in each side's armed mobile units (commanders excluded), weighted by how far each is built.",
    }),
    ...comparePanel(ins, watch, group, t, {
      name: "Metal income", lead: "Income lead", values: ins.series.metalIncome, k: INCOME_K, fmt: (v) => `${Math.round(v)}/s`, logUnit: 1, height: 130, xAxis: !destroyed,
      info: "The metal each side made per second, averaged over each step.",
    }),
    ...(destroyed ? comparePanel(ins, watch, group, t, {
      name: "Metal destroyed", lead: "Destroyed lead", values: destroyed.total, perStep: destroyed.step, k: DESTROYED_K, fmt: fmtMetal, logUnit: 100, height: 180, xAxis: true,
      info: "The metal the enemy lost: every enemy unit a side destroyed, at what it cost (units going down with an eliminated team left out). The win model reads the total so far.",
      startValue: true,
    }) : []),
  ];
  // With a swing line the panels under it are the detail behind it, folded
  // away until asked for; without one they are the section.
  const body: Node[] = sw
    ? [h("details", { class: "brs-more" }, h("summary", undefined, destroyed ? "Army value, metal income and metal destroyed" : "Army value and metal income"), ...panels)]
    : panels;
  return section(sw ? "Who was winning" : "Army advantage",
    ...top,
    ...body,
    sw?.list ? h("h3", { style: "margin-top: 16px" }, "Biggest swings") : null,
    sw?.list ?? null);
}

/** The ratio charts' smoothing (leadPct's k), the win model's own constants
 * (internal/insights/swing.go swingArmyK, swingIncomeK), so the line reads
 * what the model reads: metal for army, metal/s for income. */
const ARMY_K = 300;
const INCOME_K = 3;
/** The win model's swingTradeK: early on a few thousand metal destroyed is
 * already a lead it reads. */
const DESTROYED_K = 25000;

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
  /** Set for a measure that accumulates: what each side added in each step,
   * which VALUE mode draws as bars (the first side up, the second down) while
   * `values` (the running total) is what RATIO compares. */
  perStep?: number[][];
  /** Opens on VALUE rather than RATIO. */
  startValue?: boolean;
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
  let value = spec.startValue ?? false;
  let log = true;
  const draw = () => {
    // A shared crosshair member leaves with its svg, wherever in the holder
    // it sat (Ratio mode of an accumulating measure draws two charts).
    for (const old of [...holder.querySelectorAll("svg")]) group.members = group.members.filter((m) => !old.contains(m.hair));
    holder.replaceChildren(value
      ? (spec.perStep ? barChart(ins, watch, group, t, spec, spec.perStep, log) : valueChart(ins, watch, group, t, spec, log))
      : ratioChart(ins, watch, group, t, spec.perStep ? { ...spec, xAxis: false, height: 130 } : spec),
      ...(!value && spec.perStep ? windowRatio(ins, watch, group, t, spec, spec.perStep) : []));
  };
  draw();
  const scale = scaleToggle(log, (l) => { log = l; draw(); });
  scale.hidden = !value;
  const mode = pairToggle(["Ratio", "Value"], value, (v) => { value = v; scale.hidden = !v; draw(); }, "Show");
  const lab = label(spec.name, `${spec.info} Ratio shows how far ahead the leading side is: +20% when ${sideName(ins, 0)} has 20% more, -20% when ${sideName(ins, 1)} has 20% more, shaded in the leader's colour.${spec.perStep ? ` Ratio compares the totals so far; under it, ${perWindowName(spec)} compares what each side destroyed in each ${RATIO_WINDOW_SEC} s.` : ""} ${spec.perStep ? `Value shows what each side added every ${ins.stepSec} s: ${sideName(ins, 0)} above the axis, ${sideName(ins, 1)} below.` : "Value shows both sides' own numbers."}`);
  lab.append(mode, scale);
  return [lab, holder];
}

/** RATIO_WINDOW_SEC is the window the per-window ratio of an accumulating
 * measure adds up over (Marcin's pick: 5 s steps are too few kills to compare). */
const RATIO_WINDOW_SEC = 15;
/** WINDOW_K is that ratio's leadPct k: a 15 s window's metal is small, and a
 * raid of a few hundred metal against nothing is not an infinite lead. */
const WINDOW_K = 500;
/** WINDOW_CAP caps a window's lead (10x) so one lopsided trade cannot
 * flatten every other bar. */
const WINDOW_CAP = 900;

function perWindowName(spec: CompareSpec): string {
  return `${spec.name} per ${RATIO_WINDOW_SEC}s`;
}

/** windowRatio is RATIO mode's second chart for an accumulating measure:
 * per RATIO_WINDOW_SEC, how far ahead the side that destroyed more was in
 * that window alone, as a bar up (the first side) or down (the second) in
 * its colour, on a log scale. The total's lead line above it says who is
 * ahead so far; these bars say who was winning the fighting at the time. */
function windowRatio(ins: Insights, watch: Watch | null, group: ChartGroup, t: number[], spec: CompareSpec, v: number[][]): HTMLElement[] {
  const n = Math.max(1, Math.round(RATIO_WINDOW_SEC / ins.stepSec));
  const [a, b] = [windowSums(v[0], n), windowSums(v[1], n)];
  const lead = leadPct(b, a, WINDOW_K).map((x, w) => (a[w] + b[w] > 0 ? Math.max(-WINDOW_CAP, Math.min(WINDOW_CAP, x)) : 0));
  const top = Math.max(100, ...lead.map(Math.abs));
  const name = perWindowName(spec);
  const c = timeChart({
    height: 120, durationSec: ins.durationSec, yMin: -top, yMax: top, zeroLine: true, xAxis: spec.xAxis, log: { unit: 20 },
    yTick: (y) => `${y > 0 ? "+" : y < 0 ? "-" : ""}${pctText(y)}`, gutter: GUTTER, watch, group,
    readout: (tt) => {
      const i = stepAt(t, tt);
      if (i < 0) return null;
      const w = Math.floor(i / n);
      const ahead = a[w] + b[w] <= 0 || Math.abs(lead[w]) < 0.5 ? -1 : lead[w] > 0 ? 0 : 1;
      return [0, 1].flatMap((sd): TipRow[] => [
        { color: sideColor(ins, sd), label: sideName(ins, sd), metric: name, value: spec.fmt((sd ? b : a)[w] ?? 0) },
        { color: sideColor(ins, sd), label: sideName(ins, sd), metric: `Lead per ${RATIO_WINDOW_SEC}s`, value: ahead < 0 ? "even" : ahead === sd ? pctText(lead[w]) : "" },
      ]);
    },
  });
  // Each window spans steps [w*n, w*n+n); a step's time is its END.
  const t0 = (i: number) => (t[i] ?? 0) - ins.stepSec;
  lead.forEach((x, w) => {
    if (!x) return;
    const i0 = w * n;
    const i1 = Math.min(t.length, i0 + n) - 1;
    const x0 = c.x(t0(i0));
    const width = Math.max(1, (c.x(t[i1]) - x0) * 0.85);
    const y0 = c.y(0);
    const y1 = c.y(x);
    c.plot.append(s("rect", { x: x0, y: Math.min(y0, y1), width, height: Math.abs(y1 - y0), fill: sideColor(ins, x > 0 ? 0 : 1), "fill-opacity": 0.75 }));
  });
  const lab = label(name, `For every ${RATIO_WINDOW_SEC} s on its own: how much more metal the side that destroyed more destroyed in it, +100% when ${sideName(ins, 0)} destroyed twice what ${sideName(ins, 1)} did, -100% the other way, on a log scale capped at 10x. ${WINDOW_K} metal is added to both sides first, so a small raid against nothing reads as a small lead.`);
  return [lab, h("div", undefined, c.svg)];
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
  // The first side's lead reads UP, like the swing line above it (which is
  // the first side's chance of winning): one white line on all three charts,
  // the shading under it saying whose lead it is.
  const r = leadPct(b, a, spec.k);
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
      const ahead = Math.abs(lead) < 0.5 ? -1 : lead > 0 ? 0 : 1;
      return [0, 1].flatMap((sd): TipRow[] => [
        { color: sideColor(ins, sd), label: sideName(ins, sd), metric: spec.name, value: spec.fmt(spec.values[sd][i] ?? 0) },
        { color: sideColor(ins, sd), label: sideName(ins, sd), metric: spec.lead, value: ahead < 0 ? "even" : ahead === sd ? pctText(lead) : "" },
      ]);
    },
  });
  // The lead shaded in the leader's colour: above the axis the first side,
  // below it the second.
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
    s("path", { d: bandPath(c, t, zero, shown.map((v) => Math.max(0, v))), fill: sideColor(ins, 0), "fill-opacity": 0.25 }),
    s("path", { d: bandPath(c, t, shown.map((v) => Math.min(0, v)), zero), fill: sideColor(ins, 1), "fill-opacity": 0.25 }),
    s("path", { d: linePath(c, t, shown), fill: "none", stroke: "var(--brs-text)", "stroke-width": 1.5 }),
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

/** barChart draws a per-step measure as bars, the first side's above the
 * axis and the second's below (the player strip's Built and lost shape). */
function barChart(ins: Insights, watch: Watch | null, group: ChartGroup, t: number[], spec: CompareSpec, v: number[][], log: boolean): SVGSVGElement {
  const top = Math.max(1, maxOf(v[0], v[1]));
  const c = timeChart({
    height: spec.height, durationSec: ins.durationSec, yMin: -top, yMax: top, zeroLine: true, xAxis: spec.xAxis, log: log ? { unit: spec.logUnit } : undefined,
    yTick: (y) => { const a = Math.abs(y); return a >= 1000 ? fmtMetal(a) : String(Math.round(a)); }, gutter: GUTTER, watch, group,
    readout: (tt) => {
      const i = stepAt(t, tt);
      if (i < 0) return null;
      return [0, 1].flatMap((sd): TipRow[] => [
        { color: sideColor(ins, sd), label: sideName(ins, sd), metric: `${spec.name}, ${ins.stepSec} s`, value: spec.fmt(v[sd][i] ?? 0) },
        { color: sideColor(ins, sd), label: sideName(ins, sd), metric: `${spec.name} so far`, value: spec.fmt(spec.values[sd][i] ?? 0) },
      ]);
    },
  });
  const w = ((c.right - c.left) / Math.max(1, t.length)) * 0.8;
  t.forEach((tt, i) => {
    const x = c.x(tt - ins.stepSec / 2) - w / 2;
    const up = v[0][i] ?? 0;
    const down = v[1][i] ?? 0;
    if (up > 0) c.plot.append(s("rect", { x, y: c.y(up), width: w, height: c.y(0) - c.y(up), fill: sideColor(ins, 0), "fill-opacity": 0.75 }));
    if (down > 0) c.plot.append(s("rect", { x, y: c.y(0), width: w, height: c.y(-down) - c.y(0), fill: sideColor(ins, 1), "fill-opacity": 0.75 }));
  });
  return c.svg;
}
