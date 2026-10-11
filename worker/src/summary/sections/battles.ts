// Battles: the biggest fights marked on the map and numbered in the order
// they happened (the army-centre lines once drawn under them were dropped
// as clutter), beside a one-line-per-battle list (G4). The map and the list are
// one control: hovering either lights the other, clicking either selects
// the battle, opens what each side lost there and plays its clip. Nothing here knows who killed what — a battle says where,
// when and what each side lost, and calls it for the side that lost less.
// Above both, every battle on the game's time axis: up for a first-side win,
// down for a second-side one, by HOW MUCH less the winner lost (a ratio, so
// an early fight a side lost 3:1 reads as clearly as a late one), with the
// bubble's area the metal lost there — who won and how big are two readings,
// never one bar.
import { h, s, section } from "../dom";
import { timeChart } from "../chart";
import { fmtClock, fmtMetal } from "../format";
import { mapView } from "../mapview";
import { comparable, lossWorth, sideColor, sideName, sideOfTeam } from "../model";
import { compass, fighters, ownBlast, ownBlastTitle } from "../moments";
import { fighterNames } from "../names";
import { fillUnits, inkOn } from "../unitchips";
import { tip, type TipRow } from "../tooltip";
import { clipEvent, watcher } from "../watch";
import { SIM_FPS, type Battle, type Insights, type SummaryOptions } from "../types";

export function mapStories(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  if (!comparable(ins)) return null;
  if (ins.battles.length === 0) return null;
  const watch = watcher(opts);
  const priced = ins.battles.some((b) => b.lost.some((l) => l.metal > 0));
  const size = (l: { n: number; metal: number }) => (priced ? l.metal : l.n);
  const fmt = (v: number) => (priced ? fmtMetal(v) : `${v}`);
  const when = (b: Battle) => `${fmtClock(b.f0 / SIM_FPS)}–${fmtClock(b.f1 / SIM_FPS)}`;
  const clipOf = (b: Battle, i: number) => clipEvent(b.f0, b.f1, { x: b.x, z: b.z, r: Math.max(b.r, 800), title: `Battle ${i + 1} · ${when(b)}` });

  // Marks scale with the map, which is only known once its record arrives.
  const scaled: ((w: number) => void)[] = [];
  const view = mapView(ins, opts.mapApi, (v) => scaled.forEach((f) => f(v.width)));
  const atWidth = (f: (w: number) => void) => {
    scaled.push(f);
    f(view.width);
  };

  const rings: SVGGElement[] = [];
  const rows: HTMLElement[] = [];
  const marks: SVGGElement[] = [];
  const detail = h("div", { class: "brs-battledetail" }, h("p", { class: "brs-hint" }, "Pick a battle on the map or in the list."));
  const light = (i: number, on: boolean) => {
    rings[i]?.classList.toggle("brs-hover", on);
    rows[i]?.classList.toggle("brs-hover", on);
    marks[i]?.classList.toggle("brs-hover", on);
  };
  const select = (i: number) => {
    rings.forEach((g, k) => g.classList.toggle("brs-on", k === i));
    rows.forEach((r, k) => r.classList.toggle("brs-on", k === i));
    marks.forEach((m, k) => m.classList.toggle("brs-on", k === i));
    if (rings[i]) view.layer.append(rings[i]); // over its neighbours
    detail.replaceChildren(battleDetail(i));
  };
  // A click both selects and plays: the losses are waiting under the clip.
  const open = (i: number) => {
    select(i);
    if (watch) watch(clipOf(ins.battles[i], i));
  };
  const lossRows = (b: Battle): TipRow[] => [0, 1].map((sd) => ({
    color: sideColor(ins, sd), label: `${sideName(ins, sd)} lost`,
    value: `${b.lost[sd]?.n ?? 0} units` + (priced ? ` · ${fmtMetal(b.lost[sd]?.metal ?? 0)}` : ""),
  }));
  // Who came out ahead is decided by worth: a lost power plant costs its
  // output as well as its metal.
  const worth = (l?: { n: number; metal: number; worth?: number }) => (priced ? lossWorth(l) : l?.n ?? 0);
  const verdict = (b: Battle) => {
    const [a, c] = [worth(b.lost[0]), worth(b.lost[1])];
    const own = ownBlast(b);
    if (own >= 0 && (a === c || own === (a < c ? 1 : 0))) return ownBlastTitle(ins, b, own);
    return a === c ? "An even trade" : `${sideName(ins, a < c ? 0 : 1)} came out ahead`;
  };
  // The side that came out ahead, -1 for nobody: an even trade, or a
  // battle its loser lost to its own blasts.
  const aheadOf = (b: Battle) => {
    const [a, c] = [worth(b.lost[0]), worth(b.lost[1])];
    const more = a === c ? -1 : a < c ? 1 : 0;
    return more < 0 || ownBlast(b) === more ? -1 : 1 - more;
  };
  // How lopsided it was: log10 of the loser's worth over the winner's,
  // signed toward the first side (+) or the second (-), capped at 10x —
  // past that every battle is simply a rout.
  const lean = (b: Battle) => {
    const [a, c] = [worth(b.lost[0]), worth(b.lost[1])];
    const r = Math.log10(Math.max(c, 1) / Math.max(a, 1));
    return Math.max(-1, Math.min(1, r));
  };
  // The margin, said only of a battle somebody won by fighting.
  const ratioText = (b: Battle) => {
    if (ownBlast(b) >= 0 && aheadOf(b) < 0) return "";
    const [a, c] = [worth(b.lost[0]), worth(b.lost[1])];
    const r = Math.max(a, c) / Math.max(Math.min(a, c), 1);
    return r < 1.25 ? " (about even)" : ` (${r < 10 ? r.toFixed(1) : Math.round(r)}× less lost)`;
  };
  const leanColor = (b: Battle) => {
    const w = aheadOf(b);
    return w < 0 ? "var(--brs-muted)" : sideColor(ins, w);
  };
  const total = (b: Battle) => size(b.lost[0] ?? { n: 0, metal: 0 }) + size(b.lost[1] ?? { n: 0, metal: 0 });
  const biggest = Math.max(1, ...ins.battles.map(total));
  // Each side's peak army near the battle (version 4+), by side.
  const sideOf = sideOfTeam(ins);
  const reach = (b: Battle) => {
    const r = [0, 0];
    for (const t of b.teams ?? []) {
      const sd = sideOf.get(t.team);
      if (sd === 0 || sd === 1) r[sd] += t.army;
    }
    return r;
  };

  ins.battles.forEach((b, i) => {
    const ring = s("circle", { cx: b.x, cy: b.z, class: "brs-ring" });
    const badge = s("circle", { cx: b.x, cy: b.z, class: "brs-badge" });
    const num = s("text", { x: b.x, y: b.z, "text-anchor": "middle", "dominant-baseline": "central", class: "brs-badgenum" }, String(i + 1));
    atWidth((w) => {
      ring.setAttribute("r", String(Math.max(b.r, 0.025 * w)));
      ring.setAttribute("stroke-width", String(0.003 * w));
      badge.setAttribute("r", String(0.024 * w));
      // A style, not an attribute: the scoped stylesheet sizes svg text, and
      // a stylesheet beats an attribute.
      num.setAttribute("style", `font-size: ${(0.03 * w).toFixed(0)}px`);
    });
    const g = s("g", { class: "brs-battle brs-clickable" }, ring, badge, num);
    tip(g, () => ({ title: `Battle ${i + 1} · ${when(b)} · ${compass(ins, b.x, b.z)}`, rows: lossRows(b), note: watch ? "Click to watch" : "Click for details" }));
    g.addEventListener("pointerenter", () => light(i, true));
    g.addEventListener("pointerleave", () => light(i, false));
    g.addEventListener("click", () => open(i));
    rings.push(g);
    view.layer.append(g);
  });

  // The list: one line a battle. Its bar leaves the centre line toward the
  // side that came out ahead, as far as how much less it lost (log scale,
  // ticks at 2x and 5x, the edge 10x), and ends in a dot sized by the metal
  // lost there; the two sides' losses follow as numbers.
  const ticks = [2, 5].flatMap((g) => [-1, 1].map((sg) => h("span", { class: "brs-vtick", style: `left: ${(50 + sg * 50 * Math.log10(g)).toFixed(1)}%` })));
  ins.battles.forEach((b, i) => {
    const l = lean(b);
    const end = 50 - 50 * l;
    const color = leanColor(b);
    const d = 5 + 11 * Math.sqrt(total(b) / biggest);
    const bar = h("span", { class: "brs-verdict" }, ...ticks.map((t) => t.cloneNode(true)),
      h("i", { style: `left: ${Math.min(50, end).toFixed(1)}%; width: ${Math.abs(end - 50).toFixed(1)}%; background: ${color}` }),
      h("b", { style: `left: ${end.toFixed(1)}%; width: ${d.toFixed(1)}px; height: ${d.toFixed(1)}px; background: ${color}` }));
    const nums = h("span", { class: "brs-bnums" },
      h("span", { style: `color: ${sideColor(ins, 0)}` }, fmt(size(b.lost[0] ?? { n: 0, metal: 0 }))),
      h("span", { class: "brs-muted" }, " : "),
      h("span", { style: `color: ${sideColor(ins, 1)}` }, fmt(size(b.lost[1] ?? { n: 0, metal: 0 }))));
    const play = watch ? h("button", { class: "brs-play", type: "button", "aria-label": `Watch battle ${i + 1}` }, "▶") : null;
    if (play && watch) play.addEventListener("click", (ev) => {
      ev.stopPropagation();
      watch(clipOf(b, i));
    });
    const row = h("div", { class: "brs-brow", tabindex: 0, role: "button" },
      h("span", { class: "brs-num brs-numlight" }, String(i + 1)),
      h("span", { class: "brs-when" }, fmtClock(b.f0 / SIM_FPS)),
      h("span", { class: "brs-where" }, compass(ins, b.x, b.z).replace(/^the /, "")),
      bar, nums,
      play);
    tip(row, () => ({ title: `Battle ${i + 1} · ${when(b)}`, rows: lossRows(b), note: verdict(b) + ratioText(b) }));
    row.addEventListener("pointerenter", () => light(i, true));
    row.addEventListener("pointerleave", () => light(i, false));
    row.addEventListener("click", () => open(i));
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        open(i);
      }
    });
    rows.push(row);
  });

  // Every battle at its time: height = lean (who came out ahead and by how
  // much), area = metal lost there, a faint ring = both armies near it at
  // their peak, a line = how long it ran.
  function timeline(): SVGSVGElement {
    const c = timeChart({ height: 240, durationSec: ins.durationSec, yMin: -1, yMax: 1, yTick: null, gutter: 34, watch, overflow: { top: 22, bottom: 22 } });
    const y0 = c.y(0);
    const bands = s("g", { "pointer-events": "none" },
      s("rect", { x: c.left, y: c.top, width: c.right - c.left, height: y0 - c.top, fill: sideColor(ins, 0), "fill-opacity": 0.06 }),
      s("rect", { x: c.left, y: y0, width: c.right - c.left, height: c.bottom - y0, fill: sideColor(ins, 1), "fill-opacity": 0.06 }),
      s("line", { x1: c.left, x2: c.right, y1: y0, y2: y0, stroke: "var(--brs-muted)" }));
    for (const g of [2, 5, 10]) {
      for (const sg of [1, -1]) {
        const yy = c.y(sg * Math.log10(g));
        bands.append(s("line", { x1: c.left, x2: c.right, y1: yy, y2: yy, stroke: "var(--brs-grid)", "stroke-dasharray": "3 4" }),
          s("text", { x: c.left - 6, y: yy + 4, "text-anchor": "end" }, `${g}×`));
      }
    }
    bands.append(
      s("text", { x: c.left + 6, y: c.top + 14, style: `fill: ${sideColor(ins, 0)}` }, `▲ ${sideName(ins, 0)} came out ahead`),
      s("text", { x: c.left + 6, y: c.bottom - 6, style: `fill: ${sideColor(ins, 1)}` }, `▼ ${sideName(ins, 1)} came out ahead`));
    c.plot.append(bands);
    const most = Math.max(1, ...ins.battles.map((b) => Math.max(total(b), reach(b)[0] + reach(b)[1])));
    const rad = (v: number) => 4 + 30 * Math.sqrt(v / most);
    // Above the crosshair's hit area, so a bubble takes its own pointer.
    const layer = s("g");
    const order = ins.battles.map((_, i) => i).sort((p, q) => total(ins.battles[q]) - total(ins.battles[p]));
    for (const i of order) {
      const b = ins.battles[i];
      const color = leanColor(b);
      const x0 = c.x(b.f0 / SIM_FPS);
      const x1 = c.x(b.f1 / SIM_FPS);
      const x = (x0 + x1) / 2;
      const yy = c.y(lean(b));
      const r = reach(b);
      const g = s("g", { class: "brs-bmark brs-clickable" },
        s("line", { x1: x0, x2: x1, y1: yy, y2: yy, stroke: color, "stroke-opacity": 0.5, "stroke-width": 2 }),
        r[0] + r[1] > 0 ? s("circle", { cx: x, cy: yy, r: rad(r[0] + r[1]), fill: "none", stroke: color, "stroke-opacity": 0.4 }) : null,
        s("circle", { class: "brs-bdot", cx: x, cy: yy, r: rad(total(b)), fill: color, "fill-opacity": 0.85 }),
        s("text", { x, y: yy + 4, "text-anchor": "middle", class: "brs-bmarknum" }, String(i + 1)));
      tip(g, () => ({
        title: `Battle ${i + 1} · ${when(b)} · ${compass(ins, b.x, b.z)}`,
        rows: [...lossRows(b), ...(r[0] + r[1] > 0 ? [0, 1].map((sd) => ({ color: sideColor(ins, sd), label: `${sideName(ins, sd)} army nearby`, value: fmtMetal(r[sd]) })) : [])],
        note: verdict(b) + ratioText(b) + (watch ? " · click to watch" : ""),
      }));
      g.addEventListener("pointerenter", () => light(i, true));
      g.addEventListener("pointerleave", () => light(i, false));
      g.addEventListener("click", (ev) => {
        ev.stopPropagation();
        open(i);
      });
      marks[i] = g;
      layer.append(g);
    }
    c.svg.append(layer);
    c.svg.classList.add("brs-btimeline");
    return c.svg;
  }

  function battleDetail(i: number): HTMLElement {
    const b = ins.battles[i];
    // The side that lost less is boxed in its colour: which side came out
    // ahead, without a sentence saying so (an even trade boxes neither).
    // A battle its loser lost to its own blasts was won by nobody.
    const ahead = aheadOf(b);
    // One column a side, side by side: who, how much, then what — each
    // kind of unit lost as its icon with a count.
    const lossCol = (sd: number) => {
      const l = b.lost[sd] ?? { n: 0, metal: 0, top: [] };
      const units = l.units ?? l.top.map((def) => ({ def, n: 0, metal: 0 }));
      const list = h("div", { class: "brs-units" });
      void fillUnits(list, ins, opts, units, priced);
      const won = sd === ahead;
      const head = h("div", { class: "brs-losshead", style: `color: ${sideColor(ins, sd)}` }, sideName(ins, sd));
      if (won) {
        const bg = sideColor(ins, sd);
        const mark = h("span", { class: "brs-ahead", style: `background: ${bg}; color: ${inkOn(bg)}` }, "▲ ahead");
        tip(mark, { title: `${sideName(ins, sd)} lost less here` });
        head.append(mark);
      }
      return h("div", { class: "brs-losscol" + (won ? " brs-won" : ""), style: `--brs-side: ${sideColor(ins, sd)}` },
        head,
        h("div", { class: "brs-muted" }, `${l.n} lost` + (priced && l.metal ? ` · ${fmt(l.metal)} metal` : "")),
        list);
    };
    // Who fought, each side's names over its own column.
    const fs = fighters(ins, b);
    const names = fs.some((l) => l.length)
      ? [fighterNames(ins, fs[0] ?? [], 0), h("span", { class: "brs-muted brs-vs" }, "vs"), fighterNames(ins, fs[1] ?? [], 1)]
      : [];
    const play = watch ? h("button", { class: "brs-watchbtn", type: "button" }, "▶ Watch this battle") : null;
    if (play && watch) play.addEventListener("click", () => watch(clipOf(b, i)));
    return h("div", undefined,
      h("div", undefined, h("b", undefined, `Battle ${i + 1}`), h("span", { class: "brs-muted" }, ` · ${when(b)} · ${compass(ins, b.x, b.z)}`)),
      h("div", { class: "brs-losscols" }, ...names, lossCol(0), h("span"), lossCol(1)), play);
  }

  const list = ins.battles.length
    ? h("div", { class: "brs-blist" },
      h("div", { class: "brs-brow brs-bhead" }, h("span"), h("span"), h("span"),
        h("span", { class: "brs-vhead" },
          h("span", { style: `color: ${sideColor(ins, 0)}` }, `◀ ${sideName(ins, 0)}`),
          h("span", { style: `color: ${sideColor(ins, 1)}` }, `${sideName(ins, 1)} ▶`)),
        h("span", { class: "brs-muted brs-bnumhead" }, priced ? "metal lost" : "units lost"), h("span")),
      ...rows, detail)
    : null;
  return section("Battles",
    h("p", { class: "brs-hint" }, "Numbers: the biggest fights in the order they happened, each ringed by the ground it covered. Above the line the first side came out ahead, below it the second, further out the less it lost against the other; a bubble's size is the metal lost there, grey when a side's own blasts did most of it. Click one to watch it and see its losses."),
    timeline(),
    h("div", { class: "brs-storygrid" }, h("div", { class: "brs-mapwrap" }, view.svg), list));
}
