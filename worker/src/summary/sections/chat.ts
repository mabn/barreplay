// The conversation (G9): when people talked, on a strip under the game's
// timeline, then the lines themselves. Hidden when the replay recorded none.
import { h, s, section } from "../dom";
import { fmtClock } from "../format";
import { timeChart } from "../chart";
import { sideColor } from "../model";
import { clipAround, watcher } from "../watch";
import { SIM_FPS, type Insights, type SummaryOptions } from "../types";

const SPECTATOR = "#8a8f96";
const DEST_LABELS: Record<string, string> = { ally: "allies", spec: "spectators", private: "private", lobby: "lobby" };

export function chat(ins: Insights, opts: SummaryOptions): HTMLElement | null {
  const pings = ins.marks.reduce((n, row) => n + row.reduce((a, b) => a + b, 0), 0);
  if (ins.chat.length === 0 && pings === 0) return null;
  const colorOf = (side: number) => (side >= 0 ? sideColor(ins, side) : SPECTATOR);
  const rows = Math.max(1, ins.sides.length);
  const rowH = 18;
  const height = rows * rowH + 40;
  const watch = watcher(opts);
  const c = timeChart({
    height, durationSec: ins.durationSec, yMin: 0, yMax: 1, yTick: null, watch,
    readout: (tt) => {
      const i = Math.floor(tt / ins.stepSec);
      const rows = ins.marks.map((row, side) => ({ color: colorOf(side), label: "Map pings", value: String(row[i] ?? 0) })).filter((r) => r.value !== "0");
      const near = ins.chat.filter((l) => Math.abs(l.f / SIM_FPS - tt) <= ins.stepSec / 2).slice(0, 4);
      return [...rows, ...near.map((l) => ({ color: colorOf(l.side), label: l.name || "?", value: l.text.length > 40 ? l.text.slice(0, 40) + "…" : l.text }))];
    },
  });
  // Pings: one bar per step per side, its height the count.
  const maxPing = Math.max(1, ...ins.marks.flat());
  ins.marks.forEach((row, side) => {
    const base = c.top + (side + 1) * rowH;
    row.forEach((n, i) => {
      if (!n) return;
      const x0 = c.x(i * ins.stepSec);
      const x1 = c.x((i + 1) * ins.stepSec);
      const hgt = (n / maxPing) * (rowH - 4);
      c.plot.append(s("rect", { x: x0, y: base - hgt, width: Math.max(1, x1 - x0 - 1), height: hgt, fill: colorOf(side), "fill-opacity": 0.45 }));
    });
  });
  // Chat: a tick per line along the bottom row.
  const yChat = c.top + rows * rowH + 6;
  for (const line of ins.chat) {
    const x = c.x(line.f / SIM_FPS);
    c.plot.append(s("line", { x1: x, x2: x, y1: yChat, y2: yChat + 8, stroke: colorOf(line.side), "stroke-width": 2 }));
  }

  const list = h("div", { class: "brs-chat" });
  for (const line of ins.chat) {
    const when = h("span", { class: "brs-when" + (watch ? " brs-seek" : "") }, fmtClock(line.f / SIM_FPS));
    if (watch) when.addEventListener("click", () => watch(clipAround(line.f, { title: `${line.name || "?"}: ${line.text}` })));
    const dest = line.dest && line.dest !== "all" ? `(${DEST_LABELS[line.dest] ?? line.dest}) ` : "";
    list.append(h("div", { class: "brs-line" },
      when, " ",
      h("b", { style: `color: ${colorOf(line.side)}` }, line.name || "?"), ": ",
      h("span", { class: "brs-dest" }, dest), line.text));
  }
  return section("Conversation",
    h("p", { class: "brs-hint" }, `${ins.chat.length} messages, ${pings} map pings. Bars show pings by side; ticks show messages.`),
    c.svg,
    ins.chat.length ? list : null);
}
