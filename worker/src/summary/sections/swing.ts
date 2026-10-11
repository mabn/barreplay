// The swing chart (G1): who the numbers said was winning, as a probability,
// with the biggest shifts numbered and listed underneath. The line is the
// insights file's (internal/insights swing.go): a logistic model over army
// value and metal income, which never sees who won, so the result is drawn
// beside it rather than through it. Eliminations are marked on its edges —
// a player leaving takes an army off the board, which moves the line.
import { h, s } from "../dom";
import { fmtClock, fmtMetal } from "../format";
import { bandPath, linePath, stepAt, timeChart, type ChartGroup } from "../chart";
import { mirrorKey } from "../legend";
import { knockouts } from "../losses";
import { sideColor, sideName } from "../model";
import { compass, eliminationFocus, fighters, gapBattles, momentStories, type Fighter, type GapBattle, type MomentStory } from "../moments";
import { fighterNames, named } from "../names";
import { fillUnits, inkOn } from "../unitchips";
import { stepTimes } from "../series";
import { tip } from "../tooltip";
import { clipAround, clipAt, clipEvent, clipSpan, watchNote, type Watch } from "../watch";
import { SIM_FPS, type Clip, type Insights, type Moment, type SummaryOptions, type UnitLoss } from "../types";

/** pct formats a probability as a whole percent. */
export function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** SWING_CHIPS is how many kinds of unit a swing row shows per side before
 * "+N more": a row is one line of a list, not a battle's full detail. */
const SWING_CHIPS = 6;

export interface SwingParts {
  key: HTMLElement;
  hint: HTMLElement;
  svg: SVGSVGElement;
  /** The numbered moments, or null when there are none. */
  list: HTMLElement | null;
}

/** swingChart draws the chart and the moments list, or null when the file
 * carries no swing line (version 1, a one-sided capture, an FFA). */
export function swingChart(ins: Insights, opts: SummaryOptions, watch: Watch | null, group: ChartGroup): SwingParts | null {
  const sw = ins.swing;
  if (!sw || sw.p.length < 2 || ins.sides.length !== 2) return null;
  const t = stepTimes(ins);
  const d = sw.p.map((p) => p - 0.5);
  const c = timeChart({
    height: 200, durationSec: ins.durationSec, yMin: -0.5, yMax: 0.5, zeroLine: true, xAxis: false,
    yTick: (v) => pct(0.5 + Math.abs(v)),
    watch, group,
    readout: (tt) => {
      const i = stepAt(t, tt);
      if (i < 0) return null;
      const p = sw.p[i];
      return [
        { color: sideColor(ins, 0), label: sideName(ins, 0), metric: "Chance to win", value: pct(p) },
        { color: sideColor(ins, 1), label: sideName(ins, 1), metric: "Chance to win", value: pct(1 - p) },
      ];
    },
  });
  const zero = t.map(() => 0);
  c.plot.append(
    s("path", { d: bandPath(c, t, zero, d.map((v) => Math.max(0, v))), fill: sideColor(ins, 0), "fill-opacity": 0.35 }),
    s("path", { d: bandPath(c, t, d.map((v) => Math.min(0, v)), zero), fill: sideColor(ins, 1), "fill-opacity": 0.35 }),
    s("path", { d: linePath(c, t, d), fill: "none", stroke: "var(--brs-text)", "stroke-width": 1.5 }),
  );

  // Eliminations: a cross on the edge of the losing side's half.
  const marks = s("g");
  for (const k of knockouts(ins)) {
    if (k.side !== 0 && k.side !== 1) continue;
    const x = c.x(k.f / SIM_FPS);
    const y = k.side === 0 ? c.top + 8 : c.bottom - 6;
    const m = s("text", { x, y, "text-anchor": "middle", class: "brs-ko" + (watch ? " brs-clickable" : ""), style: `fill: ${sideColor(ins, k.side)}` }, "✕");
    tip(m, { title: named(ins, k.label), rows: [{ color: sideColor(ins, k.side), label: fmtClock(k.f / SIM_FPS) }], note: watchNote(watch) });
    if (watch) m.addEventListener("click", () => {
      const at = eliminationFocus(ins, k.team, k.f);
      watch(clipAround(k.f, { x: at.x, z: at.z, r: at.r, title: k.label }));
    });
    marks.append(m);
  }

  const stories = momentStories(ins, sw.moments);
  const priced = ins.costCoverage === "full" || stories.some((st) => st.lost.some((l) => l.metal > 0));
  const entries = listEntries(ins, sw.moments, stories, gapBattles(ins, sw.moments, stories));

  // Each entry's span, shaded in the colour of the side it moved toward:
  // the lettered dot marks where the line ARRIVED, and without the band the
  // drop leading up to it reads as something that happened before it.
  const spans = s("g", { "pointer-events": "none" });
  for (const e of entries) {
    const x0 = c.x(e.span[0] / SIM_FPS);
    const x1 = c.x(e.span[1] / SIM_FPS);
    spans.append(s("rect", { x: x0, y: c.top, width: Math.max(1, x1 - x0), height: c.bottom - c.top, fill: e.color, "fill-opacity": 0.12 }));
  }
  c.plot.prepend(spans);

  for (const e of entries) {
    const tt = e.at / SIM_FPS;
    const i = stepAt(t, tt);
    const y = c.y(i < 0 ? 0 : d[i]);
    const g = s("g", { class: watch ? "brs-swingdot" : null },
      s("circle", { cx: c.x(tt), cy: y, r: 10, fill: e.color, stroke: "var(--brs-bg)", "stroke-width": 2 }),
      s("text", { x: c.x(tt), y: y + 4, "text-anchor": "middle", style: "fill: #000; font-weight: 600; pointer-events: none" }, e.letter),
    );
    tip(g, { title: named(ins, `${e.letter}. ${e.text}`), rows: e.rows, note: e.detail + (watch ? " Click to watch." : "") });
    if (watch) g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      watch(e.clip());
    });
    marks.append(g);
  }
  c.svg.append(marks);

  // One row an entry, laid out like a battle's detail: the two sides side
  // by side (the first on the left), each with who fought for it and what
  // it lost as icons with counts, the side the line moved toward boxed with
  // the shift. The whole row plays the entry.
  const rows = entries.map((e) => {
    const play = () => watch?.(e.clip());
    const col = (sd: number) => {
      const l = e.shown[sd];
      const gained = sd === e.side;
      const head = h("div", { class: "brs-losshead" }, fighterNames(ins, e.fighters[sd] ?? [], sd));
      if (gained && e.chip) {
        const bg = sideColor(ins, sd);
        const mark = h("span", { class: "brs-ahead", style: `background: ${bg}; color: ${inkOn(bg)}` }, e.chip);
        tip(mark, { title: e.chipTip });
        head.append(mark);
      }
      const units = h("span", { class: "brs-units" });
      if (l?.units.length) void fillUnits(units, ins, opts, l.units, priced, SWING_CHIPS);
      const away = e.elsewhere?.[sd] ? ` (+${fmtMetal(e.elsewhere[sd])} elsewhere)` : "";
      // A swing on economy says what each side's income did, not that
      // nobody lost anything.
      const inc = e.income?.[sd];
      const rate = (v: number) => `${fmtMetal(Math.round(v * 10) / 10)}/s`;
      const count = inc && !l?.n ? `income ${rate(inc[0])} → ${rate(inc[1])}`
        : !l?.n ? "" : `${l.n} lost` + (priced && l.metal ? ` · ${fmtMetal(l.metal)} metal` : "") + away;
      return h("div", { class: "brs-losscol" + (gained ? " brs-won" : ""), style: `--brs-side: ${sideColor(ins, sd)}` },
        head, h("div", { class: "brs-swloss" }, h("span", { class: "brs-muted" }, count), units));
    };
    const btn = watch ? h("button", { class: "brs-play", type: "button", "aria-label": `Watch ${e.letter}` }, "▶") : null;
    const title = h("b", undefined, named(ins, e.title));
    if (e.battle >= 0) title.append(" ", battleBadge(e.battle));
    const row = h("div", { class: "brs-moment" + (watch ? " brs-rowplay" : ""), ...(watch ? { tabindex: "0", role: "button", "aria-label": `Watch ${e.letter}` } : {}) },
      h("span", { class: "brs-num", style: `background: ${e.color}` }, e.letter),
      h("div", { class: "brs-grow" },
        h("div", undefined, title, " ", h("span", { class: "brs-muted" }, `· ${e.when}${e.part}`)),
        h("div", { class: "brs-swcols" }, col(0), col(1))),
      btn);
    if (watch) {
      row.addEventListener("click", (ev) => {
        // A player's name or another control inside the row does its own thing.
        const hit = (ev.target as Element).closest("button, a, .brs-playerbtn");
        if (hit && !hit.classList.contains("brs-play")) return;
        play();
      });
      row.addEventListener("keydown", (ev) => {
        if (ev.target === row && (ev.key === "Enter" || ev.key === " ")) {
          ev.preventDefault();
          play();
        }
      });
    }
    return row;
  });
  const model = sw.fitted
    ? `fitted to ${sw.games ?? "past"} games`
    : "with hand-set weights, not yet fitted to real games";
  return {
    key: mirrorKey(ins, knockouts(ins).length ? h("span", undefined, "✕ a player out") : null),
    hint: h("p", { class: "brs-hint" },
      `The chance each side wins, read from army value and metal income (a model ${model}; it is never told the result). The army value and income charts below share its time axis.`),
    svg: c.svg,
    list: rows.length ? h("div", undefined, ...rows) : null,
  };
}

/** battleBadge is a battle's number as the battles list draws it: the
 * number in a white circle. */
function battleBadge(i: number): HTMLElement {
  const el = h("span", { class: "brs-num brs-numlight brs-inline" }, String(i + 1));
  tip(el, { title: `Battle ${i + 1}, on the Battles map` });
  return el;
}

/** One line of the swing list: a swing of the line, or a battle told to
 * fill a stretch with none (moments.ts gapBattles). */
interface Entry {
  letter: string;
  /** Where its dot sits (the end of what it tells), sim frame. */
  at: number;
  span: [number, number];
  /** The side boxed in its row (-1 for none) and the dot's colour. */
  side: number;
  color: string;
  /** The title as drawn (names coloured by named()); a battle the entry
   * tells is drawn after it as its badge. */
  title: string;
  /** The title as one string, the battle as "(n)": tooltips and clips. */
  text: string;
  battle: number;
  when: string;
  part: string;
  chip: string | null;
  chipTip: string;
  rows: { color: string; label: string; value?: string }[];
  detail: string;
  shown: ({ n: number; metal: number; units: UnitLoss[] } | undefined)[];
  elsewhere: number[] | null;
  fighters: Fighter[][];
  /** What each side's metal income went from and to, for a swing the line
   * made on economy rather than a fight; null otherwise. */
  income: [number, number][] | null;
  clip: () => Clip;
}

const span = (f0: number, f1: number) => (f1 - f0 >= SIM_FPS ? `${fmtClock(f0 / SIM_FPS)}–${fmtClock(f1 / SIM_FPS)}` : fmtClock(f0 / SIM_FPS));

/** listEntries puts the swings and the gap battles in one time order and
 * letters them A, B, C… — letters, because the battles they mention are
 * numbered, as on the Battles map. */
function listEntries(ins: Insights, moments: Moment[], stories: MomentStory[], gaps: GapBattle[]): Entry[] {
  const out: Omit<Entry, "letter" | "text" | "clip">[] = [];
  const clips: ((title: string) => Clip)[] = [];
  moments.forEach((m, k) => {
    const st = stories[k];
    const f = st.focus;
    // A fight told as one battle names it.
    const battle = st.shown !== st.lost && st.battle >= 0 ? st.battle : -1;
    out.push({
      at: m.f1, span: [m.f0, m.f1], side: m.side, color: sideColor(ins, m.side), title: st.title, battle,
      // When it happened: the event's own span when the story found one,
      // else the instant, else the minute the line took to move.
      when: f ? span(f.f, f.f1 ?? f.f) : span(m.f0, m.f1),
      part: st.whole ? ` · part of a fight ${fmtClock(st.whole.f0 / SIM_FPS)}–${fmtClock(st.whole.f1 / SIM_FPS)}` : "",
      chip: `▲ +${pct(m.delta)}`, chipTip: `${sideName(ins, m.side)}'s chance to win rose ${pct(m.delta)}`,
      rows: [{ color: sideColor(ins, m.side), label: `${fmtClock(m.f0 / SIM_FPS)}–${fmtClock(m.f1 / SIM_FPS)}`, value: `${sideName(ins, m.side)} +${pct(m.delta)}` }],
      detail: st.detail, shown: st.shown, elsewhere: st.elsewhere, fighters: st.fighters,
      income: st.growth ? st.growth.map((g) => g.income) : null,
    });
    // A moment's clip opens just before the thing that made it — the
    // commander dying, the fight peaking — zoomed to where it happened,
    // rather than at the start of the minute the line took to move.
    clips.push((title) => {
      const b = ins.battles[st.battle];
      // An event with a span (a raid, a fight) is marked as that span and
      // runs to its END, however long; a single instant runs on to the end
      // of the swing.
      if (f && f.f1 !== undefined && f.f1 > f.f) return clipEvent(f.f, f.f1, { x: f.x, z: f.z, r: f.r, title });
      if (f && typeof f.x === "number") return clipAt(f.f, m.f1, { x: f.x, z: f.z, r: f.r, title });
      const where = b ? { x: b.x, z: b.z, r: b.r } : {};
      return f ? clipAt(f.f, m.f1, { ...where, title }) : clipSpan(m.f0, m.f1, { ...where, title });
    });
  });
  for (const gb of gaps) {
    const b = ins.battles[gb.battle];
    const W = gb.side >= 0 ? sideName(ins, gb.side) : "";
    const title = gb.verdict === "blast" ? gb.blast! : gb.verdict === "even" ? "Even trade in battle" : `${W} ${gb.verdict === "decisive" ? "decisively wins" : "wins"} battle`;
    const moved = gb.side >= 0 && Math.round(gb.delta * 100) >= 1;
    const priced = ins.costCoverage === "full" || b.lost.some((l) => l.metal > 0);
    const lostText = (sd: number) => {
      const l = b.lost[sd];
      return !l?.n ? "nothing" : priced && l.metal ? `${fmtMetal(l.metal)} metal` : `${l.n} units`;
    };
    out.push({
      at: b.f1, span: [b.f0, b.f1], side: gb.side, color: gb.side >= 0 ? sideColor(ins, gb.side) : "var(--brs-text)", title, battle: gb.battle,
      when: span(b.f0, b.f1), part: "",
      chip: gb.side < 0 ? null : moved ? `▲ +${pct(gb.delta)}` : "▲ ahead",
      chipTip: moved ? `${W}'s chance to win rose ${pct(gb.delta)} over it` : `${W} lost less here`,
      rows: [0, 1].map((sd) => ({ color: sideColor(ins, sd), label: `${sideName(ins, sd)} lost`, value: lostText(sd) })),
      detail: `Battle ${gb.battle + 1}, ${span(b.f0, b.f1)} in ${compass(ins, b.x, b.z)}.`,
      shown: b.lost.map((l) => ({ n: l.n, metal: l.metal, units: l.units ?? l.top.map((def) => ({ def, n: 0, metal: 0 })) })),
      elsewhere: null, fighters: fighters(ins, b), income: null,
    });
    clips.push((t) => clipEvent(b.f0, b.f1, { x: b.x, z: b.z, r: Math.max(b.r, 800), title: t }));
  }
  const order = out.map((_, i) => i).sort((a, b) => out[a].at - out[b].at);
  return order.map((i, k) => {
    const letter = k < 26 ? String.fromCharCode(65 + k) : String(k + 1);
    const e = out[i];
    const text = e.battle >= 0 ? `${e.title} (${e.battle + 1})` : e.title;
    return { ...e, letter, text, clip: () => clips[i](`${letter}. ${text}`) };
  });
}
