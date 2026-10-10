// One tooltip for the whole summary: an HTML box that follows the pointer and
// appears the moment it arrives. The browser's own title tooltip waits about
// a second, cannot be styled and cannot show a coloured key, which is most of
// what a chart's readout needs. The box lives inside the summary's root (so
// the scoped styles reach it) but is positioned against the window, so no
// panel clips it, and it flips to stay on screen near an edge.
import { h } from "./dom";

export interface TipRow {
  /** A swatch before the label: whose number this is. */
  color?: string;
  label: string;
  value?: string;
}

export interface Tip {
  title?: string;
  rows?: TipRow[];
  /** A muted last line: what a click does. */
  note?: string;
}

export type TipContent = Tip | string;

const OFFSET = 14;
const MARGIN = 8;

function box(from: Element): HTMLElement | null {
  const root = from.closest(".brs-root");
  if (!root) return null;
  let el = root.querySelector<HTMLElement>(":scope > .brs-tip");
  if (!el) {
    el = h("div", { class: "brs-tip", role: "tooltip" });
    root.append(el);
  }
  return el;
}

function render(el: HTMLElement, c: TipContent): void {
  el.replaceChildren();
  if (typeof c === "string") {
    el.append(h("div", undefined, c));
    return;
  }
  if (c.title) el.append(h("div", { class: "brs-tip-title" }, c.title));
  for (const r of c.rows ?? []) {
    el.append(h("div", { class: "brs-tip-row" },
      h("i", { style: r.color ? `background: ${r.color}` : "visibility: hidden" }),
      h("span", undefined, r.label),
      r.value !== undefined ? h("b", undefined, r.value) : null));
  }
  if (c.note) el.append(h("div", { class: "brs-tip-note" }, c.note));
}

/** showTip shows content beside the window point (x, y). */
export function showTip(from: Element, x: number, y: number, c: TipContent): void {
  const el = box(from);
  if (!el) return;
  render(el, c);
  el.style.display = "block";
  const w = el.offsetWidth;
  const hh = el.offsetHeight;
  const vw = from.ownerDocument.defaultView?.innerWidth ?? 1e4;
  const vh = from.ownerDocument.defaultView?.innerHeight ?? 1e4;
  let left = x + OFFSET;
  let top = y + OFFSET;
  if (left + w > vw - MARGIN) left = Math.max(MARGIN, x - OFFSET - w);
  if (top + hh > vh - MARGIN) top = Math.max(MARGIN, y - OFFSET - hh);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/** hideTip hides the summary's tooltip. */
export function hideTip(from: Element): void {
  const el = from.closest(".brs-root")?.querySelector<HTMLElement>(":scope > .brs-tip");
  if (el) el.style.display = "none";
}

/** tip gives one element a tooltip. content may be a function, read each
 * time the tooltip opens, so it can describe a state that changes. */
export function tip(el: Element, content: TipContent | (() => TipContent | null)): void {
  const get = () => (typeof content === "function" ? content() : content);
  const at = (ev: PointerEvent) => {
    const c = get();
    if (c) showTip(el, ev.clientX, ev.clientY, c);
    else hideTip(el);
  };
  el.addEventListener("pointerenter", at as EventListener);
  el.addEventListener("pointermove", at as EventListener);
  el.addEventListener("pointerleave", () => hideTip(el));
  el.addEventListener("focus", () => {
    const c = get();
    if (!c) return;
    const r = el.getBoundingClientRect();
    showTip(el, r.left + r.width / 2, r.bottom, c);
  });
  el.addEventListener("blur", () => hideTip(el));
}

/** tipLayer gives many marks tooltips through one listener on their
 * container: find maps the element under the pointer to its content, or
 * null for none. For layers of thousands of marks (every death on a map),
 * where a listener per mark would cost more than drawing them. */
export function tipLayer(container: Element, find: (target: Element) => TipContent | null): void {
  container.addEventListener("pointermove", ((ev: PointerEvent) => {
    const c = ev.target instanceof Element ? find(ev.target) : null;
    if (c) showTip(container, ev.clientX, ev.clientY, c);
    else hideTip(container);
  }) as EventListener);
  container.addEventListener("pointerleave", () => hideTip(container));
}
