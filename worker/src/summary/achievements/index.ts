// Achievements judged IN THE BROWSER from what every game has: its demo (the
// order stream, chat, the end-of-game totals) and the BAR API's metadata, plus
// the published replay's unit-def table to name build orders. A first look at
// how the shortlist's rules behave on real games, so nothing here is stored
// or computed ahead of time.
import { fetchBrpDefs, fetchDemo } from "../demo";
import { type Insights } from "../types";
import { gather } from "./facts";
import { MIN_GAME_MIN, judge, type Hit, type Rule } from "./rules";

export type { Hit, Knob, Rule } from "./rules";
export { describe } from "./rules";

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
 * rule (judge). A game shorter than MIN_GAME_MIN minutes earns nothing. */
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
  if (F.endMin < MIN_GAME_MIN) {
    notes.push(`games under ${MIN_GAME_MIN} minutes earn no achievements`);
    return out;
  }
  for (const v of judge(F)) {
    if ("skip" in v) out.unknown.push({ rule: v.rule, why: v.skip });
    else if (v.hits.length) out.earned.push(v);
    else out.missed.push(v.rule);
  }
  // A tiered achievement somebody earned is not also "not earned" at its
  // other tiers.
  const got = new Set(out.earned.map((e) => e.rule.group).filter(Boolean));
  out.missed = out.missed.filter((r) => !r.group || !got.has(r.group));
  return out;
}
