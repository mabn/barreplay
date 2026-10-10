// Awards: six that a replay supports without knowing who killed what. Each
// goes to one unit, named with its owner; clicking one shows the moment.
import { h, section } from "../dom";
import { comparable, sideColor, sideOfTeam, teamColor } from "../model";
import { clipAround, watcher } from "../watch";
import type { Award, Insights, SummaryOptions } from "../types";

const ICONS: Record<string, string> = {
  immortal: "🛡", marathon: "🏃", tourist: "🧭", closecall: "❤", unfinished: "🏗", costliest: "💸",
};

/** where is the award's unit on the map when the moment is its death (the
 * costliest loss, the unfinished building), so its clip can zoom there. */
function whereOf(ins: Insights): (a: Award) => { x?: number; z?: number; r?: number } {
  const d = ins.deaths;
  return (a) => {
    for (let i = 0; i < d.f.length; i++) {
      if (d.f[i] === a.f && d.team[i] === a.team && d.def[i] === a.def && d.x[i] >= 0) return { x: d.x[i], z: d.z[i], r: 900 };
    }
    return {};
  };
}

export function awards(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  // A one-sided capture's units are only the ones it saw; an award picked
  // from those would crown a unit for being watched.
  if (ins.pov !== "full" || !ins.awards?.length) return null;
  const side = sideOfTeam(ins);
  const owner = new Map(ins.teams.map((t) => [t.team, t.player]));
  const watch = watcher(opts);
  const where = whereOf(ins);
  const cards = ins.awards.map((a) => {
    const def = ins.defs[String(a.def)];
    const sd = side.get(a.team) ?? -1;
    const who = owner.get(a.team) || `team ${a.team}`;
    const card = h("div", { class: "brs-card brs-award" + (watch ? " brs-seekable" : "") },
      h("div", { class: "brs-award-title" }, `${ICONS[a.key] ?? "★"} ${a.label}`),
      h("div", undefined,
        h("b", undefined, def?.human || def?.name || "a unit"), " of ",
        h("span", { style: `color: ${sd >= 0 ? teamColor(ins, a.team) : sideColor(ins, 0)}` }, who)),
      h("div", { class: "brs-hint" }, a.text),
      watch ? h("div", { class: "brs-watch" }, "▶ Watch") : null);
    if (watch) card.addEventListener("click", () => watch(clipAround(a.f, { ...where(a), title: `${a.label}: ${def?.human || def?.name || "a unit"} of ${who}` })));
    return card;
  });
  return section(comparable(ins) ? "Awards" : "Awards (this capture saw every side)", h("div", { class: "brs-cards" }, ...cards));
}
