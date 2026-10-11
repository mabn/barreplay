// Awards: seven that a replay supports without knowing who killed what. Each
// goes to ONE unit among thousands, so each says which: a small route map
// on the card, and a clip that follows the unit, rings it and draws where
// it went (Clip.follow / Clip.path, Version 4 files).
//
// Below them, the ACHIEVEMENTS: the shortlist's rules a demo and the BAR API
// can decide, judged in the browser (achievements/), loaded after the page
// draws since they need the game's demo.
import { describe, loadAchievements, type AchievementResult, type Hit } from "../achievements";
import { RARITY_NAMES, rarityOf } from "../achievements/rarity";
import { h, s, section } from "../dom";
import { comparable, sideColor, sideOfTeam, sideShort, teamColor } from "../model";
import { named, unitRef } from "../names";
import { tip } from "../tooltip";
import { clipAround, clipEvent, watcher } from "../watch";
import { type Award, type Clip, type Insights, type SummaryOptions } from "../types";

const ICONS: Record<string, string> = {
  immortal: "🛡", marathon: "🏃", tourist: "🧭", closecall: "❤", healed: "🔧", unfinished: "🏗", costliest: "💸", blow: "💥", idle: "🛬", friendly: "🎯",
};

/** where is the award's unit on the map when the moment is its death (the
 * costliest loss, the unfinished building), so its clip can zoom there. */
function whereOf(ins: Insights): (a: Award) => { x?: number; z?: number } {
  const d = ins.deaths;
  return (a) => {
    if (a.pos) return { x: a.pos[0], z: a.pos[1] };
    for (let i = 0; i < d.f.length; i++) {
      if (d.f[i] === a.f && d.team[i] === a.team && d.def[i] === a.def && d.x[i] >= 0) return { x: d.x[i], z: d.z[i] };
    }
    return {};
  };
}

/** clipOf is what watching an award shows. A unit's whole life when the
 * award is for the life (Marathon, Tourist), else the moment around its
 * hardest time (Immortal, Close call) or its death (the losses). */
export function clipOf(a: Award, at: { x?: number; z?: number }, title: string): Clip {
  const unit = a.unit !== undefined ? { follow: { id: a.unit, def: a.def }, path: a.path } : {};
  const base = { ...unit, ...at, r: 700, title };
  if ((a.key === "marathon" || a.key === "tourist") && a.f0 !== undefined && a.f1 !== undefined && a.f1 > a.f0) {
    return { ...base, f0: a.f0, f1: a.f1 };
  }
  // A player's worst half-minute: the whole of it, wide enough to see.
  if (a.key === "blow" && a.f0 !== undefined && a.f1 !== undefined) {
    return clipEvent(a.f0, Math.max(a.f1, a.f0 + 1), { ...base, r: 1200 });
  }
  // A fleet nobody used: the stretch it was built over, following the last.
  if ((a.key === "idle" || a.key === "friendly") && a.f0 !== undefined && a.f1 !== undefined) {
    return clipEvent(a.f0, Math.max(a.f1, a.f0 + 1), base);
  }
  return clipAround(a.f, base);
}

/** routeMap draws the award's route over the map's outline: where on the
 * map to look, before the clip is opened. */
function routeMap(ins: Insights, a: Award, at: { x?: number; z?: number }): SVGSVGElement | null {
  const b = ins.bounds;
  const w = Math.max(512, b.maxX + 256);
  const hgt = Math.max(512, b.maxZ + 256);
  const sw = Math.max(w, hgt) / 60;
  const svg = s("svg", { viewBox: `0 0 ${w} ${hgt}`, class: "brs-awardmap", preserveAspectRatio: "xMidYMid meet" });
  svg.append(s("rect", { x: 0, y: 0, width: w, height: hgt, fill: "var(--brs-grid)", rx: sw }));
  const color = "#ffe14d";
  if (a.path && a.path.length > 1) {
    svg.append(s("polyline", {
      points: a.path.map((p) => `${p[1]},${p[2]}`).join(" "),
      fill: "none", stroke: color, "stroke-width": sw * 0.8, "stroke-linejoin": "round", "stroke-opacity": 0.85,
    }));
    const end = a.path[a.path.length - 1];
    svg.append(s("circle", { cx: a.path[0][1], cy: a.path[0][2], r: sw * 1.2, fill: "none", stroke: color, "stroke-width": sw * 0.6 }));
    svg.append(s("circle", { cx: end[1], cy: end[2], r: sw * 1.6, fill: color }));
    return svg;
  }
  if (at.x === undefined || at.z === undefined) return null;
  svg.append(s("circle", { cx: at.x, cy: at.z, r: sw * 2, fill: color }));
  return svg;
}

export function awards(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  const cards = awardCards(ins, opts);
  const ach = achievements(ins, opts);
  if (!cards && !ach) return null;
  const title = cards && !comparable(ins) ? "Awards (this capture saw every side)" : "Awards";
  return section(title, cards, ach);
}

function awardCards(ins: Insights, opts: SummaryOptions): HTMLElement | null {
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
    const name = def?.human || def?.name || "a unit";
    const at = where(a);
    const map = routeMap(ins, a, at);
    if (map) tip(map, { title: a.path ? "Where it went: from the ring to the dot" : "Where it was lost" });
    const card = h("div", { class: "brs-card brs-award" + (watch ? " brs-seekable" : "") },
      h("div", { class: "brs-award-title" }, `${ICONS[a.key] ?? "★"} ${a.label}`),
      h("div", { class: "brs-award-body" },
        map,
        h("div", undefined,
          // The blow is a player's, not one unit's: the text lists what went.
          h("div", undefined, ...(a.key === "blow" ? [] : [unitRef(ins, a.def, true), " of "]),
            h("span", { style: `color: ${sd >= 0 ? teamColor(ins, a.team) : sideColor(ins, 0)}`, class: a.key === "blow" ? "brs-strong" : null }, who)),
          named(ins, a.text, { class: "brs-hint" }))),
      watch ? h("div", { class: "brs-watch" }, a.unit !== undefined ? "▶ Watch it (followed and ringed)" : "▶ Watch") : null);
    if (watch) card.addEventListener("click", () => watch(clipOf(a, at, a.key === "blow" ? `${a.label}: ${who}` : `${a.label}: ${name} of ${who}`)));
    return card;
  });
  return h("div", { class: "brs-cards" }, ...cards);
}

/** achievements is the achievements block: a placeholder while the demo
 * downloads, then every rule the game earned, and folded lists of the ones
 * nobody earned and the ones this game cannot decide. Null when the host
 * names no BAR API proxy that serves demos (barApi). */
function achievements(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  const api = opts.barApi !== undefined ? opts.barApi : opts.mapApi ?? null;
  if (!api || !ins.gameId) return null;
  const el = h("div", { class: "brs-ach" },
    h("h4", undefined, "Achievements"),
    h("div", { class: "brs-hint" }, "Checking achievements: reading the game's demo…"));
  loadAchievements(ins, api, opts.brpUrl ?? null).then(
    (r) => el.replaceChildren(...renderAchievements(ins, opts, r)),
    (e: Error) => el.replaceChildren(h("h4", undefined, "Achievements"),
      h("div", { class: "brs-hint" }, `Achievements could not be checked: ${e.message}.`)));
  return el;
}

function renderAchievements(ins: Insights, opts: SummaryOptions, r: AchievementResult): Node[] {
  const watch = watcher(opts);
  // Rarest first, by the shortlist's estimate and then by how many earned it
  // here: a rule half the lobby earned says less than one only a single
  // player did.
  const earned = [...r.earned].sort((a, b) => rarityOf(b.rule.id) - rarityOf(a.rule.id) || a.hits.length - b.hits.length);
  const cards = earned.map(({ rule, hits }) => h("div", { class: "brs-card brs-achcard" },
    h("div", { class: "brs-award-title" }, `★ ${rule.name} `, rarityChip(rule.id)),
    h("div", { class: "brs-hint" }, describe(rule)),
    h("ul", { class: "brs-achhits" }, ...hits.map((hit) => {
      const li = h("li", { class: hit.f !== undefined && watch ? "brs-seekable" : null }, whoOf(ins, hit), ": ", hit.text,
        hit.f !== undefined && watch ? h("span", { class: "brs-watch" }, " ▶") : null);
      if (hit.f !== undefined && watch) {
        const f = hit.f;
        li.addEventListener("click", () => watch(clipAround(f, { title: `${rule.name}: ${hit.text}` })));
      }
      return li;
    }))));
  const nameList = (rules: { id: number; name: string; desc: string; why?: string }[]) =>
    h("ul", { class: "brs-achlist" }, ...rules.map((x) => h("li", undefined,
      h("span", { class: "brs-strong" }, x.name), " ", rarityChip(x.id), " ", h("span", { class: "brs-hint" }, x.why ? `${x.desc} (${x.why})` : x.desc))));
  const total = r.earned.length + r.missed.length + r.unknown.length;
  const out: (Node | null)[] = [
    h("h4", undefined, `Achievements: ${r.earned.length} of ${total} earned`),
    h("div", { class: "brs-hint" }, "Judged from the game's demo (orders, chat, end-of-game totals) and the BAR API. Orders count what was ORDERED, which can include builds that were cancelled. End-of-game totals are per team."),
    ...r.notes.map((n) => h("div", { class: "brs-hint" }, `Note: ${n}.`)),
    cards.length ? h("div", { class: "brs-cards" }, ...cards) : h("div", { class: "brs-hint" }, "Nobody earned one in this game."),
    r.missed.length ? h("details", { class: "brs-more" }, h("summary", undefined, `Not earned in this game (${r.missed.length})`), nameList(r.missed.map((x) => ({ id: x.id, name: x.name, desc: describe(x) })))) : null,
    r.unknown.length ? h("details", { class: "brs-more" }, h("summary", undefined, `Can't be checked for this game (${r.unknown.length})`),
      nameList(r.unknown.map((u) => ({ id: u.rule.id, name: u.rule.name, desc: describe(u.rule), why: u.why })))) : null,
  ];
  return out.filter((x): x is Node => x !== null);
}

/** rarityChip labels a rule with its estimated rarity (achievements/rarity.ts:
 * the shortlist's guess, 1 common to 5 legendary). */
function rarityChip(id: number): HTMLElement {
  const n = rarityOf(id);
  const el = h("span", { class: `brs-rarity brs-rarity${n}` }, RARITY_NAMES[n]);
  tip(el, { title: `Rarity ${n} of 5: estimated before any game was checked, not measured` });
  return el;
}

/** whoOf names who earned a hit: the player in their colour, their side in
 * its leader's, or the game itself. */
function whoOf(ins: Insights, hit: Hit): HTMLElement {
  if (hit.player) return h("span", { class: "brs-strong", style: `color: ${teamColor(ins, hit.player.team)}` }, hit.player.name);
  if (hit.side) {
    const i = ins.sides.findIndex((x) => x.ally === hit.side!.ally);
    if (i >= 0) return h("span", { class: "brs-strong", style: `color: ${sideColor(ins, i)}` }, sideShort(ins, i));
    return h("span", { class: "brs-strong" }, `Side ${hit.side.index + 1}`);
  }
  return h("span", { class: "brs-strong" }, "This game");
}
