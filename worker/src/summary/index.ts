// The game summary, as a library: mountSummary draws a replay's insights
// file (internal/insights) into an element. It reads nothing but that file
// and imports nothing from the viewer, so any page holding the file can show
// the same summary — the replay viewer's Summary tab today, the lavabalance
// site later. The hooks back into a host are onClip, taking a span of the
// game to play (the viewer plays it in a small player over the summary), and
// onSeek, taking a sim frame, for a host that can only jump its replay.
import { h, section } from "./dom";
import { fmtClock, fmtMetal } from "./format";
import { comparable, nameRuns, notices, sideColor, sideName, teamColor } from "./model";
import { bindIcons, playerName } from "./names";
import { ensureStyles } from "./styles";
import { tip } from "./tooltip";
import { advantage } from "./sections/advantage";
import { awards } from "./sections/awards";
import { mapStories } from "./sections/battles";
import { chat } from "./sections/chat";
import { killing } from "./sections/killing";
import { rivers } from "./sections/rivers";
import { playersSection, type PlayersView } from "./sections/player";
import { tech } from "./sections/tech";
import type { Insights, SummaryHandle, SummaryOptions } from "./types";

export type * from "./types";
export { comparable, notices } from "./model";

/** The newest insights file version this build draws. */
export const INSIGHTS_VERSION = 5;

/** Every version this build draws, newest first: each only adds to the one
 * before (2: the winner and the swing line; 3: eliminations, and battles
 * found as peaks without them; 4: units their own side reclaimed are no
 * longer deaths; 5: self-destructs are marked), so an older file draws with those parts missing. A host
 * fetches the first that exists. */
export const INSIGHTS_VERSIONS = [6, 5, 4, 3, 2, 1];

/** insightsFile names a revision's insights piece. */
export function insightsFile(rid: string, version = INSIGHTS_VERSION): string {
  return `${rid}.insights${version}.json`;
}

/** A section draws one part of the summary, or returns null when the file
 * cannot support it (a one-sided capture, no chat). */
export type Section = (ins: Insights, opts: SummaryOptions) => HTMLElement | null;

export function mountSummary(el: HTMLElement, ins: Insights, opts: SummaryOptions = {}): SummaryHandle {
  ensureStyles(el.ownerDocument);
  const root = h("div", { class: "brs-root" });
  if (!ins || !INSIGHTS_VERSIONS.includes(ins.version)) {
    root.append(h("p", { class: "brs-hint" }, `This summary was built in a format (version ${ins?.version ?? "?"}) this page cannot read.`));
  } else {
    root.append(header(ins));
    const notes = notices(ins);
    if (notes.length) root.append(h("ul", { class: "brs-notices" }, ...notes.map((n) => h("li", undefined, n))));
    // Every clip's title carries its names in colour for the host's player.
    const onClip = opts.onClip;
    const o: SummaryOptions = onClip
      ? { ...opts, onClip: (c) => onClip({ ...c, titleRuns: c.titleRuns ?? (c.title ? nameRuns(ins, c.title) : undefined) }) }
      : opts;
    bindIcons(ins, o);
    const players = playersSection(ins, o);
    for (const sec of sectionsFor(players)) {
      const node = sec(ins, o);
      if (node) root.append(node);
    }
  }
  el.append(root);
  return { destroy: () => root.remove() };
}

function header(ins: Insights): HTMLElement {
  const sizes = ins.sides.map((s) => s.players.length).join("v");
  const won = typeof ins.winner === "number" && ins.winner >= 0 && ins.winner < ins.sides.length
    ? h("span", { class: "brs-winner", style: `color: ${sideColor(ins, ins.winner)}` }, `${sideName(ins, ins.winner)} won`)
    : null;
  return h("div", undefined,
    h("h2", undefined, ins.mapName || "Game summary"),
    h("div", { class: "brs-meta" }, won, won ? " · " : null, [sizes, fmtClock(ins.durationSec), ins.gameId].filter(Boolean).join(" · ")),
  );
}

/** overview: who played, and each side's headline numbers. When the page
 * carries the players section each name is a button showing that player
 * there. */
function overview(players: PlayersView | null): Section {
  return (ins) => {
    const reports = players ? ins.players : [];
    const names = (i: number, list: string[]): (HTMLElement | string)[] => {
      const out: (HTMLElement | string)[] = [];
      list.forEach((name, k) => {
        if (k) out.push(", ");
        const pl = reports.find((p) => p.side === i && p.player === name);
        if (!pl || !players) {
          out.push(playerName(ins, name));
          return;
        }
        const btn = h("button", { class: "brs-playerbtn", type: "button", style: `--brs-team: ${teamColor(ins, pl.team)}` }, name);
        tip(btn, `Show ${name} under Players`);
        btn.addEventListener("click", () => players.select(pl.team));
        out.push(btn);
      });
      return out;
    };
    const n = ins.series.t.length;
    const showArmy = comparable(ins);
    const cards = ins.sides.map((side, i) => {
      const army = ins.series.army[i] ?? [];
      const metal = ins.series.metalIncome[i] ?? [];
      const peak = army.reduce((m, v) => Math.max(m, v), 0);
      const avgMetal = metal.length ? metal.reduce((a, b) => a + b, 0) / metal.length : 0;
      return h("div", { class: "brs-side", style: `--brs-side: ${sideColor(ins, i)}` },
        h("b", { style: `color: ${sideColor(ins, i)}` }, sideName(ins, i)),
        h("div", { class: "brs-players" }, ...names(i, side.players)),
        h("div", { class: "brs-stat" }, h("span", undefined, "Average metal income"), `${avgMetal.toFixed(1)}/s`),
        showArmy && n > 0 ? h("div", { class: "brs-stat" }, h("span", undefined, "Largest army"), fmtMetal(peak)) : null,
      );
    });
    return section("Sides", h("div", { class: "brs-sides" }, ...cards));
  };
}

/** sectionsFor lists the sections in page order. */
function sectionsFor(players: PlayersView | null): Section[] {
  return [overview(players), advantage, rivers, mapStories, () => players?.el ?? null, tech, killing, awards, chat];
}
