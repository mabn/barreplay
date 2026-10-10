// The game's fingerprint (G10): the whole game as one glyph. Time runs
// clockwise from the top; the first side's army pushes outward from the
// ring, the second side's inward, and the dots outside are deaths per
// minute. Two games never draw the same shape, and the shape says at a
// glance whether it was a stomp, a slow build or a brawl.
import { h, s, section } from "../dom";
import { fmtClock } from "../format";
import { comparable, sideColor, sideName } from "../model";
import { maxOf } from "../series";
import { SIM_FPS, type Insights, type SummaryOptions } from "../types";

const SIZE = 320;
const C = SIZE / 2;
const RING = 92;
const REACH = 52;

export function fingerprint(ins: Insights, _opts: SummaryOptions): HTMLElement | null {
  if (!comparable(ins) || ins.series.t.length < 4) return null;
  const n = ins.series.t.length;
  const top = Math.max(1, maxOf(ins.series.army[0], ins.series.army[1]));
  const angle = (i: number) => (i / n) * Math.PI * 2 - Math.PI / 2;
  const pt = (a: number, r: number) => `${(C + Math.cos(a) * r).toFixed(1)},${(C + Math.sin(a) * r).toFixed(1)}`;
  const svg = s("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, class: "brs-print", role: "img" });
  svg.append(s("circle", { cx: C, cy: C, r: RING, fill: "none", stroke: "var(--brs-line)" }));
  for (const side of [0, 1]) {
    const dir = side === 0 ? 1 : -1;
    // The band between the ring and the army line: out along the series,
    // back along the ring.
    let d = "M" + pt(angle(0), RING);
    for (let i = 0; i < n; i++) d += "L" + pt(angle(i + 0.5), RING + dir * (ins.series.army[side][i] / top) * REACH);
    for (let i = n; i >= 0; i--) d += "L" + pt(angle(i), RING);
    d += "Z";
    svg.append(s("path", { d, fill: sideColor(ins, side), "fill-opacity": 0.7 }));
  }
  // Deaths per minute, as dots on an outer ring.
  const minutes = Math.max(1, Math.ceil(ins.durationSec / 60));
  const perMin = new Array(minutes).fill(0);
  for (const f of ins.deaths.f) perMin[Math.min(minutes - 1, Math.floor(f / SIM_FPS / 60))]++;
  const most = Math.max(1, ...perMin);
  perMin.forEach((k, m) => {
    if (!k) return;
    const a = ((m + 0.5) / minutes) * Math.PI * 2 - Math.PI / 2;
    const [x, y] = pt(a, RING + REACH + 14).split(",").map(Number);
    svg.append(s("circle", { cx: x, cy: y, r: 1.5 + 5 * Math.sqrt(k / most), fill: "#e06a5a", "fill-opacity": 0.8 },
      s("title", undefined, `${k} deaths in minute ${m + 1}`)));
  });
  svg.append(s("text", { x: C, y: C - 4, "text-anchor": "middle", style: "fill: var(--brs-text); font-size: 15px" }, fmtClock(ins.durationSec)));
  svg.append(s("text", { x: C, y: C + 14, "text-anchor": "middle" }, "clockwise from the top"));
  return section("Fingerprint",
    h("div", { class: "brs-printwrap" }, svg,
      h("div", { class: "brs-hint" },
        h("div", undefined, h("b", { style: `color: ${sideColor(ins, 0)}` }, sideName(ins, 0)), "'s army grows outward from the ring, ",
          h("b", { style: `color: ${sideColor(ins, 1)}` }, sideName(ins, 1)), "'s inward."),
        h("div", undefined, "Red dots: deaths per minute."))));
}
