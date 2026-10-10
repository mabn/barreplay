// Legends drawn ABOVE a chart rather than inside its plot, so a label can
// never sit on the data it explains.
import { h } from "./dom";
import { sideColor, sideName } from "./model";
import type { Insights } from "./types";

/** mirrorKey names the two sides of a mirrored chart: the first above the
 * axis, the second below it. Extra entries (a category key) follow them. */
export function mirrorKey(ins: Insights, ...extra: (HTMLElement | null)[]): HTMLElement {
  return h("div", { class: "brs-legend" },
    h("span", { style: `color: ${sideColor(ins, 0)}` }, `▲ ${sideName(ins, 0)}`),
    h("span", { style: `color: ${sideColor(ins, 1)}` }, `▼ ${sideName(ins, 1)}`),
    ...extra);
}

/** swatch is one coloured key entry. */
export function swatch(color: string, label: string): HTMLElement {
  return h("span", undefined, h("i", { style: `background: ${color}` }), label);
}
