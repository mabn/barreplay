// Who was ahead: the swing chart (a win probability, sections/swing.ts) when
// the file carries one, else the plain difference in army value a version 1
// file can give; the metal income chart under either.
import { h, s, section } from "../dom";
import { fmtMetal } from "../format";
import { bandPath, linePath, stepAt, timeChart } from "../chart";
import { comparable, sideColor, sideName } from "../model";
import { swingParts } from "./swing";
import { mirrorKey } from "../legend";
import { diff, maxOf, stepTimes } from "../series";
import type { Insights, SummaryOptions } from "../types";

export function advantage(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  if (!comparable(ins) || ins.series.t.length < 2) return null;
  const t = stepTimes(ins);
  const top = swingParts(ins, opts) ?? armyLead(ins, opts, t);
  // Income beside it: the economy each army was bought with.
  const mi = ins.series.metalIncome;
  const peak = Math.max(1, maxOf(mi[0], mi[1]));
  const inc = timeChart({
    height: 140, durationSec: ins.durationSec, yMin: 0, yMax: peak * 1.05,
    yTick: (v) => String(Math.round(v)),
    onSeek: opts.onSeek,
    readout: (tt) => {
      const i = stepAt(t, tt);
      return i < 0 ? "" : `${mi[0][i].toFixed(1)} vs ${mi[1][i].toFixed(1)} metal/s`;
    },
  });
  for (const side of [0, 1]) {
    inc.plot.append(s("path", { d: linePath(inc, t, mi[side]), fill: "none", stroke: sideColor(ins, side), "stroke-width": 2 }));
  }
  return section(ins.swing ? "Who was winning" : "Army advantage", ...top, h("h3", { style: "margin-top: 14px" }, "Metal income"), inc.svg);
}

/** armyLead is the version 1 chart: the difference in army value. */
function armyLead(ins: Insights, opts: SummaryOptions, t: number[]): Element[] {
  const [a, b] = ins.series.army;
  const d = diff(a, b);
  const lim = Math.max(1, maxOf(d.map(Math.abs)));
  const c = timeChart({
    height: 220, durationSec: ins.durationSec, yMin: -lim, yMax: lim, zeroLine: true,
    yTick: (v) => fmtMetal(Math.abs(v)),
    onSeek: opts.onSeek,
    readout: (tt) => {
      const i = stepAt(t, tt);
      if (i < 0) return "";
      const v = d[i];
      return v === 0 ? "even" : `${sideName(ins, v > 0 ? 0 : 1)} ahead by ${fmtMetal(Math.abs(v))}`;
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
    h("p", { class: "brs-hint" }, "Difference in army value (metal in armed mobile units, commanders excluded). Above the line, the first side is ahead." + (opts.onSeek ? " Click to watch that moment." : "")),
    c.svg,
  ];
}
