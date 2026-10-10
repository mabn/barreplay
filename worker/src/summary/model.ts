// What the summary can honestly say about a replay, decided from the file
// alone. Pure, so the node tests can pin it.
import type { Insights } from "./types";

/** Used when a side carries no colour of its own. */
const FALLBACK_COLORS = ["#4b90c4", "#d0644b", "#5fae5a", "#c9a23a", "#9a6cc9", "#4bb3a8", "#c95f9a", "#8a8f96"];

/** sideColor is the side's colour, lifted toward white until it reads on the
 * summary's dark panels: BAR's team colours include pure #0000ff, which is
 * illegible as text or a line there. */
export function sideColor(ins: Insights, side: number): string {
  const c = ins.sides[side]?.color;
  return readable(c && /^#[0-9a-f]{6}$/i.test(c) ? c : FALLBACK_COLORS[side % FALLBACK_COLORS.length]);
}

/** Minimum relative luminance (WCAG) for a colour drawn on the dark panels;
 * 0.2 gives about 5:1 against #161c22. */
const MIN_LUMINANCE = 0.2;

function luminance(rgb: number[]): number {
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** readable mixes a #rrggbb colour with white, in small steps, until its
 * luminance reaches MIN_LUMINANCE. Colours already light enough are kept. */
export function readable(hex: string): string {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  let mix = rgb;
  for (let k = 0; k <= 20 && luminance(mix) < MIN_LUMINANCE; k++) {
    mix = rgb.map((v) => Math.round(v + (255 - v) * (k / 20)));
  }
  return "#" + mix.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** sideName labels a side by its first player, plus how many more there are. */
export function sideName(ins: Insights, side: number): string {
  const p = ins.sides[side]?.players ?? [];
  if (p.length === 0) return `Side ${side + 1}`;
  return p.length === 1 ? p[0] : `${p[0]} +${p.length - 1}`;
}

/** comparable is whether the sections that set one side against the other
 * may be drawn: exactly two sides, and a capture that saw both. A one-sided
 * capture's enemy half is whatever the uploader happened to see, which would
 * draw a confident chart of a game that never happened. */
export function comparable(ins: Insights): boolean {
  return ins.sides.length === 2 && ins.pov === "full";
}

/** notices are the caveats the page states up front, in reading order. */
export function notices(ins: Insights): string[] {
  const out: string[] = [];
  if (ins.pov === "ally") {
    out.push("This capture was recorded by a player, so it only saw one side of the game. The side-by-side comparison appears once the full re-simulation is published.");
  } else if (ins.pov === "unknown") {
    out.push("Nothing records whose point of view this capture is, so the side-by-side comparison is left out.");
  }
  if (ins.sides.length > 2) {
    out.push(`This game had ${ins.sides.length} sides; the comparison charts need exactly two.`);
  } else if (ins.sides.length < 2) {
    out.push("This capture names fewer than two sides, so there is nothing to compare.");
  }
  if (ins.costCoverage === "army") {
    out.push("Metal values count armed mobile units only: this replay was published before full unit costs were kept. Other losses are counted but not valued.");
  }
  return out;
}

/** sideOfTeam maps a team id to its side index, -1 when it has none. */
export function sideOfTeam(ins: Insights): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of ins.teams) m.set(t.team, t.side);
  return m;
}
