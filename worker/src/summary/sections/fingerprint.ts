// The game's fingerprint (G10): the whole game as one glyph. Time runs
// clockwise from the top; the first side's army pushes outward from the
// ring, the second side's inward, and gold spikes off the outer edge are the
// metal that died in each step — the long, bright ones fall inside a swing.
// Two games never draw the same shape, and the shape says at a glance
// whether it was a stomp, a slow build or a brawl.
import { h, s, section } from "../dom";
import { fmtClock, fmtMetal } from "../format";
import { swatch } from "../legend";
import { comparable, sideColor, sideName } from "../model";
import { momentWindow } from "../moments";
import { maxOf } from "../series";
import { SIM_FPS, type Insights, type SummaryOptions } from "../types";

const SIZE = 340;
const C = SIZE / 2;
const RING = 84;
const REACH = 48;
/** Longest spike, past the outer band. */
const SPIKE = 30;
const GOLD = "#e8b04a";

export function fingerprint(ins: Insights, _opts: SummaryOptions): HTMLElement | null {
  if (!comparable(ins) || ins.series.t.length < 4) return null;
  const n = ins.series.t.length;
  const army = ins.series.army;
  const top = Math.max(1, maxOf(army[0], army[1]));
  const angle = (i: number) => (i / n) * Math.PI * 2 - Math.PI / 2;
  const xy = (a: number, r: number): [number, number] => [C + Math.cos(a) * r, C + Math.sin(a) * r];
  const pt = (a: number, r: number) => xy(a, r).map((v) => v.toFixed(1)).join(",");
  const outer = (i: number) => RING + (army[0][Math.min(n - 1, Math.max(0, i))] / top) * REACH;
  const svg = s("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, class: "brs-print", role: "img" });
  for (const side of [0, 1]) {
    const dir = side === 0 ? 1 : -1;
    // The band between the ring and the army line: out along the series,
    // back along the ring.
    let d = "M" + pt(angle(0), RING);
    for (let i = 0; i < n; i++) d += "L" + pt(angle(i + 0.5), RING + dir * (army[side][i] / top) * REACH);
    for (let i = n; i >= 0; i--) d += "L" + pt(angle(i), RING);
    d += "Z";
    svg.append(s("path", { d, fill: sideColor(ins, side), "fill-opacity": 0.6 }));
  }
  svg.append(s("circle", { cx: C, cy: C, r: RING, fill: "none", stroke: "var(--brs-panel)", "stroke-width": 2.5 }));

  // Metal lost per step (units when nothing is priced), as radial spikes.
  const priced = ins.deaths.cost.some((c) => c > 0);
  const stepF = ins.stepSec * SIM_FPS;
  const lost = new Array(n).fill(0);
  ins.deaths.f.forEach((f, k) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor(f / stepF)));
    lost[i] += priced ? ins.deaths.cost[k] ?? 0 : 1;
  });
  const windows = (ins.swing?.moments ?? []).map((m) => momentWindow(ins, m));
  const turning = (i: number) => windows.some(([a, b]) => (i + 1) * stepF > a && i * stepF < b);
  const most = Math.max(1, ...lost);
  lost.forEach((v, i) => {
    if (!v) return;
    const a = angle(i + 0.5);
    const big = turning(i);
    const r0 = outer(i) + 3;
    const len = 2 + SPIKE * Math.sqrt(v / most);
    const [x1, y1] = xy(a, r0);
    const [x2, y2] = xy(a, r0 + len);
    svg.append(s("line", {
      x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1),
      stroke: GOLD, "stroke-width": big ? 2.4 : 1.2, "stroke-opacity": big ? 1 : 0.5, "stroke-linecap": "round",
    }, s("title", undefined, `${fmtClock(i * ins.stepSec)}: ${priced ? fmtMetal(v) + " metal" : v + " units"} lost`)));
  });
  svg.append(
    s("text", { x: C, y: C - 3, "text-anchor": "middle", style: "fill: var(--brs-text); font-size: 15px; font-weight: 600" }, ins.gameId.slice(0, 8)),
    s("text", { x: C, y: C + 14, "text-anchor": "middle" }, fmtClock(ins.durationSec)),
  );

  const size = ins.sides.map((sd) => Math.max(1, sd.players.length)).join("v");
  const key = h("div", { class: "brs-printkey" },
    h("div", { class: "brs-printtitle" }, [ins.mapName, size].filter(Boolean).join(" · ")),
    comeback(ins),
    swatch(sideColor(ins, 0), `${sideName(ins, 0)}'s army, outward`),
    swatch(sideColor(ins, 1), `${sideName(ins, 1)}'s army, inward`),
    swatch(GOLD, `${priced ? "metal" : "units"} lost; long bright spikes are the swings`),
    h("div", undefined, "Time runs clockwise from 12 o'clock."));
  return section("Fingerprint", h("div", { class: "brs-printwrap" }, svg, key));
}

/** comeback is "X won after trailing 28% → 72%" from the swing line, or a
 * plain "X won" without one; null when the winner is unknown. */
function comeback(ins: Insights): HTMLElement | null {
  const w = ins.winner ?? -1;
  if (w < 0 || w >= ins.sides.length) return null;
  const name = h("b", { style: `color: ${sideColor(ins, w)}` }, sideName(ins, w));
  const p = ins.swing?.p ?? [];
  if (p.length < 2) return h("div", undefined, name, " won");
  const mine = p.map((v) => (w === 0 ? v : 1 - v));
  const low = Math.min(...mine);
  const pc = (v: number) => `${Math.round(v * 100)}%`;
  return low < 0.5
    ? h("div", undefined, name, ` won after trailing ${pc(low)} → ${pc(mine[mine.length - 1])}`)
    : h("div", undefined, name, ` won, never behind (lowest ${pc(low)})`);
}
