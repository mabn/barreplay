// The player report (P1, P2, P3, P8): opened by clicking a player in the
// Sides section. One strip of what the player built, lost and said; their
// commander's day on the map; where their economy leaked; and a play style
// card ranking them against everyone else in the game.
import { h, s, section } from "../dom";
import { fmtClock, fmtMetal } from "../format";
import { stepAt, timeChart } from "../chart";
import { mapView } from "../mapview";
import { readable, sideColor } from "../model";
import { stepTimes } from "../series";
import { SIM_FPS, type Insights, type PlayerReport, type SummaryOptions } from "../types";

/** reportsShown is whether player reports are offered: they compare players
 * across the game, which a one-sided capture cannot. */
export function reportsShown(ins: Insights): boolean {
  return ins.pov === "full" && Array.isArray(ins.players) && ins.players.length > 0;
}

export function playerReport(ins: Insights, pl: PlayerReport, opts: SummaryOptions): HTMLElement {
  const color = sideColor(ins, pl.side);
  const head = h("h2", { style: `color: ${color}` }, pl.player || `Team ${pl.team}`);
  return section("Player report", head, strip(ins, pl, opts),
    h("div", { class: "brs-reportgrid" }, diary(ins, pl, opts), h("div", undefined, leaks(pl), style(ins, pl))));
}

/** strip: built above the axis, lost below, chat as ticks, and the two
 * moments of the commander's day as lines. */
function strip(ins: Insights, pl: PlayerReport, opts: SummaryOptions): SVGSVGElement {
  const priced = ins.costCoverage === "full";
  const built = priced ? pl.strip.builtMetal : pl.strip.builtN;
  const lost = priced ? pl.strip.lostMetal : pl.strip.lostN;
  const top = Math.max(1, ...built, ...lost);
  const t = stepTimes(ins);
  const fmt = (v: number) => (priced ? fmtMetal(v) : String(Math.round(v)));
  const c = timeChart({
    height: 190, durationSec: ins.durationSec, yMin: -top, yMax: top, zeroLine: true,
    yTick: (v) => fmt(Math.abs(v)), onSeek: opts.onSeek,
    readout: (tt) => {
      const i = stepAt(t, tt);
      return i < 0 ? "" : `built ${fmt(built[i] ?? 0)}, lost ${fmt(lost[i] ?? 0)}${priced ? " metal" : " units"}`;
    },
  });
  const color = sideColor(ins, pl.side);
  const w = ((c.right - c.left) / Math.max(1, t.length)) * 0.8;
  t.forEach((tt, i) => {
    const x = c.x(tt - ins.stepSec / 2) - w / 2;
    if (built[i]) c.plot.append(s("rect", { x, y: c.y(built[i]), width: w, height: c.y(0) - c.y(built[i]), fill: color, "fill-opacity": 0.7 }));
    if (lost[i]) c.plot.append(s("rect", { x, y: c.y(0), width: w, height: c.y(-lost[i]) - c.y(0), fill: "#e06a5a", "fill-opacity": 0.7 }));
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
  // Labels at the right end, where a game's last minutes are usually quiet
  // and the chat dots along the bottom start at the left.
  const said = pl.strip.chat.some((n) => n > 0);
  c.svg.append(
    s("text", { x: c.right - 6, y: c.top + 24, "text-anchor": "end" }, `▲ built${priced ? "" : " (units)"}`),
    s("text", { x: c.right - 6, y: c.bottom - 12, "text-anchor": "end" }, said ? "▼ lost · ● chat" : "▼ lost"));
  return c.svg;
}

/** diary: the commander's path, coloured by its health, over the map. */
function diary(ins: Insights, pl: PlayerReport, opts: SummaryOptions): HTMLElement {
  const path = pl.commander.path;
  const pts = path.map((p, i) => (p ? { x: p[0], z: p[1], hp: p[2], i } : null)).filter((p): p is { x: number; z: number; hp: number; i: number } => !!p);
  const lines: string[] = [];
  if (pl.commander.firstContact >= 0) lines.push(`First contact with the enemy at ${fmtClock(pl.commander.firstContact / SIM_FPS)}.`);
  if (pts.length) {
    const low = pts.reduce((a, b) => (b.hp < a.hp ? b : a));
    if (low.hp < 100) lines.push(`Lowest commander health ${low.hp}% around ${fmtClock(low.i * ins.stepSec)}.`);
    lines.push(pl.commander.died >= 0 ? `Commander died at ${fmtClock(pl.commander.died / SIM_FPS)}.` : "The commander survived.");
  } else {
    lines.push("No commander was seen.");
  }
  const segs: { el: SVGElement }[] = [];
  const view = mapView(ins, opts.mapApi, (v) => { for (const sg of segs) sg.el.setAttribute("stroke-width", String(0.008 * v.width)); });
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    if (b.i !== a.i + 1) continue; // a gap: it was not seen in between
    const el = s("line", { x1: a.x, y1: a.z, x2: b.x, y2: b.z, stroke: healthColor(b.hp), "stroke-width": 0.008 * view.width, "stroke-linecap": "round" });
    segs.push({ el });
    view.layer.append(el);
  }
  const last = pts[pts.length - 1];
  if (last && pl.commander.died >= 0) {
    const r = 0.02 * view.width;
    view.layer.append(s("path", { d: `M${last.x - r},${last.z - r}L${last.x + r},${last.z + r}M${last.x + r},${last.z - r}L${last.x - r},${last.z + r}`, stroke: "#e06a5a", "stroke-width": 0.008 * view.width }));
  }
  return h("div", undefined, h("h3", undefined, "Commander diary"), h("div", { class: "brs-mapwrap brs-small" }, view.svg),
    ...lines.map((l) => h("div", { class: "brs-hint" }, l)));
}

function healthColor(hp: number): string {
  const t = Math.max(0, Math.min(100, hp)) / 100;
  const r = Math.round(224 - 130 * t);
  const g = Math.round(90 + 110 * t);
  return readable(`#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}5a`);
}

function leaks(pl: PlayerReport): HTMLElement {
  const l = pl.leaks;
  const rows = [
    h("div", { class: "brs-stat" }, h("span", undefined, "Side on full metal storage"),
      l.floatSec > 0 ? `${fmtClock(l.floatSec)} · ${fmtMetal(l.floatMetal)} metal unused` : "never"),
    h("div", { class: "brs-stat" }, h("span", undefined, "Builders not building"),
      l.notBuilding === null ? "not recorded in this replay" : `${Math.round(l.notBuilding * 100)}% of builder time`),
  ];
  return h("div", undefined, h("h3", undefined, "Leaks"), ...rows,
    h("p", { class: "brs-hint" }, "Storage overflow is shared with allies, so it only counts while the whole side is full. \"Not building\" is a builder with no target standing still, which includes reclaiming."));
}

interface Axis {
  label: string;
  value: (p: PlayerReport) => number | null;
  fmt: (v: number) => string;
  /** True when a smaller value ranks higher (time to T2). */
  lowFirst?: boolean;
}

const AXES: Axis[] = [
  { label: "Share of side income", value: (p) => p.style.incomeShare, fmt: (v) => `${Math.round(v * 100)}%` },
  { label: "Time to T2", value: (p) => (p.style.t2 >= 0 ? p.style.t2 / SIM_FPS : null), fmt: fmtClock, lowFirst: true },
  { label: "Map covered", value: (p) => p.style.areaPct, fmt: (v) => `${v.toFixed(0)}%` },
  { label: "Army past the middle", value: (p) => p.style.forwardShare, fmt: (v) => `${Math.round(v * 100)}%` },
  { label: "Builder time assisting", value: (p) => p.style.assistShare, fmt: (v) => `${Math.round(v * 100)}%` },
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
    return h("div", { class: "brs-axis" },
      h("span", undefined, ax.label),
      h("span", { class: "brs-bar" }, h("i", { style: `width: ${Math.round(8 + 92 * frac)}%; background: ${sideColor(ins, pl.side)}` })),
      h("span", { class: "brs-val" }, `${ax.fmt(mine)} · ${rank}`));
  });
  return h("div", undefined, h("h3", { style: "margin-top: 14px" }, "Play style"), ...rows);
}

