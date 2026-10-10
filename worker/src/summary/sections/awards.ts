// Awards: six that a replay supports without knowing who killed what. Each
// goes to one unit, named with its owner; clicking one shows the moment.
import { h, section } from "../dom";
import { comparable, sideColor, sideOfTeam } from "../model";
import type { Insights, SummaryOptions } from "../types";

const ICONS: Record<string, string> = {
  immortal: "🛡", marathon: "🏃", tourist: "🧭", closecall: "❤", unfinished: "🏗", costliest: "💸",
};

export function awards(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  // A one-sided capture's units are only the ones it saw; an award picked
  // from those would crown a unit for being watched.
  if (ins.pov !== "full" || !ins.awards?.length) return null;
  const side = sideOfTeam(ins);
  const owner = new Map(ins.teams.map((t) => [t.team, t.player]));
  const cards = ins.awards.map((a) => {
    const def = ins.defs[String(a.def)];
    const sd = side.get(a.team) ?? -1;
    const who = owner.get(a.team) || `team ${a.team}`;
    const card = h("div", { class: "brs-card brs-award" + (opts.onSeek ? " brs-seekable" : "") },
      h("div", { class: "brs-award-title" }, `${ICONS[a.key] ?? "★"} ${a.label}`),
      h("div", undefined,
        h("b", undefined, def?.human || def?.name || "a unit"), " of ",
        h("span", { style: sd >= 0 ? `color: ${sideColor(ins, sd)}` : null }, who)),
      h("div", { class: "brs-hint" }, a.text));
    if (opts.onSeek) {
      const seek = opts.onSeek;
      card.addEventListener("click", () => seek(a.f));
    }
    return card;
  });
  return section(comparable(ins) ? "Awards" : "Awards (this capture saw every side)", h("div", { class: "brs-cards" }, ...cards));
}
