// Player and side names in their colours: every name the summary writes,
// whether on its own or inside a sentence, is drawn in the colour the
// player had in the game (a side in its leader's), so a name reads the same
// in a chart key, a story and a chat line.
import { h } from "./dom";
import { fmtMetal } from "./format";
import { nameRuns, playerColor, sideColor, sideName } from "./model";
import type { Fighter } from "./moments";
import { tip } from "./tooltip";
import type { Insights } from "./types";

/** named is a span of text with every player and side name in it coloured. */
export function named(ins: Insights, text: string, attrs?: Record<string, string>): HTMLElement {
  return h("span", attrs, ...nameRuns(ins, text).map((r) => (r.color ? h("span", { style: `color: ${r.color}` }, r.text) : r.text)));
}

/** playerName is one player's name in their colour (plain for a name no
 * team carries: a spectator, the autohost). */
export function playerName(ins: Insights, name: string, tag: "span" | "b" = "span"): HTMLElement {
  const c = playerColor(ins, name);
  return h(tag, c ? { style: `color: ${c}` } : undefined, name);
}

/** fighterNames is one side's fighters, each name in its colour with what
 * it brought on hover — the side's own name when it names nobody. */
export function fighterNames(ins: Insights, list: Fighter[], sd: number): HTMLElement {
  const out = h("span", { class: "brs-fnames" });
  if (!list.length) {
    out.append(h("span", { style: `color: ${sideColor(ins, sd)}` }, sideName(ins, sd)));
    return out;
  }
  list.forEach((f, k) => {
    if (k) out.append(", ");
    const el = playerName(ins, f.name, "b");
    tip(el, { title: f.name, rows: [{ label: "Army there + lost + killed there", value: `${fmtMetal(f.metal)} metal · ${Math.round(f.share * 100)}% of ${sideName(ins, sd)}` }] });
    out.append(el);
  });
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
