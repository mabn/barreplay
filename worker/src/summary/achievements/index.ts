// Achievements judged IN THE BROWSER from what every game has: its demo (the
// order stream, chat, the end-of-game totals) and the BAR API's metadata, plus
// the published replay's unit-def table to name build orders. A first look at
// how the shortlist's rules behave on real games, so nothing here is stored
// or computed ahead of time.
import { fetchBrpDefs, fetchDemo } from "../demo";
import { type Insights } from "../types";
import { gather } from "./facts";
import { RULES, type Hit, type Rule } from "./rules";

export type { Hit, Rule } from "./rules";

export interface AchievementResult {
  earned: { rule: Rule; hits: Hit[] }[];
  /** Rules this game could judge that nobody earned. */
  missed: Rule[];
  /** Rules this game cannot judge, with why. */
  unknown: { rule: Rule; why: string }[];
  /** What could not be read and so left rules unknown (the def table). */
  notes: string[];
}

/** loadAchievements fetches the demo through barApi (a BAR API proxy that
 * also serves /demos/<file>) and the def table out of brpUrl, then runs every
 * rule. A rule that throws is reported unknown rather than losing the rest. */
export async function loadAchievements(ins: Insights, barApi: string, brpUrl: string | null): Promise<AchievementResult> {
  const notes: string[] = [];
  const [{ demo, map }, defs] = await Promise.all([
    fetchDemo(barApi, ins.gameId),
    brpUrl
      ? fetchBrpDefs(brpUrl).catch((e: Error) => (notes.push(`the unit-def table could not be read (${e.message})`), null))
      : Promise.resolve(null),
  ]);
  const F = gather(demo, defs, ins, map);
  const out: AchievementResult = { earned: [], missed: [], unknown: [], notes };
  for (const rule of RULES) {
    try {
      const r = rule.check(F);
      if ("skip" in r) out.unknown.push({ rule, why: r.skip });
      else if (r.length) out.earned.push({ rule, hits: r });
      else out.missed.push(rule);
    } catch (e) {
      out.unknown.push({ rule, why: `the check failed: ${(e as Error).message}` });
    }
  }
  return out;
}
