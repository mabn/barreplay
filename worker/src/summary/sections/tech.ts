// Race to tech (G6): when each side first finished a unit of each milestone
// class. Needs a capture that saw every side — a one-sided capture only
// knows its own side's milestones, and drawing the other side's as "never"
// would be a lie.
import { h, s, section } from "../dom";
import { fmtClock } from "../format";
import { CHART_W, timeChart } from "../chart";
import { sideColor, sideName } from "../model";
import { SIM_FPS, type Insights, type SummaryOptions } from "../types";

export function tech(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  if (ins.pov !== "full" || ins.milestones.length === 0) return null;
  // Rows in the order each milestone was first reached by anyone.
  const keys: string[] = [];
  const labels = new Map<string, string>();
  for (const m of ins.milestones) {
    if (!labels.has(m.key)) {
      keys.push(m.key);
      labels.set(m.key, m.label);
    }
  }
  const rowH = 26;
  const c = timeChart({ height: keys.length * rowH + 34, durationSec: ins.durationSec, yMin: 0, yMax: keys.length, yTick: null, onSeek: opts.onSeek, gutter: 130 });
  keys.forEach((k, r) => {
    const y = c.top + (r + 0.5) * rowH;
    c.plot.append(
      s("line", { x1: c.left, x2: c.right, y1: y, y2: y, stroke: "var(--brs-grid)" }),
      s("text", { x: c.left - 12, y: y + 4, "text-anchor": "end" }, labels.get(k) ?? k),
    );
  });
  // Milestones sit ABOVE the hit area, so each is its own click target.
  const marks = s("g");
  for (const m of ins.milestones) {
    const r = keys.indexOf(m.key);
    const y = c.top + (r + 0.5) * rowH;
    const def = ins.defs[String(m.def)];
    const dot = s("circle", {
      cx: c.x(m.f / SIM_FPS), cy: y, r: 6, fill: sideColor(ins, m.side), stroke: "var(--brs-bg)", "stroke-width": 1.5,
      class: opts.onSeek ? "brs-clickable" : null,
    }, s("title", undefined, `${m.label}: ${sideName(ins, m.side)} at ${fmtClock(m.f / SIM_FPS)} (${def?.human || def?.name || "?"})`));
    if (opts.onSeek) {
      const seek = opts.onSeek;
      dot.addEventListener("click", () => seek(m.f));
    }
    marks.append(dot);
  }
  c.svg.append(marks);
  c.svg.setAttribute("viewBox", `0 0 ${CHART_W} ${keys.length * rowH + 34}`);
  const legend = h("div", { class: "brs-legend" },
    ...ins.sides.map((_, i) => h("span", undefined, h("i", { style: `background: ${sideColor(ins, i)}` }), sideName(ins, i))));
  return section("Race to tech", legend, c.svg);
}
