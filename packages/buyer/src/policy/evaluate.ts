import type { Decision, PurchaseIntent, Rule, SpendLimits } from "@steelyard/core";
import { domainMatches } from "./glob.js";
import { normalizeCurrency, normalizeMerchantDomain } from "./normalize.js";
import type { ParsedPolicyDocument } from "./schema.js";

export interface PolicySpendContext {
  spendInWindow(window: "daily" | "weekly" | "monthly", currency: string): Promise<number>;
}

export async function evaluatePolicy(
  documents: ParsedPolicyDocument[],
  intent: PurchaseIntent,
  ctx: { vault?: PolicySpendContext } = {}
): Promise<Decision> {
  const normalizedIntent = normalizeIntent(intent);
  const limits = mergeLimits(documents.map((doc) => doc.limits));
  if (hasLimits(limits)) {
    if (!ctx.vault) return { status: "denied", reason: "spend_limits_require_vault" };
    const limitDecision = await evaluateLimits(limits, normalizedIntent, ctx.vault);
    if (limitDecision) return limitDecision;
  }

  const cannot = documents.flatMap((doc) => doc.rules.filter((rule) => rule.effect === "cannot"));
  const projectCan = (documents[0]?.rules ?? []).filter((rule) => rule.effect === "can");
  const globalCan = documents.slice(1).flatMap((doc) => doc.rules.filter((rule) => rule.effect === "can"));

  for (const rule of cannot) {
    if (matchesRule(rule, normalizedIntent)) {
      return { status: "denied", reason: `blocked by rule '${rule.name}'` };
    }
  }
  for (const rule of [...projectCan, ...globalCan]) {
    if (matchesRule(rule, normalizedIntent)) return allowedDecision(rule, normalizedIntent);
  }
  return defaultDecision(documents);
}

function normalizeIntent(intent: PurchaseIntent): PurchaseIntent {
  return {
    ...intent,
    merchant: { ...intent.merchant, domain: normalizeMerchantDomain(intent.merchant.domain) },
    currency: normalizeCurrency(intent.currency)
  };
}

function matchesRule(rule: Rule, intent: PurchaseIntent): boolean {
  const where = rule.where;
  if (!where) return true;
  if (where.merchant_domain && !asArray(where.merchant_domain).some((pattern) => domainMatches(pattern, intent.merchant.domain))) {
    return false;
  }
  if (where.currency && !asArray(where.currency).map(normalizeCurrency).includes(intent.currency)) {
    return false;
  }
  if (where.offer_category && !asArray(where.offer_category).some((category) => intent.offer.categories.includes(category))) {
    return false;
  }
  if (where.amount) {
    const { amount } = intent;
    if (where.amount.lte !== undefined && amount > where.amount.lte) return false;
    if (where.amount.gte !== undefined && amount < where.amount.gte) return false;
    if (where.amount.between && (amount < where.amount.between[0] || amount > where.amount.between[1])) return false;
  }
  return true;
}

function allowedDecision(rule: Rule, intent: PurchaseIntent): Decision {
  const threshold = rule.requires_approval_above;
  if (threshold && normalizeCurrency(threshold.currency) === intent.currency && intent.amount > threshold.amount) {
    return { status: "approval_required", threshold, matched_rule: rule.name };
  }
  return { status: "allowed", rule: rule.name };
}

function defaultDecision(documents: ParsedPolicyDocument[]): Decision {
  const projectDefault = documents[0]?.default ?? "deny";
  if (projectDefault === "allow") return { status: "allowed", rule: "default" };
  return { status: "denied", reason: "default deny" };
}

function mergeLimits(limits: SpendLimits[]): SpendLimits {
  const merged: SpendLimits = {};
  for (const window of ["daily", "weekly", "monthly"] as const) {
    const entries = limits.flatMap((limit) => Object.entries(limit[window] ?? {}));
    if (entries.length) {
      merged[window] = {};
      for (const [currency, amount] of entries) {
        const normalized = normalizeCurrency(currency);
        merged[window]![normalized] = Math.min(merged[window]![normalized] ?? Number.POSITIVE_INFINITY, amount);
      }
    }
  }
  return merged;
}

function hasLimits(limits: SpendLimits): boolean {
  return ["daily", "weekly", "monthly"].some((window) =>
    Object.values(limits[window as keyof SpendLimits] ?? {}).some((amount) => amount > 0)
  );
}

async function evaluateLimits(
  limits: SpendLimits,
  intent: PurchaseIntent,
  vault: PolicySpendContext
): Promise<Decision | undefined> {
  for (const window of ["daily", "weekly", "monthly"] as const) {
    const cap = limits[window]?.[intent.currency];
    if (cap === undefined) continue;
    const current = await vault.spendInWindow(window, intent.currency);
    if (current + intent.amount > cap) {
      return { status: "denied", reason: `${window}_limit_exceeded` };
    }
  }
  return undefined;
}

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}
