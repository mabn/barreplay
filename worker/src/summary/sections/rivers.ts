// Army rivers (G5): each side's army split by kind, stacked, the first side
// above the axis and the second mirrored below it. There is no tech level in
// a replay's defs, so the kinds are air plus ground units by price band.
import { s, section } from "../dom";
import { fmtMetal } from "../format";
import { bandPath, stepAt, timeChart } from "../chart";
import { mirrorKey, swatch } from "../legend";
import { comparable, sideColor, sideName } from "../model";
import { maxOf, stepTimes } from "../series";
import { watcher } from "../watch";
import type { Insights, SummaryOptions } from "../types";

const CAT_LABELS: Record<string, string> = {
  air: "air", light: "light (<250)", medium: "medium (<800)", heavy: "heavy (<3000)", experimental: "experimental",
};

/** One hue per kind, the same on both sides: the axis already says whose
 * half is whose, so the colour is free to say what the army was made of. */
const CAT_COLORS: Record<string, string> = {
  air: "#a58bd0", light: "#6f9bc0", medium: "#7fae6e", heavy: "#d4a650", experimental: "#d9705f",
};
const SPARE_COLORS = ["#4bb3a8", "#c95f9a", "#8a8f96"];

/** catColor is the fill for category k. */
export function catColor(cat: string, k: number): string {
  return CAT_COLORS[cat] ?? SPARE_COLORS[k % SPARE_COLORS.length];
}

export function rivers(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  if (!comparable(ins) || ins.series.t.length < 2) return null;
  const t = stepTimes(ins);
  const cats = ins.series.armyCats;
  const lim = Math.max(1, maxOf(ins.series.army[0], ins.series.army[1]));
  const c = timeChart({
    height: 260, durationSec: ins.durationSec, yMin: -lim, yMax: lim, zeroLine: true,
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
  for (const side of [0, 1]) {
    const sign = side === 0 ? 1 : -1;
    let base = t.map(() => 0);
    cats.forEach((_cat, k) => {
      const vals = ins.series.armyByCat[side][k];
      const next = base.map((b, i) => b + sign * (vals[i] ?? 0));
      const [lo, hi] = side === 0 ? [base, next] : [next, base];
      c.plot.append(s("path", { d: bandPath(c, t, lo, hi), fill: catColor(cats[k], k), "fill-opacity": 0.85 }));
      base = next;
    });
  }
  // A gap along the axis keeps the two sides' bottom bands apart.
  c.plot.append(s("line", { x1: c.left, x2: c.right, y1: c.y(0), y2: c.y(0), stroke: "var(--brs-panel)", "stroke-width": 3 }));
  const legend = mirrorKey(ins, ...cats.map((cat, k) => swatch(catColor(cat, k), CAT_LABELS[cat] ?? cat)));
  return section("Army composition", legend, c.svg);
}
