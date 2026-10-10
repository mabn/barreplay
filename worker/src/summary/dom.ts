// Tiny DOM and SVG builders. The library touches no globals and nothing
// outside the element it is mounted in, so it can sit in any page.

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | null | undefined | false;

function apply(el: Element, attrs: Attrs | undefined, children: Child[]): void {
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

/** h builds an HTML element. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** s builds an SVG element. */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs, children);
  return el;
}

/** section wraps one part of the summary under its heading. */
export function section(title: string, ...body: Child[]): HTMLElement {
  return h("section", { class: "brs-section" }, h("h3", undefined, title), ...body);
}
