import type { NormalizedFacts } from "./facts.js";
import type { ResolvedPolicy, ResolvedRule } from "./schema/load.js";

export interface Decision {
  effect: "allow" | "deny" | "require_approval";
  matched_rule: string;
  rule: ResolvedRule;
  counterfactuals: string[];
}

export function evaluate(policy: ResolvedPolicy, facts: NormalizedFacts): Decision {
  const matches = policy.rules.filter((rule) => predicateMatches(rule, facts));
  const hardDeny = matches.find((rule) => rule.do === "deny" && rule.when);
  if (hardDeny) return decision("deny", hardDeny, matches);

  const winner = matches.find((rule) => rule.do !== "deny") ?? matches.find((rule) => rule.do === "deny");
  if (!winner) {
    return {
      effect: "deny",
      matched_rule: "<no-match>",
      rule: { name: "<no-match>", do: "deny" },
      counterfactuals: []
    };
  }

  return decision(winner.do, winner, matches);
}

function decision(effect: Decision["effect"], winner: ResolvedRule, matches: ResolvedRule[]): Decision {
  return {
    effect,
    matched_rule: winner.name,
    rule: winner,
    counterfactuals: matches.filter((rule) => rule !== winner).map((rule) => rule.name)
  };
}

function predicateMatches(rule: ResolvedRule, facts: NormalizedFacts): boolean {
  const when = rule.when;
  if (!when) return true;

  if (when.merchant_domain_in && !when.merchant_domain_in.includes(facts.merchant_domain.value)) return false;
  if (when.amount_usd && !amountMatches(when.amount_usd, facts)) return false;
  if (when.type && !typeMatches(when.type, facts.type.value)) return false;
  if (when.cart_contains && !cartMatches(when.cart_contains, facts.cart_contains.value)) return false;
  if (when.merchant_supports === "ucp_acp" && !facts.merchant_supports_ucp_acp.value) return false;
  if (when.merchant_signature === "verified") return false;
  if (when.tls === "required" && !facts.tls_ok.value) return false;
  return true;
}

function amountMatches(range: { min?: number; max?: number }, facts: NormalizedFacts): boolean {
  const usdMajor = Number(facts.amount_usd.value.amount_minor) / 100;
  if (range.min !== undefined && usdMajor < range.min) return false;
  if (range.max !== undefined && usdMajor > range.max) return false;
  return true;
}

function typeMatches(allowed: NonNullable<ResolvedRule["when"]>["type"], value: NormalizedFacts["type"]["value"]): boolean {
  const allowedValues = Array.isArray(allowed) ? allowed : [allowed];
  return allowedValues.includes(value);
}

function cartMatches(needed: string[], actual: string[]): boolean {
  const actualSet = new Set(actual);
  return needed.some((value) => actualSet.has(value));
}
