// Player and side names in their colours: every name the summary writes,
// whether on its own or inside a sentence, is drawn in the colour the
// player had in the game (a side in its leader's), so a name reads the same
// in a chart key, a story and a chat line.
import { h } from "./dom";
import { iconSrc } from "./icons";
import { fmtMetal } from "./format";
import { nameRuns, playerColor, sideColor, sideName } from "./model";
import type { Fighter } from "./moments";
import { tip } from "./tooltip";
import type { Insights, SummaryOptions } from "./types";

/** named is a span of text with every player and side name in it coloured
 * and every unit it mentions led by that unit's icon. */
export function named(ins: Insights, text: string, attrs?: Record<string, string>): HTMLElement {
  return h("span", attrs, ...nameRuns(ins, text).flatMap((r) => (r.color ? [h("span", { style: `color: ${r.color}` }, r.text)] : withUnits(ins, r.text))));
}

// Where a summary's icons come from: mountSummary binds its options to the
// file, so every unit mention finds them without being handed them.
const iconOpts = new WeakMap<Insights, SummaryOptions>();

/** bindIcons records the options a summary of ins was mounted with. */
export function bindIcons(ins: Insights, opts: SummaryOptions): void {
  iconOpts.set(ins, opts);
}

/** unitRef is a unit's name led by its strategic icon (untinted, at text
 * size); the icon appears once it has loaded, and a def without one is just
 * its name. */
export function unitRef(ins: Insights, def: number, bold = false): HTMLElement {
  const d = ins.defs[String(def)];
  const label = d?.human || d?.name || "a unit";
  const img = h("img", { class: "brs-uicon-inline", alt: "", style: "display: none" });
  void iconSrc(ins, iconOpts.get(ins) ?? {}, def).then((src) => {
    if (!src) return;
    img.addEventListener("load", () => img.style.removeProperty("display"), { once: true });
    img.src = src;
  });
  return h("span", { class: "brs-unitref" }, img, bold ? h("b", undefined, label) : label);
}

const unitNameCache = new WeakMap<Insights, { name: string; def: number }[]>();

/** unitNames is every unit name the file describes, longest first, so
 * "Advanced Fusion Reactor" wins over "Fusion Reactor". */
function unitNames(ins: Insights): { name: string; def: number }[] {
  let list = unitNameCache.get(ins);
  if (!list) {
    const seen = new Map<string, number>();
    for (const [id, d] of Object.entries(ins.defs)) {
      const name = d.human || d.name;
      if (name && name.length >= 3 && !seen.has(name)) seen.set(name, Number(id));
    }
    list = [...seen].map(([name, def]) => ({ name, def })).sort((a, b) => b.name.length - a.name.length);
    unitNameCache.set(ins, list);
  }
  return list;
}

/** withUnits splits plain text at every unit name it mentions. */
function withUnits(ins: Insights, text: string): (string | HTMLElement)[] {
  const names = unitNames(ins);
  const word = /[\p{L}\p{N}_]/u;
  const out: (string | HTMLElement)[] = [];
  let plain = "";
  let i = 0;
  outer: while (i < text.length) {
    if (i === 0 || !word.test(text[i - 1])) {
      for (const n of names) {
        const end = i + n.name.length;
        if (text.startsWith(n.name, i) && (end >= text.length || !word.test(text[end]))) {
          if (plain) out.push(plain);
          plain = "";
          out.push(unitRef(ins, n.def));
          i = end;
          continue outer;
        }
      }
    }
    plain += text[i++];
  }
  if (plain) out.push(plain);
  return out;
}

/** playerName is one player's name in their colour (plain for a name no
 * team carries: a spectator, the autohost). */
export function playerName(ins: Insights, name: string, tag: "span" | "b" = "span"): HTMLElement {
  const c = playerColor(ins, name);
  return h(tag, c ? { style: `color: ${c}` } : undefined, name);
}

/** fighterNames is one side's fighters, each name in its colour with what
 * it brought on hover — the side's own name when it names nobody. With max,
 * only the first max are named and the rest counted ("+2"). */
export function fighterNames(ins: Insights, list: Fighter[], sd: number, max = Infinity): HTMLElement {
  const out = h("span", { class: "brs-fnames" });
  if (!list.length) {
    out.append(h("span", { style: `color: ${sideColor(ins, sd)}` }, sideName(ins, sd)));
    return out;
  }
  list.slice(0, max).forEach((f, k) => {
    if (k) out.append(", ");
    const el = playerName(ins, f.name, "b");
    tip(el, { title: f.name, rows: [{ label: "Army there + lost + killed there", value: `${fmtMetal(f.metal)} metal · ${Math.round(f.share * 100)}% of ${sideName(ins, sd)}` }] });
    out.append(el);
  });
  if (list.length > max) out.append(h("span", { class: "brs-muted" }, ` +${list.length - max}`));
  return out;
}

/** fightersLine is who fought a battle, side against side — "BenzWillEs vs
 * mirtandir, Paracetamolletje" — each name in its colour, with what each
 * brought on hover. Null when no side names anyone. */
export function fightersLine(ins: Insights, sides: Fighter[][]): HTMLElement | null {
  if (!sides.some((l) => l.length)) return null;
  const out = h("div", { class: "brs-fighters" });
  sides.forEach((list, sd) => {
    if (sd) out.append(h("span", { class: "brs-muted" }, " vs "));
    out.append(fighterNames(ins, list, sd));
  });
  return out;
}
