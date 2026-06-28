import type { LintWarning, ResolvedPolicy, ResolvedRule, ResolvedWhen } from "./load.js";

export function lint(policy: ResolvedPolicy): LintWarning[] {
  const warnings: LintWarning[] = [];
  const last = policy.rules.at(-1);
  if (last?.do !== "deny" || last?.when) {
    warnings.push({
      code: "missing_default_deny",
      message: "policy does not end with an unconditional 'deny' rule"
    });
  }

  for (const rule of policy.rules) {
    if (rule.when?.merchant_signature === "verified") {
      warnings.push({
        code: "unreachable_predicate_card_rail",
        rule: rule.name,
        message: "merchant_signature: verified is unreachable in v1 because the card rail does not carry merchant signatures"
      });
    }
  }

  warnings.push(...findOverlappingAllows(policy.rules));
  return warnings;
}

function findOverlappingAllows(rules: ResolvedRule[]): LintWarning[] {
  const warnings: LintWarning[] = [];
  const allows = rules.filter((rule) => rule.do === "allow");

  for (let i = 0; i < allows.length; i += 1) {
    for (let j = i + 1; j < allows.length; j += 1) {
      const first = allows[i];
      const second = allows[j];
      if (first && second && overlaps(first.when, second.when)) {
        warnings.push({
          code: "overlapping_allow",
          rule: first.name,
          message: `'${first.name}' and '${second.name}' have overlapping merchant, amount, and type predicates; earlier rule wins`
        });
      }
    }
  }

  return warnings;
}

function overlaps(a?: ResolvedWhen, b?: ResolvedWhen): boolean {
  return setOverlap(a?.merchant_domain_in, b?.merchant_domain_in) && amountOverlap(a?.amount_usd, b?.amount_usd) && typeOverlap(a?.type, b?.type);
}

function setOverlap(a?: string[], b?: string[]): boolean {
  if (!a || !b) return true;
  return a.some((value) => b.includes(value));
}

function amountOverlap(a?: { min?: number; max?: number }, b?: { min?: number; max?: number }): boolean {
  if (!a || !b) return true;
  const aMin = a.min ?? 0;
  const aMax = a.max ?? Number.POSITIVE_INFINITY;
  const bMin = b.min ?? 0;
  const bMax = b.max ?? Number.POSITIVE_INFINITY;
  return aMin <= bMax && bMin <= aMax;
}

function typeOverlap(a?: ResolvedWhen["type"], b?: ResolvedWhen["type"]): boolean {
  if (!a || !b) return true;
  const aValues = Array.isArray(a) ? a : [a];
  const bValues = Array.isArray(b) ? b : [b];
  return aValues.some((value) => bValues.includes(value));
}
