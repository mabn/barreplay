// Places: what a point on the map is CALLED. Players do not say "the
// south-west", they say "Blue geo" — so a map whose areas have names the
// community uses gets them here (Marcin's labels), and every other map is
// told by compass. Names a side's base by that side's colour when the area
// is part of one: the area belongs to whichever side STARTED in that half.
import { sideShort } from "./model";
import type { Insights } from "./types";

export interface Place {
  /** "the middle", "Blue geo", "the north-west". */
  name: string;
  /** The preposition a sentence puts before it: "in", "at" or "on". */
  prep: "in" | "at" | "on";
  /** The side whose base the place is part of, -1 for none. */
  side: number;
}

interface NamedMap {
  re: RegExp;
  /** The map's size in elmos (map units x 512): its own coordinates, since
   * the capture's bounds take in aircraft flying past the edge. */
  size: [number, number];
  /** Labels at fractions of the map, x then z (north up). A base label is
   * one of two halves, split by `half`; the rest name no side. */
  points: { name: string; u: number; v: number; base?: boolean }[];
  /** Which half a point is in: true for the first half. */
  half: (u: number, v: number) => boolean;
}

// Supreme Isthmus: two bases on opposite diagonals (north-east and
// south-west), the same layout rotated half a turn, the seas and islands
// between them neutral. Read off Marcin's labelled 24x24 map.
const isthmusBase: [string, number, number][] = [
  ["air", 0.19, 0.945],
  ["eco", 0.083, 0.84],
  ["beach", 0.476, 0.895],
  ["geo", 0.387, 0.787],
  ["front", 0.389, 0.584],
  ["front", 0.426, 0.692],
  ["geo sea", 0.08, 0.523],
];
const MAPS: NamedMap[] = [{
  re: /^supreme isthmus/i,
  size: [12288, 12288],
  points: [
    // The south-west base, and its north-east twin rotated half a turn.
    ...isthmusBase.map(([name, u, v]) => ({ name, u, v, base: true })),
    ...isthmusBase.map(([name, u, v]) => ({ name, u: 1 - u, v: 1 - v, base: true })),
    { name: "the middle", u: 0.518, v: 0.505 },
    { name: "the north sea", u: 0.4, v: 0.127 },
    { name: "the north sea", u: 0.272, v: 0.25 },
    { name: "the north island", u: 0.076, v: 0.147 },
    { name: "the south sea", u: 0.712, v: 0.7 },
    { name: "the south sea", u: 0.797, v: 0.846 },
    { name: "the south island", u: 0.944, v: 0.812 },
  ],
  half: (u, v) => v > u,
}];

/** Where each side started: the first army centre the capture has. */
function startOf(ins: Insights, side: number): number[] | null {
  for (const p of ins.series.front?.[side] ?? []) if (p) return p;
  return null;
}

export function place(ins: Insights, x: number, z: number): Place {
  const m = MAPS.find((mp) => mp.re.test(ins.mapName ?? ""));
  if (m) {
    const u = x / m.size[0];
    const v = z / m.size[1];
    let best = m.points[0];
    let d = Infinity;
    for (const p of m.points) {
      const e = Math.hypot(p.u - u, p.v - v);
      if (e < d) [best, d] = [p, e];
    }
    if (!best.base) return { name: best.name, prep: best.name.endsWith("island") ? "on" : "in", side: -1 };
    // The side that started in this half owns it; with two sides that
    // started in different halves only, or the name would be a guess.
    const mine = m.half(best.u, best.v);
    const owners = ins.sides.map((_, s) => startOf(ins, s)).map((p) => (p ? m.half(p[0] / m.size[0], p[1] / m.size[1]) : null));
    const side = owners.length === 2 && owners[0] !== null && owners[1] !== null && owners[0] !== owners[1] ? owners.indexOf(mine) : -1;
    if (side >= 0) return { name: `${sideShort(ins, side)} ${best.name}`, prep: "at", side };
  }
  return { name: compassName(ins, x, z), prep: "in", side: -1 };
}

/** compassName says where a point sits by the compass: "the north-west",
 * "the middle". Bounds are the capture's, which is what the map view draws. */
function compassName(ins: Insights, x: number, z: number): string {
  const b = ins.bounds;
  const u = (x - b.minX) / Math.max(1, b.maxX - b.minX);
  const v = (z - b.minZ) / Math.max(1, b.maxZ - b.minZ);
  const ns = v < 1 / 3 ? "north" : v > 2 / 3 ? "south" : "";
  const ew = u < 1 / 3 ? "west" : u > 2 / 3 ? "east" : "";
  if (!ns && !ew) return "the middle";
  return "the " + (ns && ew ? `${ns}-${ew}` : ns || ew);
}

/** at is the place with its preposition: "in the middle", "at Blue geo". */
export function at(ins: Insights, x: number, z: number): string {
  const p = place(ins, x, z);
  return `${p.prep} ${p.name}`;
}
