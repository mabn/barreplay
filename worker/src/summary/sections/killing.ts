// Killing fields (G3): where the metal went down. A big game loses ninety
// thousand units, which drawn one dot each paints the map solid, so deaths
// are merged into ZONES (zones.ts): one circle per place, its AREA the metal
// lost there, split like a pie between the sides that lost it. What went
// down with an eliminated team was not fought for and is left out.
import { h, s, section } from "../dom";
import { fmtClock, fmtMetal } from "../format";
import { mapView } from "../mapview";
import { sideColor, sideName } from "../model";
import { tipLayer } from "../tooltip";
import { clipEvent, watchNote, watcher } from "../watch";
import { zonesOf, type Zone } from "../zones";
import { SIM_FPS, type Insights, type SummaryOptions } from "../types";

/** The biggest zone's radius as a share of the map's width. */
const MAX_SHARE = 0.06;
const MIN_SHARE = 0.008;

export function killing(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  const d = ins.deaths;
  if (ins.pov !== "full" || d.f.length === 0) return null;
  const { zones, totals } = zonesOf(ins);
  if (zones.length === 0) return null;
  const watch = watcher(opts);
  const priced = d.cost.some((c) => c > 0);
  const amount = (v: number) => (priced ? `${fmtMetal(v)} metal` : `${v} units`);
  const maxTotal = zones[0].total;
  // sqrt so AREA tracks the loss; sized off the map's width so a zone is the
  // same size on screen on any map.
  const share = (z: Zone) => MIN_SHARE + (MAX_SHARE - MIN_SHARE) * Math.sqrt(z.total / maxTotal);
  const marks: { g: SVGGElement; z: Zone }[] = [];
  const draw = (width: number) => {
    for (const m of marks) {
      m.g.replaceChildren(...pie(ins, m.z, share(m.z) * width, width));
    }
  };
  const view = mapView(ins, opts.mapApi, (v) => draw(v.width));
  // Smallest last, so it stays on top of a big neighbour.
  zones.forEach((z, i) => {
    const g = s("g", { class: watch ? "brs-clickable" : null, "data-i": i });
    marks.push({ g, z });
    view.layer.append(g);
  });
  draw(view.width);
  const at = (el: Element) => {
    const v = el.closest("[data-i]")?.getAttribute("data-i");
    return v == null ? -1 : Number(v);
  };
  tipLayer(view.layer, (el) => {
    const i = at(el);
    if (i < 0) return null;
    const z = zones[i];
    return {
      title: `${amount(z.total)} lost, ${fmtClock(z.first / SIM_FPS)}–${fmtClock(z.last / SIM_FPS)}`,
      rows: [
        ...ins.sides.map((_, sd) => ({ color: sideColor(ins, sd), label: sideName(ins, sd), value: `${z.count[sd]} lost` + (priced ? `, ${fmtMetal(z.lost[sd])}` : "") }))
          .filter((_, sd) => z.count[sd] > 0),
        ...z.top.map((t) => {
          const def = ins.defs[String(t.def)];
          return { label: `${t.n}× ${def?.human || def?.name || "?"}`, value: priced ? fmtMetal(t.metal) : "" };
        }),
        { label: "Busiest", value: fmtClock(z.peakF0 / SIM_FPS) },
      ],
      note: watchNote(watch),
    };
  });
  if (watch) {
    view.layer.addEventListener("click", (ev) => {
      const i = ev.target instanceof Element ? at(ev.target) : -1;
      if (i < 0) return;
      const z = zones[i];
      watch(clipEvent(z.peakF0, z.peakF1, { x: z.x, z: z.z, r: z.r * 1.5, title: `${amount(z.total)} lost here` }));
    });
  }
  const legend = h("div", { class: "brs-legend" },
    ...ins.sides.map((_, i) => h("span", undefined,
      h("i", { style: `background: ${sideColor(ins, i)}` }), `${sideName(ins, i)} lost ${amount(totals[i])}` + (ins.eliminated?.length ? " fighting" : ""))));
  return section("Killing fields",
    h("p", { class: "brs-hint" }, `Where the ${priced ? "metal" : "units"} went down: each circle gathers the losses around one place, its area how much was lost, split by the side that lost it.`
      + (watch ? " Click one to watch its busiest moment." : "")),
    legend,
    h("div", { class: "brs-mapwrap" }, view.svg));
}

/** pie draws a zone as wedges, one per side that lost something there,
 * starting at twelve o'clock. */
function pie(ins: Insights, z: Zone, r: number, width: number): SVGElement[] {
  const out: SVGElement[] = [];
  const stroke = { stroke: "rgba(0,0,0,0.6)", "stroke-width": width * 0.0015 };
  const parts = z.lost.map((v, sd) => ({ v, sd })).filter((p) => p.v > 0);
  const sum = parts.reduce((a, p) => a + p.v, 0);
  if (parts.length <= 1 || sum <= 0) {
    const sd = parts[0]?.sd ?? -1;
    out.push(s("circle", { cx: z.x, cy: z.z, r, fill: sd >= 0 ? sideColor(ins, sd) : "#8a8f96", "fill-opacity": 0.75, ...stroke }));
    return out;
  }
  let a0 = -Math.PI / 2;
  for (const p of parts) {
    const a1 = a0 + (2 * Math.PI * p.v) / sum;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = z.x + r * Math.cos(a0), y0 = z.z + r * Math.sin(a0);
    const x1 = z.x + r * Math.cos(a1), y1 = z.z + r * Math.sin(a1);
    out.push(s("path", {
      d: `M${z.x},${z.z}L${x0},${y0}A${r},${r} 0 ${large} 1 ${x1},${y1}Z`,
      fill: sideColor(ins, p.sd), "fill-opacity": 0.75, ...stroke,
    }));
    a0 = a1;
  }
  return out;
}
