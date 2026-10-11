// Battles: where each army stood over the game (G2, the fronts) with the
// biggest fights marked on the same map and numbered in the order they
// happened, beside a one-line-per-battle list (G4). The map and the list are
// one control: hovering either lights the other, clicking either selects
// the battle, opens what each side lost there and plays its clip. Nothing here knows who killed what — a battle says where,
// when and what each side lost, and calls it for the side that lost less.
import { h, s, section } from "../dom";
import { fmtClock, fmtMetal } from "../format";
import { mapView } from "../mapview";
import { comparable, sideColor, sideName } from "../model";
import { compass, fighters } from "../moments";
import { fighterNames } from "../names";
import { fillUnits, inkOn } from "../unitchips";
import { tip, type TipRow } from "../tooltip";
import { clipSpan, watcher } from "../watch";
import { SIM_FPS, type Battle, type Insights, type SummaryOptions } from "../types";

export function mapStories(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  if (!comparable(ins)) return null;
  const hasFront = ins.series.front.some((row) => row.some(Boolean));
  if (!hasFront && ins.battles.length === 0) return null;
  const watch = watcher(opts);
  const priced = ins.battles.some((b) => b.lost.some((l) => l.metal > 0));
  const size = (l: { n: number; metal: number }) => (priced ? l.metal : l.n);
  const fmt = (v: number) => (priced ? fmtMetal(v) : `${v}`);
  const when = (b: Battle) => `${fmtClock(b.f0 / SIM_FPS)}–${fmtClock(b.f1 / SIM_FPS)}`;
  const clipOf = (b: Battle, i: number) => clipSpan(b.f0, b.f1, { x: b.x, z: b.z, r: Math.max(b.r, 800), title: `Battle ${i + 1} · ${when(b)}` });

  // Marks scale with the map, which is only known once its record arrives.
  const scaled: ((w: number) => void)[] = [];
  const view = mapView(ins, opts.mapApi, (v) => scaled.forEach((f) => f(v.width)));
  const atWidth = (f: (w: number) => void) => {
    scaled.push(f);
    f(view.width);
  };

  // Each side's army centre, step by step, brightening toward the end of the
  // game: where it starts faint is where the army began.
  ins.series.front.forEach((row, side) => {
    const n = row.length;
    for (let i = 1; i < n; i++) {
      const a = row[i - 1];
      const b = row[i];
      if (!a || !b) continue;
      const seg = s("line", {
        x1: a[0], y1: a[1], x2: b[0], y2: b[1],
        stroke: sideColor(ins, side), "stroke-opacity": 0.2 + 0.6 * (i / n), "stroke-linecap": "round", "pointer-events": "none",
      });
      atWidth((w) => seg.setAttribute("stroke-width", String(0.005 * w)));
      view.layer.append(seg);
    }
  });

  const rings: SVGGElement[] = [];
  const rows: HTMLElement[] = [];
  const detail = h("div", { class: "brs-battledetail" }, h("p", { class: "brs-hint" }, "Pick a battle on the map or in the list."));
  const light = (i: number, on: boolean) => {
    rings[i]?.classList.toggle("brs-hover", on);
    rows[i]?.classList.toggle("brs-hover", on);
  };
  const select = (i: number) => {
    rings.forEach((g, k) => g.classList.toggle("brs-on", k === i));
    rows.forEach((r, k) => r.classList.toggle("brs-on", k === i));
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
  const verdict = (b: Battle) => {
    const [a, c] = [size(b.lost[0] ?? { n: 0, metal: 0 }), size(b.lost[1] ?? { n: 0, metal: 0 })];
    return a === c ? "An even trade" : `${sideName(ins, a < c ? 0 : 1)} came out ahead`;
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

  // The list: one line a battle, its losses as a bar either side of a
  // centre line, the first side's to the left. Square-root scaled: the last
  // fight of a long game can cost a hundred times the first, which would
  // leave every early row an empty track.
  const most = Math.max(1, ...ins.battles.map((b) => Math.max(size(b.lost[0] ?? { n: 0, metal: 0 }), size(b.lost[1] ?? { n: 0, metal: 0 }))));
  ins.battles.forEach((b, i) => {
    const half = (sd: number) => {
      const v = size(b.lost[sd] ?? { n: 0, metal: 0 });
      return h("span", { class: "brs-half" + (sd === 0 ? " brs-left" : "") },
        h("i", { style: `width: ${(100 * Math.sqrt(v / most)).toFixed(1)}%; background: ${sideColor(ins, sd)}` }));
    };
    const play = watch ? h("button", { class: "brs-play", type: "button", "aria-label": `Watch battle ${i + 1}` }, "▶") : null;
    if (play && watch) play.addEventListener("click", (ev) => {
      ev.stopPropagation();
      watch(clipOf(b, i));
    });
    const row = h("div", { class: "brs-brow", tabindex: 0, role: "button" },
      h("span", { class: "brs-num brs-numlight" }, String(i + 1)),
      h("span", { class: "brs-when" }, fmtClock(b.f0 / SIM_FPS)),
      h("span", { class: "brs-where" }, compass(ins, b.x, b.z).replace(/^the /, "")),
      h("span", { class: "brs-lossbar" }, half(0), half(1)),
      play);
    tip(row, () => ({ title: `Battle ${i + 1} · ${when(b)}`, rows: lossRows(b), note: verdict(b) }));
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

  function battleDetail(i: number): HTMLElement {
    const b = ins.battles[i];
    // The side that lost less is boxed in its colour: which side came out
    // ahead, without a sentence saying so (an even trade boxes neither).
    const [a, c] = [size(b.lost[0] ?? { n: 0, metal: 0 }), size(b.lost[1] ?? { n: 0, metal: 0 })];
    const ahead = a === c ? -1 : a < c ? 0 : 1;
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
      h("div", { class: "brs-bhead" },
        h("span", { style: `color: ${sideColor(ins, 0)}` }, `◀ ${sideName(ins, 0)} lost`),
        h("span", { style: `color: ${sideColor(ins, 1)}` }, `${sideName(ins, 1)} lost ▶`)),
      ...rows, detail)
    : null;
  return section("Battles",
    h("p", { class: "brs-hint" }, "Lines: where each army stood, faint early and bright late. Numbers: the biggest fights in the order they happened, each ringed by the ground it covered. Click one to watch it and see its losses."),
    h("div", { class: "brs-storygrid" }, h("div", { class: "brs-mapwrap" }, view.svg), list));
}
