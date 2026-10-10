// Map stories: where each army stood over the game (G2, tide lines) with the
// battles marked on the same map, then a card per battle (G4). Nothing here
// knows who killed what — a battle card says where, when and what each side
// lost, and calls it for the side that lost less.
import { h, s, section } from "../dom";
import { fmtClock, fmtMetal } from "../format";
import { mapView } from "../mapview";
import { comparable, sideColor, sideName } from "../model";
import { SIM_FPS, type Battle, type Insights, type SummaryOptions } from "../types";

/** Seconds of lead-in when jumping to a battle, so the approach is visible. */
const LEAD_IN_SEC = 10;

export function mapStories(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  if (!comparable(ins)) return null;
  const hasFront = ins.series.front.some((row) => row.some(Boolean));
  if (!hasFront && ins.battles.length === 0) return null;
  const stroke = { w: 0 };
  const lines: { el: SVGElement; k: number }[] = [];
  const view = mapView(ins, opts.mapApi, (v) => {
    stroke.w = v.width;
    for (const l of lines) l.el.setAttribute("stroke-width", String(l.k * v.width));
    for (const l of rings) l.el.setAttribute("stroke-width", String(l.k * v.width));
    for (const t of labels) t.setAttribute("font-size", String(v.width * 0.03));
  });
  stroke.w = view.width;
  const rings: { el: SVGElement; k: number }[] = [];
  const labels: SVGElement[] = [];

  // Each side's army centre, step by step, as a path that brightens toward
  // the end of the game: where it starts faint is where the army began.
  ins.series.front.forEach((row, side) => {
    const n = row.length;
    for (let i = 1; i < n; i++) {
      const a = row[i - 1];
      const b = row[i];
      if (!a || !b) continue;
      const seg = s("line", {
        x1: a[0], y1: a[1], x2: b[0], y2: b[1],
        stroke: sideColor(ins, side), "stroke-opacity": 0.25 + 0.75 * (i / n),
        "stroke-width": 0.006 * stroke.w, "stroke-linecap": "round",
      });
      lines.push({ el: seg, k: 0.006 });
      view.layer.append(seg);
    }
  });
  ins.battles.forEach((b, i) => {
    const ring = s("circle", {
      cx: b.x, cy: b.z, r: Math.max(b.r, 0.02 * stroke.w), fill: "#fff", "fill-opacity": 0.08,
      stroke: "#fff", "stroke-opacity": 0.7, "stroke-width": 0.003 * stroke.w,
      class: opts.onSeek ? "brs-clickable" : null,
    }, s("title", undefined, `Battle ${i + 1} at ${fmtClock(b.f0 / SIM_FPS)}`));
    rings.push({ el: ring, k: 0.003 });
    const label = s("text", {
      x: b.x, y: b.z, "text-anchor": "middle", "dominant-baseline": "central",
      "font-size": 0.03 * stroke.w, style: "fill: #fff; font-weight: 600; pointer-events: none",
    }, String(i + 1));
    labels.push(label);
    if (opts.onSeek) {
      const seek = opts.onSeek;
      ring.addEventListener("click", () => seek(Math.max(0, b.f0 - LEAD_IN_SEC * SIM_FPS)));
    }
    view.layer.append(ring, label);
  });
  const cards = h("div", { class: "brs-cards" }, ...ins.battles.map((b, i) => battleCard(ins, b, i, opts)));
  return section("Map story",
    h("p", { class: "brs-hint" }, "Lines trace where each side's army stood, faint at the start and bright at the end. Numbered rings are the biggest battles."),
    h("div", { class: "brs-mapwrap" }, view.svg),
    ins.battles.length ? cards : null);
}

function battleCard(ins: Insights, b: Battle, i: number, opts: SummaryOptions): HTMLElement {
  const priced = b.lost.some((l) => l.metal > 0);
  const cost = (l: { n: number; metal: number }) => (priced ? l.metal : l.n);
  const [l0, l1] = b.lost;
  const winner = cost(l0) === cost(l1) ? -1 : cost(l0) < cost(l1) ? 0 : 1;
  const verdict = winner < 0 ? "Even trade" : `${sideName(ins, winner)} came out ahead`;
  const lossRow = (side: number) => {
    const l = b.lost[side];
    const names = l.top.map((d) => ins.defs[String(d)]?.human || ins.defs[String(d)]?.name || "?").join(", ");
    return h("div", { class: "brs-stat" },
      h("span", { style: `color: ${sideColor(ins, side)}` }, sideName(ins, side)),
      `${l.n} lost` + (l.metal ? ` · ${fmtMetal(l.metal)}` : "") + (names ? ` · ${names}` : ""));
  };
  const when = `${fmtClock(b.f0 / SIM_FPS)}–${fmtClock(b.f1 / SIM_FPS)}`;
  const title = h("b", { class: opts.onSeek ? "brs-seek" : null }, `${i + 1}. ${when}`);
  if (opts.onSeek) {
    const seek = opts.onSeek;
    title.addEventListener("click", () => seek(Math.max(0, b.f0 - LEAD_IN_SEC * SIM_FPS)));
  }
  return h("div", { class: "brs-card" }, title, h("div", { class: "brs-hint" }, verdict), lossRow(0), lossRow(1));
}
