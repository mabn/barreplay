// The swing chart (G1): who the numbers said was winning, as a probability,
// with the biggest shifts numbered and listed underneath. The line is the
// insights file's (internal/insights swing.go): a logistic model over army
// value and metal income, which never sees who won, so the result is drawn
// beside it rather than through it.
import { h, s } from "../dom";
import { fmtClock } from "../format";
import { bandPath, linePath, stepAt, timeChart } from "../chart";
import { mirrorKey } from "../legend";
import { sideColor, sideName } from "../model";
import { momentStory } from "../moments";
import { stepTimes } from "../series";
import { SIM_FPS, type Insights, type SummaryOptions } from "../types";

/** How far before a moment's window a click lands, so the shift is seen
 * arriving rather than already over. */
const LEAD_IN_SEC = 10;

/** pct formats a probability as a whole percent. */
export function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** swingParts draws the chart and the moments list, or null when the file
 * carries no swing line (version 1, a one-sided capture, an FFA). */
export function swingParts(ins: Insights, opts: SummaryOptions): Element[] | null {
  const sw = ins.swing;
  if (!sw || sw.p.length < 2 || ins.sides.length !== 2) return null;
  const t = stepTimes(ins);
  const d = sw.p.map((p) => p - 0.5);
  const c = timeChart({
    height: 220, durationSec: ins.durationSec, yMin: -0.5, yMax: 0.5, zeroLine: true,
    yTick: (v) => pct(0.5 + Math.abs(v)),
    onSeek: opts.onSeek,
    readout: (tt) => {
      const i = stepAt(t, tt);
      if (i < 0) return "";
      const p = sw.p[i];
      return p === 0.5 ? "even" : `${sideName(ins, p > 0.5 ? 0 : 1)} ${pct(Math.max(p, 1 - p))}`;
    },
  });
  const zero = t.map(() => 0);
  c.plot.append(
    s("path", { d: bandPath(c, t, zero, d.map((v) => Math.max(0, v))), fill: sideColor(ins, 0), "fill-opacity": 0.35 }),
    s("path", { d: bandPath(c, t, d.map((v) => Math.min(0, v)), zero), fill: sideColor(ins, 1), "fill-opacity": 0.35 }),
    s("path", { d: linePath(c, t, d), fill: "none", stroke: "var(--brs-text)", "stroke-width": 1.5 }),
  );
  const seekTo = (f0: number) => opts.onSeek?.(Math.max(0, f0 - LEAD_IN_SEC * SIM_FPS));
  const stories = sw.moments.map((m) => momentStory(ins, m));
  sw.moments.forEach((m, k) => {
    const tt = m.f1 / SIM_FPS;
    const i = stepAt(t, tt);
    const y = c.y(i < 0 ? 0 : d[i]);
    const g = s("g", { class: opts.onSeek ? "brs-clickable" : null },
      s("circle", { cx: c.x(tt), cy: y, r: 9, fill: sideColor(ins, m.side), stroke: "var(--brs-bg)", "stroke-width": 2 }),
      s("text", { x: c.x(tt), y: y + 4, "text-anchor": "middle", style: "fill: #000; font-weight: 600" }, String(m.n)),
      s("title", undefined, `${m.n}. ${stories[k].title}`),
    );
    if (opts.onSeek) g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      seekTo(m.f0);
    });
    c.plot.append(g);
  });

  const rows = sw.moments.map((m, k) => {
    const st = stories[k];
    const when = h("span", { class: opts.onSeek ? "brs-seek" : null }, `${fmtClock(m.f0 / SIM_FPS)}–${fmtClock(m.f1 / SIM_FPS)}`);
    if (opts.onSeek) when.addEventListener("click", () => seekTo(m.f0));
    const battle = st.battle >= 0 ? ` See battle ${st.battle + 1} on the map.` : "";
    return h("div", { class: "brs-moment" },
      h("span", { class: "brs-num", style: `background: ${sideColor(ins, m.side)}` }, String(m.n)),
      h("div", undefined,
        h("div", undefined, h("b", undefined, st.title), " ", h("span", { class: "brs-muted" }, "· "), when, " ",
          h("span", { style: `color: ${sideColor(ins, m.side)}` }, `${sideName(ins, m.side)} +${pct(m.delta)}`)),
        h("div", { class: "brs-hint" }, st.detail + battle)));
  });
  const model = sw.fitted
    ? `fitted to ${sw.games ?? "past"} games`
    : "with hand-set weights, not yet fitted to real games";
  const parts: Element[] = [
    mirrorKey(ins),
    h("p", { class: "brs-hint" },
      `The chance each side wins, as army value and metal income read at each moment (a model ${model}; it is never told the result).` +
      (opts.onSeek ? " Click to watch that moment." : "")),
    c.svg,
  ];
  if (rows.length) parts.push(h("h3", { style: "margin-top: 14px" }, "Biggest swings"), h("div", undefined, ...rows));
  return parts;
}
