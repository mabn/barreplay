// The achievements: every one on the shortlist that a demo and the BAR API
// can decide on their own (no re-simulation), judged in the browser from
// facts.ts. Each rule names who earned it, with the numbers that earned it,
// or says why this game cannot tell. The rules live in rules-*.ts, the
// helpers they share in rulekit.ts.
import { ENDSTATS } from "./rules-endstats";
import { LOBBY } from "./rules-lobby";
import { ORDERS_1 } from "./rules-orders1";
import { ORDERS_2 } from "./rules-orders2";
import { type Rule } from "./rulekit";

export type { Hit, Knob, Need, Rule } from "./rulekit";
export { describe } from "./rulekit";

export const RULES: Rule[] = [...LOBBY, ...ENDSTATS, ...ORDERS_1, ...ORDERS_2];
