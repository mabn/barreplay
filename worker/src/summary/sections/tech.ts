// Race to tech (G6): when each side first finished a unit of each milestone
// class. Needs a capture that saw every side — a one-sided capture only
// knows its own side's milestones, and drawing the other side's as "never"
// would be a lie.
import { h, s, section } from "../dom";
import { fmtClock } from "../format";
import { CHART_W, timeChart } from "../chart";
import { sideColor, sideName, teamColor } from "../model";
import { tip } from "../tooltip";
import { clipAround, watchNote, watcher } from "../watch";
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
  const watch = watcher(opts);
  // Room for the longest label at the 11px the stylesheet sets.
  const longest = Math.max(...[...labels.values()].map((l) => l.length));
  const c = timeChart({ height: keys.length * rowH + 34, durationSec: ins.durationSec, yMin: 0, yMax: keys.length, yTick: null, watch, gutter: Math.max(110, Math.ceil(longest * 6.2) + 20) });
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
      class: watch ? "brs-clickable" : null,
    });
    const owner = ins.teams.find((tm) => tm.team === m.team)?.player;
    tip(dot, {
      title: `${m.label} · ${fmtClock(m.f / SIM_FPS)}`,
      rows: [{ color: owner ? teamColor(ins, m.team) : sideColor(ins, m.side), label: owner || sideName(ins, m.side), value: def?.human || def?.name || "?" }],
      note: watchNote(watch),
    });
    if (watch) dot.addEventListener("click", () => watch(clipAround(m.f, { title: `${m.label}: ${def?.human || def?.name || "?"}` })));
    marks.append(dot);
  }
  c.svg.append(marks);
  c.svg.setAttribute("viewBox", `0 0 ${CHART_W} ${keys.length * rowH + 34}`);
  const legend = h("div", { class: "brs-legend" },
    ...ins.sides.map((_, i) => h("span", undefined, h("i", { style: `background: ${sideColor(ins, i)}` }), sideName(ins, i))));
  return section("Race to tech", legend, c.svg);
}
