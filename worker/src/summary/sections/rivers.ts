// Army rivers (G5): each side's army split by kind, stacked, the first side
// above the axis and the second mirrored below it. There is no tech level in
// a replay's defs, so the kinds are air plus ground units by price band.
import { h, s, section } from "../dom";
import { fmtMetal } from "../format";
import { bandPath, stepAt, timeChart } from "../chart";
import { comparable, sideColor, sideName } from "../model";
import { maxOf, stepTimes } from "../series";
import type { Insights, SummaryOptions } from "../types";

const CAT_LABELS: Record<string, string> = {
  air: "air", light: "light (<250)", medium: "medium (<800)", heavy: "heavy (<3000)", experimental: "experimental",
};

export function rivers(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  if (!comparable(ins) || ins.series.t.length < 2) return null;
  const t = stepTimes(ins);
  const cats = ins.series.armyCats;
  const lim = Math.max(1, maxOf(ins.series.army[0], ins.series.army[1]));
  const c = timeChart({
    height: 260, durationSec: ins.durationSec, yMin: -lim, yMax: lim, zeroLine: true,
    yTick: (v) => fmtMetal(Math.abs(v)),
    onSeek: opts.onSeek,
    readout: (tt) => {
      const i = stepAt(t, tt);
      return i < 0 ? "" : `${fmtMetal(ins.series.army[0][i])} vs ${fmtMetal(ins.series.army[1][i])}`;
    },
  });
  // Opacity encodes the category, the hue the side: the legend reads for both.
  const opacity = (k: number) => 0.85 - (k / Math.max(1, cats.length - 1)) * 0.6;
  for (const side of [0, 1]) {
    const sign = side === 0 ? 1 : -1;
    let base = t.map(() => 0);
    cats.forEach((_, k) => {
      const vals = ins.series.armyByCat[side][k];
      const next = base.map((b, i) => b + sign * (vals[i] ?? 0));
      const [lo, hi] = side === 0 ? [base, next] : [next, base];
      c.plot.append(s("path", { d: bandPath(c, t, lo, hi), fill: sideColor(ins, side), "fill-opacity": opacity(k) }));
      base = next;
    });
  }
  c.svg.append(
    s("text", { x: c.left + 6, y: c.top + 24, style: `fill: ${sideColor(ins, 0)}` }, `▲ ${sideName(ins, 0)}`),
    s("text", { x: c.left + 6, y: c.bottom - 6, style: `fill: ${sideColor(ins, 1)}` }, `▼ ${sideName(ins, 1)}`),
  );
  const legend = h("div", { class: "brs-legend" },
    ...cats.map((cat, k) => h("span", undefined,
      h("i", { style: `background: var(--brs-text); opacity: ${opacity(k)}` }), CAT_LABELS[cat] ?? cat)));
  return section("Army composition", legend, c.svg);
}
