// Army rivers (G5): each side's army split by kind, stacked, the first side
// above the axis and the second mirrored below it. There is no tech level in
// a replay's defs, so the kinds are air plus ground units by price band.
import { h, s, section } from "../dom";
import { fmtMetal } from "../format";
import { bandPath, stepAt, timeChart } from "../chart";
import { mirrorKey, swatch } from "../legend";
import { comparable, sideColor, sideName } from "../model";
import { maxOf, stepTimes } from "../series";
import { scaleToggle } from "../scale";
import { watcher } from "../watch";
import type { Insights, SummaryOptions } from "../types";

const CAT_LABELS: Record<string, string> = {
  air: "air", light: "light (<250)", medium: "medium (<800)", heavy: "heavy (<3000)", experimental: "experimental",
};

/** One hue per kind, the same on both sides: the axis already says whose
 * half is whose, so the colour is free to say what the army was made of. */
/** Hues spread round the wheel at full strength, light enough to read on the
 * dark panel: neighbouring bands must never be mistaken for one another. */
const CAT_COLORS: Record<string, string> = {
  air: "#a77bff", light: "#38b6f0", medium: "#4fcf6a", heavy: "#ffc23d", experimental: "#ff5470",
};
const SPARE_COLORS = ["#2ed3c0", "#ff8ad8", "#a0a6ad"];

/** catColor is the fill for category k. */
export function catColor(cat: string, k: number): string {
  return CAT_COLORS[cat] ?? SPARE_COLORS[k % SPARE_COLORS.length];
}

export function rivers(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  if (!comparable(ins) || ins.series.t.length < 2) return null;
  const cats = ins.series.armyCats;
  const holder = h("div");
  // Log by default: a late game's experimentals are a hundred times its
  // early army, which on a linear axis is a flat line for fifteen minutes.
  const draw = (log: boolean) => holder.replaceChildren(riverChart(ins, opts, log));
  draw(true);
  const legend = mirrorKey(ins, ...cats.map((cat, k) => swatch(catColor(cat, k), CAT_LABELS[cat] ?? cat)));
  const el = section("Army composition", legend, holder);
  el.querySelector("h3")?.append(scaleToggle(true, draw));
  return el;
}

function riverChart(ins: Insights, opts: SummaryOptions, log: boolean): SVGSVGElement {
  const unit = 100;
  const t = stepTimes(ins);
  const cats = ins.series.armyCats;
  const lim = Math.max(1, maxOf(ins.series.army[0], ins.series.army[1]));
  const c = timeChart({
    height: 260, durationSec: ins.durationSec, yMin: -lim, yMax: lim, zeroLine: true, log: log ? { unit } : undefined,
    yTick: (v) => fmtMetal(Math.abs(v)),
    watch: watcher(opts),
    readout: (tt) => {
      const i = stepAt(t, tt);
      if (i < 0) return null;
      return [0, 1].map((sd) => {
        const total = ins.series.army[sd][i];
        // The two biggest kinds, as shares: what the army was made of.
        const kinds = cats.map((cat, k) => [CAT_LABELS[cat]?.split(" ")[0] ?? cat, ins.series.armyByCat[sd][k][i] ?? 0] as [string, number])
          .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 2)
          .map(([name, v]) => `${name} ${Math.round((100 * v) / total)}%`).join(", ");
        return { color: sideColor(ins, sd), label: sideName(ins, sd), value: fmtMetal(total) + (kinds ? ` · ${kinds}` : "") };
      });
    },
  });
  // On a log axis the bands cannot be stacked by value: whatever lies at the
  // bottom would take most of the height (a 100k bottom band under a 1M
  // total fills five sixths of it). So the TOTAL is placed on the log axis
  // and split by SHARE — each band's thickness is its fraction of the army —
  // which keeps the picture of what the army was made of honest on both.
  const place = (cum: number, total: number) => {
    if (!log || total <= 0) return cum;
    const L = Math.log10(1 + total / unit);
    return unit * (Math.pow(10, (cum / total) * L) - 1);
  };
  for (const side of [0, 1]) {
    const sign = side === 0 ? 1 : -1;
    const totals = t.map((_, i) => cats.reduce((a, _c, k) => a + (ins.series.armyByCat[side][k][i] ?? 0), 0));
    let cum = t.map(() => 0);
    let base = t.map(() => 0);
    cats.forEach((_cat, k) => {
      const vals = ins.series.armyByCat[side][k];
      cum = cum.map((b, i) => b + (vals[i] ?? 0));
      const next = cum.map((v, i) => sign * place(v, totals[i]));
      const [lo, hi] = side === 0 ? [base, next] : [next, base];
      // A hairline of the panel between bands keeps neighbours apart.
      c.plot.append(s("path", { d: bandPath(c, t, lo, hi), fill: catColor(cats[k], k), "fill-opacity": 0.9, stroke: "var(--brs-panel)", "stroke-width": 0.75 }));
      base = next;
    });
  }
  // A gap along the axis keeps the two sides' bottom bands apart.
  c.plot.append(s("line", { x1: c.left, x2: c.right, y1: c.y(0), y2: c.y(0), stroke: "var(--brs-panel)", "stroke-width": 3 }));
  return c.svg;
}
