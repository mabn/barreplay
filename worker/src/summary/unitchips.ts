// What a side lost, drawn as KINDS of unit: one chip per icon (defs sharing
// a bitmap add up) with a count, the kinds carrying 90% of the metal shown
// and the rest behind a "+N more" chip. Shared by the battle detail and the
// swings list, which show losses the same way side by side.
import { h } from "./dom";
import { fmtMetal } from "./format";
import { iconImg, iconSrc } from "./icons";
import { lossKinds, type LossKind } from "./losskinds";
import { tip } from "./tooltip";
import type { Insights, SummaryOptions, UnitLoss } from "./types";

/** fillUnits fills list with the chips for units (icons load first), at
 * most `max` of them up front when given. verb is what happened to them,
 * for the tooltips: "lost", or "built" for a build-up. */
export async function fillUnits(list: HTMLElement, ins: Insights, opts: SummaryOptions, units: UnitLoss[], priced: boolean, max = Infinity, verb = "lost"): Promise<void> {
  const name = (d: number) => ins.defs[String(d)]?.human || ins.defs[String(d)]?.name || "?";
  const src = new Map<number, string | null>();
  await Promise.all(units.map(async (u) => src.set(u.def, await iconSrc(ins, opts, u.def))));
  const split = lossKinds(units, (u) => src.get(u.def) ?? `def:${u.def}`);
  const main = split.main.slice(0, max);
  const rest = [...split.main.slice(max), ...split.rest];
  const chip = (g: LossKind) => {
    const label = g.defs.map((u) => name(u.def)).join(", ");
    const icon = src.get(g.defs[0].def);
    const el = h("span", { class: "brs-unit" }, icon ? iconImg(icon, label) : h("span", { class: "brs-uname" }, label), g.n ? h("span", undefined, `×${g.n}`) : null);
    tip(el, {
      title: g.defs.length > 1 ? (g.n ? `${g.n} ${verb}` : label) : name(g.defs[0].def),
      // n 0 is a count the file never recorded (a pre-v4 summary lists only
      // its top defs): say nothing rather than "0 lost".
      rows: g.defs.map((u) => ({ label: g.defs.length > 1 ? (u.n ? `${name(u.def)} ×${u.n}` : name(u.def)) : u.n ? `${u.n} ${verb}` : `Among the costliest ${verb}`, value: priced && u.metal ? `${fmtMetal(u.metal)} metal` : "" })),
    });
    return el;
  };
  list.replaceChildren(...main.map(chip));
  if (rest.length) {
    const n = rest.reduce((a, g) => a + g.n, 0);
    const more = h("button", { class: "brs-more", type: "button", "aria-expanded": "false" }, `+${rest.length} more`);
    tip(more, { title: `${n} more ${verb}`, rows: [{ label: rest.length > split.rest.length ? (verb === "lost" ? "The smaller losses" : "The smaller ones") : "Less than a tenth of the metal" }], note: "Click to show" });
    more.addEventListener("click", (ev) => {
      ev.stopPropagation();
      more.replaceWith(...rest.map(chip));
    });
    list.append(more);
  }
}

/** inkOn is black or white, whichever reads on the colour hex. */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return "#000";
  const lin = (x: string) => {
    const c = parseInt(x, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const l = 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
  return l > 0.179 ? "#000" : "#fff";
}
