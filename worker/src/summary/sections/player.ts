// The players (P1, P2, P3, P8): one tab per player, and a map that always
// shows every commander's path at once, the chosen player's drawn bold. The
// map does not change as tabs change — only which path stands out — so
// switching players reads as moving a highlight, and a path on the map is
// itself a way to pick its player. Under the tabs: what the chosen player's
// commander did, where their economy leaked, a play style card ranking them
// against everyone else, and a strip of what they built, lost and said.
import { h, s, section } from "../dom";
import { fmtClock, fmtMetal } from "../format";
import { stepAt, timeChart } from "../chart";
import { swatch } from "../legend";
import { mapView } from "../mapview";
import { sideColor, sideName, teamColor } from "../model";
import { stepTimes } from "../series";
import { tip } from "../tooltip";
import { clipAround, watchNote, watcher, type Watch } from "../watch";
import { SIM_FPS, type Insights, type PlayerReport, type SummaryOptions } from "../types";

/** Elmos a second no commander covers on foot: BAR's walk at about 37, with
 * room for speed upgrades. A faster move between two steps is drawn as a gap. */
const MAX_COM_SPEED = 100;

/** reportsShown is whether player reports are offered: they compare players
 * across the game, which a one-sided capture cannot. */
export function reportsShown(ins: Insights): boolean {
  return ins.pov === "full" && Array.isArray(ins.players) && ins.players.length > 0;
}

export interface PlayersView {
  el: HTMLElement;
  /** Shows a team's player, and brings the section into view. */
  select(team: number): void;
}

export function playersSection(ins: Insights, opts: SummaryOptions): PlayersView | null {
  if (!reportsShown(ins)) return null;
  const watch = watcher(opts);
  const players = [...ins.players].sort((a, b) => a.side - b.side || a.team - b.team);
  let current = players[0];

  const tabs = h("div", { class: "brs-tabs", role: "tablist" });
  const buttons = new Map<number, HTMLButtonElement>();
  ins.sides.forEach((_, sd) => {
    const mine = players.filter((p) => p.side === sd);
    if (!mine.length) return;
    const group = h("div", { class: "brs-tabgroup" },
      h("span", { class: "brs-tabside", style: `color: ${sideColor(ins, sd)}` }, ins.sides.length === 2 ? (sd === 0 ? "▲" : "▼") : `${sd + 1}`));
    for (const pl of mine) {
      const b = h("button", { class: "brs-tab", type: "button", role: "tab", style: `--brs-team: ${teamColor(ins, pl.team)}` }, pl.player || `Team ${pl.team}`);
      b.addEventListener("click", () => show(pl));
      buttons.set(pl.team, b);
      group.append(b);
    }
    tabs.append(group);
  });

  const trails = commanderMap(ins, players, (pl) => show(pl), watch, opts.mapApi);
  const detail = h("div", { class: "brs-pdetail" });
  const stripSlot = h("div");
  const el = section("Players",
    h("p", { class: "brs-hint" }, "Pick a player, or click a commander's path on the map."),
    tabs,
    h("div", { class: "brs-reportgrid" }, trails.el, detail),
    stripSlot);

  function show(pl: PlayerReport): void {
    current = pl;
    for (const [team, b] of buttons) {
      b.classList.toggle("brs-on", team === pl.team);
      b.setAttribute("aria-selected", String(team === pl.team));
    }
    trails.highlight(pl.team);
    detail.replaceChildren(
      h("h2", { style: `color: ${teamColor(ins, pl.team)}` }, pl.player || `Team ${pl.team}`),
      h("div", { style: `margin: -2px 0 10px; color: ${sideColor(ins, pl.side)}` }, sideName(ins, pl.side)),
      diary(ins, pl),
      leaks(pl),
      style(ins, pl));
    stripSlot.replaceChildren(strip(ins, pl, watch));
  }
  show(current);
  return {
    el,
    select(team: number) {
      const pl = players.find((p) => p.team === team);
      if (!pl) return;
      show(pl);
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  };
}

interface Trails {
  el: HTMLElement;
  highlight(team: number): void;
}

/** commanderMap draws every commander's path over the map: thin and faint,
 * except the highlighted player's, which is drawn bold over the others on a
 * dark casing. Hovering a path names it; clicking one picks its player. */
function commanderMap(ins: Insights, players: PlayerReport[], pick: (pl: PlayerReport) => void, watch: Watch | null, mapApi: string | null | undefined): Trails {
  type Drawn = { pl: PlayerReport; g: SVGGElement; casing: SVGPathElement; line: SVGPathElement; start: SVGCircleElement; end: SVGElement | null; at: number[] };
  const drawn: Drawn[] = [];
  let on = -1;
  const view = mapView(ins, mapApi, () => paint());
  const paint = () => {
    const w = view.width;
    for (const d of drawn) {
      const sel = d.pl.team === on;
      d.line.setAttribute("stroke-width", String((sel ? 0.008 : 0.0035) * w));
      d.line.setAttribute("stroke-opacity", sel ? "1" : "0.5");
      d.casing.setAttribute("stroke-width", String(0.014 * w));
      d.casing.setAttribute("visibility", sel ? "visible" : "hidden");
      d.g.querySelector(".brs-hit")?.setAttribute("stroke-width", String(0.02 * w));
      d.start.setAttribute("r", String((sel ? 0.011 : 0.007) * w));
      if (d.end) {
        const r = (sel ? 0.02 : 0.012) * w;
        const [x, z] = d.at;
        d.end.setAttribute("d", `M${x - r},${z - r}L${x + r},${z + r}M${x + r},${z - r}L${x - r},${z + r}`);
        d.end.setAttribute("opacity", sel ? "1" : "0.55");
        d.end.setAttribute("stroke-width", String((sel ? 0.007 : 0.004) * w));
      }
    }
    const top = drawn.find((d) => d.pl.team === on);
    if (top) view.layer.append(top.g); // drawn last: over every other path
  };
  for (const pl of players) {
    const color = teamColor(ins, pl.team);
    let d = "";
    let pen = false;
    let first: number[] | null = null;
    let last: number[] | null = null;
    for (const p of pl.commander.path) {
      if (!p) {
        pen = false;
        continue;
      }
      // Lifted over a jump no commander walks in one step: the path moved
      // to another commander (a teammate's, given to this player) or rode
      // a transport, and a straight line would invent a route.
      if (pen && last && Math.hypot(p[0] - last[0], p[1] - last[1]) > MAX_COM_SPEED * ins.stepSec) pen = false;
      d += (pen ? "L" : "M") + p[0] + "," + p[1];
      pen = true;
      first = first ?? p;
      last = p;
    }
    if (!d || !first || !last) continue;
    const name = pl.player || `Team ${pl.team}`;
    const casing = s("path", { d, fill: "none", stroke: "#000", "stroke-opacity": 0.55, "stroke-linecap": "round", "stroke-linejoin": "round" });
    const line = s("path", { d, fill: "none", stroke: color, "stroke-linecap": "round", "stroke-linejoin": "round" });
    const hit = s("path", { d, fill: "none", stroke: "transparent", "stroke-linecap": "round", "stroke-linejoin": "round", class: "brs-hit brs-clickable", "pointer-events": "stroke" });
    const start = s("circle", { cx: first[0], cy: first[1], r: 0.008 * view.width, fill: color, "pointer-events": "none" });
    const g = s("g", undefined, casing, line, start, hit);
    let end: SVGElement | null = null;
    const died = pl.commander.died;
    if (died >= 0) {
      const [x, z] = last;
      end = s("path", {
        stroke: color, "stroke-linecap": "round", class: watch ? "brs-clickable" : null,
      });
      tip(end, { title: `${name}'s commander dies`, rows: [{ color, label: fmtClock(died / SIM_FPS) }], note: watchNote(watch) });
      if (watch) end.addEventListener("click", () => watch(clipAround(died, { x, z, r: 1500, title: `${name}'s commander dies` })));
      g.append(end);
    }
    tip(hit, () => ({
      title: `${name}'s commander`,
      rows: [{ color, label: died >= 0 ? `died at ${fmtClock(died / SIM_FPS)}` : "survived the game" }],
      note: pl.team === on ? undefined : "Click to show this player",
    }));
    hit.addEventListener("click", () => pick(pl));
    view.layer.append(g);
    drawn.push({ pl, g, casing, line, start, end, at: last });
  }
  const el = h("div", undefined,
    h("h3", undefined, "Commanders"),
    h("div", { class: "brs-mapwrap brs-small" }, view.svg),
    h("div", { class: "brs-legend", style: "margin-top: 6px" },
      h("span", undefined, "● start"), h("span", undefined, "✕ commander died"), h("span", undefined, "bold: the chosen player")));
  return {
    el,
    highlight(team: number) {
      on = team;
      paint();
    },
  };
}

/** strip: built above the axis, lost below, chat as dots, and the two
 * moments of the commander's day as lines. */
function strip(ins: Insights, pl: PlayerReport, watch: Watch | null): HTMLElement {
  const priced = ins.costCoverage === "full";
  const built = priced ? pl.strip.builtMetal : pl.strip.builtN;
  const lost = priced ? pl.strip.lostMetal : pl.strip.lostN;
  const top = Math.max(1, ...built, ...lost);
  const t = stepTimes(ins);
  const fmt = (v: number) => (priced ? fmtMetal(v) : String(Math.round(v)));
  const color = teamColor(ins, pl.team);
  const c = timeChart({
    height: 170, durationSec: ins.durationSec, yMin: -top, yMax: top, zeroLine: true,
    yTick: (v) => fmt(Math.abs(v)), watch,
    readout: (tt) => {
      const i = stepAt(t, tt);
      if (i < 0) return null;
      const rows = [
        { color, label: "Built", value: fmt(built[i] ?? 0) },
        { color: "#e06a5a", label: "Lost", value: fmt(lost[i] ?? 0) },
      ];
      if (pl.strip.chat[i]) rows.push({ color: "var(--brs-text)", label: "Chat lines", value: String(pl.strip.chat[i]) });
      return rows;
    },
  });
  const w = ((c.right - c.left) / Math.max(1, t.length)) * 0.8;
  t.forEach((tt, i) => {
    const x = c.x(tt - ins.stepSec / 2) - w / 2;
    if (built[i]) c.plot.append(s("rect", { x, y: c.y(built[i]), width: w, height: c.y(0) - c.y(built[i]), fill: color, "fill-opacity": 0.75 }));
    if (lost[i]) c.plot.append(s("rect", { x, y: c.y(0), width: w, height: c.y(-lost[i]) - c.y(0), fill: "#e06a5a", "fill-opacity": 0.75 }));
    if (pl.strip.chat[i]) c.plot.append(s("circle", { cx: c.x(tt - ins.stepSec / 2), cy: c.bottom - 4, r: Math.min(5, 1.5 + pl.strip.chat[i]), fill: "var(--brs-text)" }));
  });
  const moment = (f: number, label: string) => {
    if (f < 0) return;
    const x = c.x(f / SIM_FPS);
    c.plot.append(s("line", { x1: x, x2: x, y1: c.top, y2: c.bottom, stroke: "var(--brs-accent)", "stroke-dasharray": "4 3" }),
      s("text", { x: x + 4, y: c.top + 10, style: "fill: var(--brs-accent)" }, label));
  };
  moment(pl.commander.firstContact, "first contact");
  moment(pl.commander.died, "commander died");
  const said = pl.strip.chat.some((n) => n > 0);
  const key = h("div", { class: "brs-legend" },
    swatch(color, `built${priced ? " (metal)" : " (units)"}, above`),
    swatch("#e06a5a", "lost, below"),
    said ? h("span", undefined, "● chat") : null);
  return h("div", { style: "margin-top: 14px" }, h("h3", undefined, "Built and lost"), key, c.svg);
}

/** diary: the commander's day in a few lines. */
function diary(ins: Insights, pl: PlayerReport): HTMLElement {
  const pts = pl.commander.path.map((p, i) => (p ? { hp: p[2], i } : null)).filter((p): p is { hp: number; i: number } => !!p);
  const lines: string[] = [];
  if (pl.commander.firstContact >= 0) lines.push(`First contact with the enemy at ${fmtClock(pl.commander.firstContact / SIM_FPS)}.`);
  if (pts.length) {
    const low = pts.reduce((a, b) => (b.hp < a.hp ? b : a));
    if (low.hp < 100) lines.push(`Lowest commander health ${low.hp}% around ${fmtClock(low.i * ins.stepSec)}.`);
    lines.push(pl.commander.died >= 0 ? `Commander died at ${fmtClock(pl.commander.died / SIM_FPS)}.` : "The commander survived.");
  } else {
    lines.push("No commander was seen.");
  }
  return h("div", undefined, h("h3", undefined, "Commander"), ...lines.map((l) => h("div", undefined, l)));
}

function leaks(pl: PlayerReport): HTMLElement {
  const l = pl.leaks;
  const floatRow = h("div", { class: "brs-stat" }, h("span", undefined, "Side on full metal"),
    l.floatSec > 0 ? `${fmtClock(l.floatSec)} · ${fmtMetal(l.floatMetal)} metal unused` : "never");
  tip(floatRow, "Storage overflow is shared with allies, so it only counts while the whole side is full.");
  const idleRow = h("div", { class: "brs-stat" }, h("span", undefined, "Builders idle"),
    l.notBuilding === null ? "not recorded in this replay" : `${Math.round(l.notBuilding * 100)}% of builder time`);
  tip(idleRow, "A builder with no target, standing still. Reclaiming counts as not building.");
  return h("div", { style: "margin-top: 14px" }, h("h3", undefined, "Leaks"), floatRow, idleRow);
}

interface Axis {
  label: string;
  /** What the axis measures, in full, for the tooltip. */
  info: string;
  value: (p: PlayerReport) => number | null;
  fmt: (v: number) => string;
  /** True when a smaller value ranks higher (time to T2). */
  lowFirst?: boolean;
}

// Labels stay one line (the column is narrow): the long reading is the
// tooltip's `info`.
const AXES: Axis[] = [
  { label: "Income share", info: "Share of the side's metal income", value: (p) => p.style.incomeShare, fmt: (v) => `${Math.round(v * 100)}%` },
  { label: "Time to T2", info: "When the player finished their first tech 2 factory", value: (p) => (p.style.t2 >= 0 ? p.style.t2 / SIM_FPS : null), fmt: fmtClock, lowFirst: true },
  { label: "Map covered", info: "Share of the map the player's units went to", value: (p) => p.style.areaPct, fmt: (v) => `${v.toFixed(0)}%` },
  { label: "Army forward", info: "Share of the player's army past the middle of the map", value: (p) => p.style.forwardShare, fmt: (v) => `${Math.round(v * 100)}%` },
  { label: "Assisting", info: "Share of builder time spent assisting another build", value: (p) => p.style.assistShare, fmt: (v) => `${Math.round(v * 100)}%` },
];

/** style: each axis as the player's value, a bar against the game's best, and
 * their rank among the players who have a value. */
function style(ins: Insights, pl: PlayerReport): HTMLElement {
  const rows = AXES.map((ax) => {
    const mine = ax.value(pl);
    const all = ins.players.map(ax.value).filter((v): v is number => v !== null);
    if (mine === null || all.length === 0) {
      return h("div", { class: "brs-axis" }, h("span", undefined, ax.label), h("span", { class: "brs-hint" }, "—"));
    }
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    // A rank among equals says nothing, so an axis everyone scored the same
    // on reads "all equal" over a half bar.
    const tied = hi === lo;
    const better = all.filter((v) => (ax.lowFirst ? v < mine : v > mine)).length;
    const rank = tied ? "all equal" : `${better + 1}/${all.length}`;
    const frac = tied ? 0.5 : ax.lowFirst ? (hi - mine) / (hi - lo) : (mine - lo) / (hi - lo);
    const row = h("div", { class: "brs-axis" },
      h("span", undefined, ax.label),
      h("span", { class: "brs-bar" }, h("i", { style: `width: ${Math.round(8 + 92 * frac)}%; background: ${teamColor(ins, pl.team)}` })),
      h("span", { class: "brs-val" }, `${ax.fmt(mine)} · ${rank}`));
    tip(row, { title: ax.info, rows: [{ label: "This player", value: ax.fmt(mine) }, { label: "Best in the game", value: ax.fmt(ax.lowFirst ? lo : hi) }, { label: "Rank", value: rank }] });
    return row;
  });
  return h("div", undefined, h("h3", { style: "margin-top: 14px" }, "Play style"), ...rows);
}
