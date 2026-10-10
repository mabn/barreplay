// A battle's losses as KINDS of unit: defs drawn with the same icon (every
// tech-2 fighter, say) are one kind, their counts and metal added up, and
// only the kinds that carry most of the metal are shown up front — two walls
// and a jammer are not what a fight was about.
import type { UnitLoss } from "./types";

export interface LossKind {
  /** What groups the defs: the icon's URL, or a def's own key without one. */
  key: string;
  defs: UnitLoss[];
  n: number;
  metal: number;
}

/** MAIN_SHARE of the metal lost is what the kinds shown up front cover. */
export const MAIN_SHARE = 0.9;

/** lossKinds groups units by key, the costliest kind first (then the most
 * lost), and splits them into the kinds covering MAIN_SHARE of the metal —
 * of the count, when nothing is priced — and the rest. */
export function lossKinds(units: UnitLoss[], key: (u: UnitLoss) => string): { main: LossKind[]; rest: LossKind[] } {
  const by = new Map<string, LossKind>();
  for (const u of units) {
    const k = key(u);
    let g = by.get(k);
    if (!g) by.set(k, (g = { key: k, defs: [], n: 0, metal: 0 }));
    g.defs.push(u);
    g.n += u.n;
    g.metal += u.metal;
  }
  const priced = units.some((u) => u.metal > 0);
  const size = (g: LossKind) => (priced ? g.metal : g.n);
  const kinds = [...by.values()].sort((a, b) => size(b) - size(a) || b.n - a.n || a.key.localeCompare(b.key));
  for (const g of kinds) g.defs.sort((a, b) => b.metal - a.metal || b.n - a.n);
  const total = kinds.reduce((a, g) => a + size(g), 0);
  let sum = 0;
  let cut = 0;
  while (cut < kinds.length && (cut === 0 || sum < MAIN_SHARE * total)) sum += size(kinds[cut++]);
  return { main: kinds.slice(0, cut), rest: kinds.slice(cut) };
}
