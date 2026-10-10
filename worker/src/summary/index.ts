// The game summary, as a library: mountSummary draws a replay's insights
// file (internal/insights) into an element. It reads nothing but that file
// and imports nothing from the viewer, so any page holding the file can show
// the same summary — the replay viewer's Summary tab today, the lavabalance
// site later. The one hook back into a host is onSeek, a callback taking a
// sim frame, which the viewer uses to jump the replay to a moment.
import { h, section } from "./dom";
import { fmtClock, fmtMetal } from "./format";
import { comparable, notices, sideColor, sideName } from "./model";
import { ensureStyles } from "./styles";
import { advantage } from "./sections/advantage";
import { awards } from "./sections/awards";
import { mapStories } from "./sections/battles";
import { fingerprint } from "./sections/fingerprint";
import { chat } from "./sections/chat";
import { killing } from "./sections/killing";
import { rivers } from "./sections/rivers";
import { playerReport, reportsShown } from "./sections/player";
import { tech } from "./sections/tech";
import type { Insights, SummaryHandle, SummaryOptions } from "./types";

export type * from "./types";
export { comparable, notices } from "./model";

/** The newest insights file version this build draws. */
export const INSIGHTS_VERSION = 2;

/** Every version this build draws, newest first: version 2 only adds to
 * version 1 (the winner and the swing line), so an older file draws with
 * those parts missing. A host fetches the first that exists. */
export const INSIGHTS_VERSIONS = [2, 1];

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
    for (const sec of SECTIONS) {
      const node = sec(ins, opts);
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

/** overview: who played, and each side's headline numbers. When the file
 * carries player reports each name is a button opening that player's report
 * under the cards; clicking the same name again closes it. */
const overview: Section = (ins, opts) => {
  const slot = h("div", { class: "brs-reportslot" });
  const reports = reportsShown(ins) ? ins.players : [];
  let open: HTMLElement | null = null;
  const names = (i: number, players: string[]): (HTMLElement | string)[] => {
    const out: (HTMLElement | string)[] = [];
    players.forEach((name, k) => {
      if (k) out.push(", ");
      const pl = reports.find((p) => p.side === i && p.player === name);
      if (!pl) {
        out.push(name);
        return;
      }
      const btn = h("button", { class: "brs-playerbtn", type: "button", title: `Open ${name}'s report` }, name);
      btn.addEventListener("click", () => {
        const wasOpen = open === btn;
        slot.replaceChildren();
        open?.classList.remove("brs-on");
        open = null;
        if (wasOpen) return;
        slot.append(playerReport(ins, pl, opts));
        btn.classList.add("brs-on");
        open = btn;
      });
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
    const card = h("div", { class: "brs-side", style: `--brs-side: ${sideColor(ins, i)}` },
      h("b", undefined, sideName(ins, i)),
      h("div", { class: "brs-players" }, ...names(i, side.players)),
      h("div", { class: "brs-stat" }, h("span", undefined, "Average metal income"), `${avgMetal.toFixed(1)}/s`),
      showArmy && n > 0 ? h("div", { class: "brs-stat" }, h("span", undefined, "Largest army"), fmtMetal(peak)) : null,
    );
    return card;
  });
  const hint = reports.length ? h("p", { class: "brs-hint" }, "Click a player for their report.") : null;
  return section("Sides", h("div", { class: "brs-sides" }, ...cards), hint, slot);
};

/** SECTIONS in page order. */
const SECTIONS: Section[] = [overview, fingerprint, advantage, rivers, tech, mapStories, killing, awards, chat];
