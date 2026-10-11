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

/** teamColor is a team's own colour (the player's in-game colour), made
 * readable, falling back to its side's. */
export function teamColor(ins: Insights, team: number): string {
  const t = ins.teams.find((x) => x.team === team);
  const c = t?.color;
  return c && /^#[0-9a-f]{6}$/i.test(c) ? readable(c) : sideColor(ins, t?.side ?? 0);
}

/** playerColor is a player's in-game colour by name, or null for a name no
 * team carries (a spectator, the autohost). */
export function playerColor(ins: Insights, name: string): string | null {
  const t = ins.teams.find((x) => x.player === name);
  return t ? teamColor(ins, t.team) : null;
}

/** A piece of text, coloured when it is a player's name. */
export interface Run {
  text: string;
  color?: string;
}

/** nameRuns splits text into runs, giving every player name in it that
 * player's in-game colour, so a name reads the same wherever it is written.
 * A name counts only as a whole word: "Pawn" inside "Pawns" is not a
 * player called Pawn. Longer names win over names they contain. Side
 * names ("Blue team", and "Blue" on its own) get their side's colour the
 * same way. */
export function nameRuns(ins: Insights, text: string): Run[] {
  const names = [
    ...ins.teams.filter((t) => t.player).map((t) => ({ name: t.player as string, color: teamColor(ins, t.team) })),
    ...ins.sides.map((_, i) => ({ name: sideName(ins, i), color: sideColor(ins, i) })),
    // A side's units are named by its colour alone ("Blue Juggernauts").
    ...ins.sides.map((_, i) => ({ name: sideName(ins, i).replace(/ team$/, ""), color: sideColor(ins, i) })),
  ].sort((a, b) => b.name.length - a.name.length);
  const word = /[\p{L}\p{N}_]/u;
  const out: Run[] = [];
  let plain = "";
  let i = 0;
  outer: while (i < text.length) {
    if (i === 0 || !word.test(text[i - 1])) {
      for (const n of names) {
        const end = i + n.name.length;
        if (text.startsWith(n.name, i) && (end >= text.length || !word.test(text[end]))) {
          if (plain) out.push({ text: plain });
          plain = "";
          out.push({ text: n.name, color: n.color });
          i = end;
          continue outer;
        }
      }
    }
    plain += text[i++];
  }
  if (plain) out.push({ text: plain });
  return out;
}

/** colorName is the plain English name of a #rrggbb colour's hue ("Blue",
 * "Red"), the way players call a side by its colour. */
export function colorName(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (sat < 0.2 || d < 0.08) return l > 0.75 ? "White" : l < 0.2 ? "Black" : "Grey";
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) return "Red";
  if (hue < 40) return "Orange";
  if (hue < 70) return "Yellow";
  if (hue < 160) return "Green";
  if (hue < 195) return "Cyan";
  if (hue < 260) return "Blue";
  if (hue < 295) return "Purple";
  return "Pink";
}

/** sideName labels a side by its leader's colour — "Blue team" — which is
 * what players call it, and what its colour on the page already says. A
 * side with no colour, or one sharing its colour's name with another side,
 * is "Team N" instead, so two sides are never called the same. */
export function sideName(ins: Insights, side: number): string {
  const named = (i: number) => {
    const c = ins.sides[i]?.color;
    return c && /^#[0-9a-f]{6}$/i.test(c) ? colorName(c) : null;
  };
  const mine = named(side);
  if (!mine || ins.sides.some((_, i) => i !== side && named(i) === mine)) return `Team ${side + 1}`;
  return `${mine} team`;
}

/** sideShort names a side's units: "Blue" in "Blue Juggernauts". */
export function sideShort(ins: Insights, side: number): string {
  return sideName(ins, side).replace(/ team$/, "");
}

/** comparable is whether the sections that set one side against the other
 * may be drawn: exactly two sides, and a capture that saw both. A one-sided
 * capture's enemy half is whatever the uploader happened to see, which would
 * draw a confident chart of a game that never happened. */
export function comparable(ins: Insights): boolean {
  return ins.sides.length === 2 && ins.pov === "full";
}

/** What each insights version added, for the outdated-report notice. */
const VERSION_FEATURES: [number, string][] = [
  [2, "swing line"],
  [3, "eliminations"],
  [4, "reclaims left out of losses"],
  [5, "self-destructs"],
  [6, "fitted win odds"],
  [7, "game end at the resign, story battles, friendly fire"],
  [8, "battle titles that say what did the killing"],
  [9, "calmer win odds that move with the fighting"],
];

/** The newest insights version the page knows (index.ts INSIGHTS_VERSIONS[0]). */
export const LATEST_INSIGHTS = 9;

/** notices are the caveats the page states up front, in reading order. */
export function notices(ins: Insights): string[] {
  const out: string[] = [];
  if (ins.version < LATEST_INSIGHTS) {
    const missing = VERSION_FEATURES.filter(([v]) => v > ins.version).map(([, f]) => f);
    out.push(`Outdated report (v${ins.version}), missing: ${missing.join(", ")}. It updates when summaries are recomputed.`);
  }
  if (ins.version >= 7 && ins.pov === "full" && !ins.causes) {
    out.push("This capture does not record killers: reclaims count as losses, battles name no killers, no Immortal award. A new re-simulation adds them.");
  }
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

/** POWER_WORTH is what a lost power plant counts for per metal of its cost
 * when deciding who won a fight (Go's powerWorth): losing a fusion loses its
 * metal AND the energy it would have made. */
export const POWER_WORTH = 2.5;

/** lossWorth is what a battle side's losses decide the battle by: their
 * worth when the file records it, else their metal. */
export function lossWorth(l?: { metal: number; worth?: number }): number {
  return l ? (l.worth ?? l.metal) : 0;
}
