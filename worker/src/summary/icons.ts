// Unit icons: BAR's own minimap bitmaps, from the replay viewer that hosts
// them (/icons/icontypes.json maps an icontypes key or a def name to a
// bitmap). They are grayscale, so drawn untinted they say WHAT a unit is and
// nothing about whose — a battle's columns already say that.
import { h } from "./dom";
import type { Insights, SummaryOptions } from "./types";

type IconTable = Record<string, { p: string; s?: number }>;

const tables = new Map<string, Promise<IconTable>>();

/** iconBase is the origin icons are read from, or null for none. */
export function iconBase(opts: SummaryOptions): string | null {
  if (opts.iconBase !== undefined) return opts.iconBase;
  try {
    return new URL(import.meta.url).origin;
  } catch {
    return null;
  }
}

/** iconTable fetches the icon table once per origin; a failure is no icons. */
function iconTable(base: string): Promise<IconTable> {
  let t = tables.get(base);
  if (!t) {
    t = fetch(`${base}/icons/icontypes.json`)
      .then((r) => (r.ok ? (r.json() as Promise<IconTable>) : {}))
      .catch(() => {
        tables.delete(base);
        return {};
      });
    tables.set(base, t);
  }
  return t;
}

/** unitIcon is an element naming a def: its icon once the table has it, its
 * name until then and wherever there is no icon. */
export function unitIcon(ins: Insights, opts: SummaryOptions, def: number): HTMLElement {
  const d = ins.defs[String(def)];
  const label = d?.human || d?.name || "?";
  const el = h("span", { class: "brs-uname" }, label);
  const base = iconBase(opts);
  if (!base || !d) return el;
  void iconTable(base).then((tab) => {
    const ic = (d.icon && tab[d.icon]) || tab[d.name];
    if (!ic) return;
    const img = h("img", { class: "brs-uicon", src: `${base}/${ic.p.replace(/^\//, "")}`, alt: label });
    img.addEventListener("error", () => img.replaceWith(h("span", { class: "brs-uname" }, label)));
    el.replaceWith(img);
  });
  return el;
}
