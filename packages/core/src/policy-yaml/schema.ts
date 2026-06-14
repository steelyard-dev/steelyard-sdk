import { parseDocument } from "yaml";
import { z } from "zod";
import type { Rule, SpendLimits } from "../schemas.js";
import { normalizeCurrency } from "./normalize.js";

const MAX_POLICY_BYTES = 1024 * 1024;

const CurrencyValueSchema = z.preprocess(
  (value) => (typeof value === "string" ? normalizeCurrency(value) : value),
  z.string().regex(/^[A-Z]{3}$/)
);

const AmountPredicateSchema = z.object({
  lte: z.number().int().nonnegative().optional(),
  gte: z.number().int().nonnegative().optional(),
  between: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional()
}).strict();

const WhereSchema = z.object({
  merchant_domain: z.union([z.string(), z.array(z.string())]).optional(),
  currency: z.union([CurrencyValueSchema, z.array(CurrencyValueSchema)]).optional(),
  amount: AmountPredicateSchema.optional(),
  offer_category: z.union([z.string(), z.array(z.string())]).optional()
}).strict().superRefine((where, ctx) => {
  if (where.amount && !where.currency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["currency"],
      message: "where.amount requires where.currency"
    });
  }
});

const RuleSchema = z.object({
  name: z.string().min(1),
  can: z.literal("buy").optional(),
  cannot: z.literal("buy").optional(),
  where: WhereSchema.optional(),
  requires_approval_above: z.object({
    amount: z.number().int().nonnegative(),
    currency: CurrencyValueSchema
  }).strict().optional()
}).strict().superRefine((rule, ctx) => {
  if (!!rule.can === !!rule.cannot) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["can"],
      message: "exactly one of can or cannot is required"
    });
  }
});

const LimitsSchema = z.record(z.record(z.number().int().nonnegative())).optional();

const PolicyYamlSchema = z.object({
  version: z.literal("0.1", { errorMap: () => ({ message: "unsupported policy version" }) }),
  default: z.enum(["deny", "allow"]),
  rules: z.array(RuleSchema).default([]),
  limits: z.object({
    daily: z.record(z.number().int().nonnegative()).optional(),
    weekly: z.record(z.number().int().nonnegative()).optional(),
    monthly: z.record(z.number().int().nonnegative()).optional()
  }).strict().optional()
}).strict();

export interface ParsedPolicyDocument {
  path: string;
  default: "deny" | "allow";
  rules: Rule[];
  limits: SpendLimits;
}

export function parsePolicyYaml(raw: string, path = "<policy>"): ParsedPolicyDocument {
  if (Buffer.byteLength(raw, "utf8") > MAX_POLICY_BYTES) {
    throw new Error(`${path}: policy file exceeds 1 MB`);
  }
  rejectYamlFeatures(raw, path);
  const doc = parseDocument(raw, { strict: true, uniqueKeys: true });
  if (doc.errors.length) {
    throw new Error(`${path}: invalid policy YAML: ${doc.errors[0]!.message}`);
  }
  const result = PolicyYamlSchema.safeParse(doc.toJSON());
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`${path}: ${jsonPointer(issue.path)} ${issue.message}`.trim());
  }
  return {
    path,
    default: result.data.default,
    rules: result.data.rules.map((rule): Rule => ({
      name: rule.name,
      effect: rule.cannot ? "cannot" : "can",
      action: "buy",
      where: rule.where,
      requires_approval_above: rule.requires_approval_above
    })),
    limits: normalizeLimits(result.data.limits)
  };
}

function rejectYamlFeatures(raw: string, path: string): void {
  if (/(^|\s)[&*][A-Za-z0-9_-]+/.test(raw)) {
    throw new Error(`${path}: YAML anchors and aliases are not allowed`);
  }
  if (/^%TAG\b/m.test(raw) || /(^|\s)![^\s]/.test(raw)) {
    throw new Error(`${path}: YAML tags are not allowed`);
  }
}

function normalizeLimits(limits: z.infer<typeof LimitsSchema>): SpendLimits {
  const out: SpendLimits = {};
  for (const window of ["daily", "weekly", "monthly"] as const) {
    const values = limits?.[window];
    if (values) {
      out[window] = Object.fromEntries(
        Object.entries(values).map(([currency, amount]) => [normalizeCurrency(currency), amount])
      );
    }
  }
  return out;
}

function jsonPointer(path: (string | number)[]): string {
  return path.length ? `/${path.join("/")}` : "/";
}
