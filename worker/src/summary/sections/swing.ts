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
import { eliminationFocus, momentStories } from "../moments";
import { fighterNames, named } from "../names";
import { fillUnits, inkOn } from "../unitchips";
import { stepTimes } from "../series";
import { tip } from "../tooltip";
import { clipAround, clipAt, clipEvent, clipSpan, watchNote, type Watch } from "../watch";
import { SIM_FPS, type Insights, type SummaryOptions } from "../types";

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

  // Each swing's minute, shaded in the colour of the side it moved toward:
  // the numbered dot marks where the line ARRIVED, and without the band the
  // drop leading up to it reads as something that happened before the swing.
  const spans = s("g", { "pointer-events": "none" });
  for (const m of sw.moments) {
    const x0 = c.x(m.f0 / SIM_FPS);
    const x1 = c.x(m.f1 / SIM_FPS);
    spans.append(s("rect", { x: x0, y: c.top, width: Math.max(1, x1 - x0), height: c.bottom - c.top, fill: sideColor(ins, m.side), "fill-opacity": 0.12 }));
  }
  c.plot.prepend(spans);

  // Eliminations: a cross on the edge of the losing side's half.
  const marks = s("g");
  for (const k of knockouts(ins)) {
    if (k.side !== 0 && k.side !== 1) continue;
    const x = c.x(k.f / SIM_FPS);
    const y = k.side === 0 ? c.top + 8 : c.bottom - 6;
    const m = s("text", { x, y, "text-anchor": "middle", class: "brs-ko" + (watch ? " brs-clickable" : ""), style: `fill: ${sideColor(ins, k.side)}` }, "✕");
    tip(m, { title: named(ins, `${k.name} is eliminated`), rows: [{ color: sideColor(ins, k.side), label: fmtClock(k.f / SIM_FPS) }], note: watchNote(watch) });
    if (watch) m.addEventListener("click", () => {
      const at = eliminationFocus(ins, k.team, k.f);
      watch(clipAround(k.f, { x: at.x, z: at.z, r: at.r, title: `${k.name} is eliminated` }));
    });
    marks.append(m);
  }

  const stories = momentStories(ins, sw.moments);
  // A moment's clip opens just before the thing that made it — the
  // commander dying, the fight peaking — zoomed to where it happened, rather
  // than at the start of the minute the line took to move.
  const clipOf = (k: number) => {
    const m = sw.moments[k];
    const st = stories[k];
    const b = ins.battles[st.battle];
    const title = `${m.n}. ${st.title}`;
    const f = st.focus;
    // An event with a span (a raid, a fight) is marked as that span and runs
    // to its END, however long; a single instant runs on to the end of the
    // swing.
    if (f && f.f1 !== undefined && f.f1 > f.f) return clipEvent(f.f, f.f1, { x: f.x, z: f.z, r: f.r, title });
    if (f && typeof f.x === "number") return clipAt(f.f, m.f1, { x: f.x, z: f.z, r: f.r, title });
    const where = b ? { x: b.x, z: b.z, r: b.r } : {};
    return f ? clipAt(f.f, m.f1, { ...where, title }) : clipSpan(m.f0, m.f1, { ...where, title });
  };
  sw.moments.forEach((m, k) => {
    const tt = m.f1 / SIM_FPS;
    const i = stepAt(t, tt);
    const y = c.y(i < 0 ? 0 : d[i]);
    const g = s("g", { class: watch ? "brs-swingdot" : null },
      s("circle", { cx: c.x(tt), cy: y, r: 10, fill: sideColor(ins, m.side), stroke: "var(--brs-bg)", "stroke-width": 2 }),
      s("text", { x: c.x(tt), y: y + 4, "text-anchor": "middle", style: "fill: #000; font-weight: 600; pointer-events: none" }, String(m.n)),
    );
    tip(g, {
      title: named(ins, `${m.n}. ${stories[k].title}`),
      rows: [{ color: sideColor(ins, m.side), label: `${fmtClock(m.f0 / SIM_FPS)}–${fmtClock(m.f1 / SIM_FPS)}`, value: `${sideName(ins, m.side)} +${pct(m.delta)}` }],
      note: stories[k].detail + (watch ? " Click to watch." : ""),
    });
    if (watch) g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      watch(clipOf(k));
    });
    marks.append(g);
  });
  c.svg.append(marks);

  // When it happened: the event's own span when the story found one, else
  // the instant, else the minute the line took to move.
  const when = (k: number) => {
    const f = stories[k].focus;
    const m = sw.moments[k];
    if (!f) return `${fmtClock(m.f0 / SIM_FPS)}–${fmtClock(m.f1 / SIM_FPS)}`;
    const end = f.f1 ?? f.f;
    return end - f.f >= SIM_FPS ? `${fmtClock(f.f / SIM_FPS)}–${fmtClock(end / SIM_FPS)}` : fmtClock(f.f / SIM_FPS);
  };
  // One row a swing, laid out like a battle's detail: the two sides side by
  // side (the first on the left), each with who fought for it and what it
  // lost as icons with counts, the side the line moved toward boxed with
  // the shift. The whole row plays the swing.
  const priced = ins.costCoverage === "full" || stories.some((st) => st.lost.some((l) => l.metal > 0));
  const rows = sw.moments.map((m, k) => {
    const st = stories[k];
    const play = () => watch?.(clipOf(k));
    const col = (sd: number) => {
      const l = st.shown[sd];
      const gained = sd === m.side;
      const head = h("div", { class: "brs-losshead" }, fighterNames(ins, st.fighters[sd] ?? [], sd));
      if (gained) {
        const bg = sideColor(ins, sd);
        const mark = h("span", { class: "brs-ahead", style: `background: ${bg}; color: ${inkOn(bg)}` }, `▲ +${pct(m.delta)}`);
        tip(mark, { title: `${sideName(ins, sd)}'s chance to win rose ${pct(m.delta)}` });
        head.append(mark);
      }
      const units = h("span", { class: "brs-units" });
      if (l?.units.length) void fillUnits(units, ins, opts, l.units, priced, SWING_CHIPS);
      const away = st.elsewhere?.[sd] ? ` (+${fmtMetal(st.elsewhere[sd])} elsewhere)` : "";
      const count = !l?.n ? "lost nothing" : `${l.n} lost` + (priced && l.metal ? ` · ${fmtMetal(l.metal)} metal` : "") + away;
      return h("div", { class: "brs-losscol" + (gained ? " brs-won" : ""), style: `--brs-side: ${sideColor(ins, sd)}` },
        head, h("div", { class: "brs-swloss" }, h("span", { class: "brs-muted" }, count), units));
    };
    const btn = watch ? h("button", { class: "brs-play", type: "button", "aria-label": `Watch swing ${m.n}` }, "▶") : null;
    const part = st.whole ? ` · part of a fight ${fmtClock(st.whole.f0 / SIM_FPS)}–${fmtClock(st.whole.f1 / SIM_FPS)}` : "";
    const row = h("div", { class: "brs-moment" + (watch ? " brs-rowplay" : ""), ...(watch ? { tabindex: "0", role: "button", "aria-label": `Watch swing ${m.n}` } : {}) },
      h("span", { class: "brs-num", style: `background: ${sideColor(ins, m.side)}` }, String(m.n)),
      h("div", { class: "brs-grow" },
        h("div", undefined, h("b", undefined, named(ins, st.title)), " ",
          h("span", { class: "brs-muted" }, `· ${when(k)}${part}`)),
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
    key: mirrorKey(ins, knockouts(ins).length ? h("span", undefined, "✕ a player eliminated") : null),
    hint: h("p", { class: "brs-hint" },
      `The chance each side wins, read from army value and metal income (a model ${model}; it is never told the result). The army value and income charts below share its time axis.`),
    svg: c.svg,
    list: rows.length ? h("div", undefined, ...rows) : null,
  };
}
