// Killing fields (G3): where things died, each loss a dot in the colour of
// the side that LOST it, its area the metal it cost. Unpriced losses (a
// replay with army-only costs) are small hollow rings: counted, not valued.
import { h, s, section } from "../dom";
import { fmtClock, fmtMetal } from "../format";
import { mapView } from "../mapview";
import { sideColor, sideOfTeam } from "../model";
import { tipLayer } from "../tooltip";
import { clipAround, watchNote, watcher } from "../watch";
import { SIM_FPS, type Insights, type SummaryOptions } from "../types";

export function killing(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  const d = ins.deaths;
  if (ins.pov !== "full" || d.f.length === 0) return null;
  const side = sideOfTeam(ins);
  const watch = watcher(opts);
  const owner = new Map(ins.teams.map((t) => [t.team, t.player ?? ""]));
  // Dot radius as a share of the map's width, so a dot is the same size on
  // screen on any map: sqrt so AREA tracks cost, the costliest loss of the
  // game ~3% of the width, the cheapest still ~0.5%.
  const maxCost = d.cost.reduce((m, c) => Math.max(m, c), 1);
  const share = (cost: number) => (cost > 0 ? 0.005 + 0.025 * Math.sqrt(cost / maxCost) : 0.006);
  const dots: { el: SVGCircleElement; share: number }[] = [];
  const view = mapView(ins, opts.mapApi, (v) => {
    for (const dt of dots) dt.el.setAttribute("r", String(dt.share * v.width));
  });
  const radius = (cost: number) => share(cost) * view.width;
  // Largest first, so small losses stay visible on top.
  const order = d.f.map((_, i) => i).sort((a, b) => d.cost[b] - d.cost[a]);
  const totals = ins.sides.map(() => ({ metal: 0, count: 0 }));
  for (const i of order) {
    const sd = side.get(d.team[i]) ?? -1;
    const color = sd >= 0 ? sideColor(ins, sd) : "#8a8f96";
    if (sd >= 0) {
      totals[sd].metal += d.cost[i];
      totals[sd].count++;
    }
    if (d.x[i] < 0) continue; // never sampled: nowhere to draw it
    const priced = d.cost[i] > 0;
    const dot = s("circle", {
      cx: d.x[i], cy: d.z[i], r: radius(d.cost[i]),
      fill: priced ? color : "none", "fill-opacity": 0.55,
      stroke: color, "stroke-width": priced ? 0 : view.width * 0.002,
      class: watch ? "brs-clickable" : null, "data-i": i,
    });
    dots.push({ el: dot, share: share(d.cost[i]) });
    view.layer.append(dot);
  }
  // One listener for every dot: a big game loses ninety thousand units.
  const at = (el: Element) => {
    const v = el.getAttribute("data-i");
    return v === null ? -1 : Number(v);
  };
  tipLayer(view.layer, (el) => {
    const i = at(el);
    if (i < 0) return null;
    const def = ins.defs[String(d.def[i])];
    const sd = side.get(d.team[i]) ?? -1;
    return {
      title: `${def?.human || def?.name || "unit"}${d.unfinished[i] ? " (unfinished)" : ""}`,
      rows: [{ color: sd >= 0 ? sideColor(ins, sd) : "#8a8f96", label: owner.get(d.team[i]) || `team ${d.team[i]}`, value: `lost at ${fmtClock(d.f[i] / SIM_FPS)}` },
        ...(d.cost[i] > 0 ? [{ label: "Metal", value: fmtMetal(d.cost[i]) }] : [])],
      note: watchNote(watch),
    };
  });
  if (watch) {
    view.layer.addEventListener("click", (ev) => {
      const i = ev.target instanceof Element ? at(ev.target) : -1;
      if (i < 0) return;
      const def = ins.defs[String(d.def[i])];
      watch(clipAround(d.f[i], { x: d.x[i], z: d.z[i], r: 1200, title: `${def?.human || def?.name || "A unit"} lost` }));
    });
  }
  const summary = h("div", { class: "brs-legend" },
    ...ins.sides.map((_, i) => h("span", undefined,
      h("i", { style: `background: ${sideColor(ins, i)}` }),
      `${totals[i]?.count ?? 0} lost` + (totals[i]?.metal ? `, ${fmtMetal(totals[i].metal)} metal` : ""))));
  return section("Killing fields",
    h("p", { class: "brs-hint" }, "Every unit lost, where it was last seen, sized by its metal cost, coloured by the side that lost it." + (watch ? " Click one to watch it go." : "")),
    summary,
    h("div", { class: "brs-mapwrap" }, view.svg));
}
