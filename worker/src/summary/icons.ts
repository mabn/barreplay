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

/** iconSrc is the URL of a def's icon, or null when it has none (or icons
 * are off). Two defs drawn with the same bitmap share a src, which is how a
 * list of losses can count them as one kind. */
export async function iconSrc(ins: Insights, opts: SummaryOptions, def: number): Promise<string | null> {
  const d = ins.defs[String(def)];
  const base = iconBase(opts);
  if (!base || !d) return null;
  const tab = await iconTable(base);
  const ic = (d.icon && tab[d.icon]) || tab[d.name];
  return ic ? `${base}/${ic.p.replace(/^\//, "")}` : null;
}

/** iconImg is an <img> of src that falls back to label if it fails. */
export function iconImg(src: string, label: string): HTMLElement {
  const img = h("img", { class: "brs-uicon", src, alt: label });
  img.addEventListener("error", () => img.replaceWith(h("span", { class: "brs-uname" }, label)));
  return img;
}
