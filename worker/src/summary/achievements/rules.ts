// The achievements: every one on the shortlist that a demo and the BAR API
// can decide on their own (no re-simulation), judged in the browser from
// facts.ts. Each rule names who earned it, with the numbers that earned it,
// or says why this game cannot tell. The rules live in rules-*.ts, the
// helpers they share in rulekit.ts.
import { ENDSTATS } from "./rules-endstats";
import { LOBBY } from "./rules-lobby";
import { ORDERS_1 } from "./rules-orders1";
import { ORDERS_2 } from "./rules-orders2";
import { holder, type Facts, type Hit, type Rule } from "./rulekit";

export type { Hit, Knob, Need, Rule } from "./rulekit";
export { describe, MIN_GAME_MIN } from "./rulekit";

export const RULES: Rule[] = [...LOBBY, ...ENDSTATS, ...ORDERS_1, ...ORDERS_2];

export type Verdict = { rule: Rule; hits: Hit[] } | { rule: Rule; skip: string };

/** judge runs every rule at its own knob value. A rule that throws is a
 * skip rather than losing the rest. Of a tiered achievement each player,
 * side or game keeps only the highest tier it earned. */
export function judge(F: Facts, rules: Rule[] = RULES, k?: (r: Rule) => number): Verdict[] {
  const out: Verdict[] = rules.map((rule) => {
    try {
      const r = rule.check(F, k ? k(rule) : (rule.knob?.value ?? NaN));
      return "skip" in r ? { rule, skip: r.skip } : { rule, hits: r };
    } catch (e) {
      return { rule, skip: `the check failed: ${(e as Error).message}` };
    }
  });
  const best = new Map<string, number>();
  for (const v of out) if ("hits" in v && v.rule.group) for (const h of v.hits) {
    const key = `${v.rule.group}|${holder(h)}`;
    best.set(key, Math.max(best.get(key) ?? 0, v.rule.tier!));
  }
  for (const v of out) if ("hits" in v && v.rule.group) v.hits = v.hits.filter((h) => best.get(`${v.rule.group}|${holder(h)}`) === v.rule.tier);
  return out;
}
