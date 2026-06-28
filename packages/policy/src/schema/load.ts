import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import type { PolicyDocument, RailName, Rule, RuleEffect } from "../types.js";
import { lint } from "./lint.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(resolveSchemaPath(), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

export type LintWarning = { code: string; message: string; rule?: string };

export interface LoadedPolicy {
  policy: ResolvedPolicy;
  warnings: LintWarning[];
}

export interface ResolvedPolicy extends Omit<PolicyDocument, "rules"> {
  rules: ResolvedRule[];
}

export interface ResolvedRule extends Omit<Rule, "when"> {
  do: RuleEffect;
  rail?: RailName;
  when?: ResolvedWhen;
}

export interface ResolvedWhen {
  merchant_domain_in?: string[];
  amount_usd?: { min?: number; max?: number };
  type?: "one_time" | "subscription" | "mandate" | "installment" | Array<"one_time" | "subscription" | "mandate" | "installment">;
  cart_contains?: string[];
  merchant_supports?: "ucp_acp";
  merchant_signature?: "verified";
  tls?: "required";
}

export class PolicySchemaError extends Error {
  constructor(readonly errors: ErrorObject[]) {
    super(`policy schema validation failed:\n${errors.map((error) => `  ${error.instancePath || "/"} ${error.message}`).join("\n")}`);
    this.name = "PolicySchemaError";
  }
}

export function loadPolicyFromString(input: string): LoadedPolicy {
  const raw = parseYaml(input);
  if (!validate(raw)) {
    throw new PolicySchemaError(validate.errors ?? []);
  }

  const doc = raw as PolicyDocument;
  enforceLoadInvariants(doc);
  const policy = resolveReferences(doc);
  return { policy, warnings: lint(policy) };
}

export function loadPolicyFromFile(path: string): LoadedPolicy {
  return loadPolicyFromString(readFileSync(path, "utf8"));
}

function resolveSchemaPath(): string {
  const candidates = [
    resolve(here, "../../spec/policy/0.1/policy.schema.json"),
    resolve(here, "../spec/policy/0.1/policy.schema.json")
  ];
  const schemaPath = candidates.find((candidate) => existsSync(candidate));
  if (!schemaPath) throw new Error(`policy schema not found; tried ${candidates.join(", ")}`);
  return schemaPath;
}

function enforceLoadInvariants(doc: PolicyDocument): void {
  for (const rule of doc.rules) {
    if (rule.do === "allow" && !rule.rail) {
      throw new Error(`rule '${rule.name}': 'rail' is required on 'allow' rules`);
    }
    if (rule.do === "allow" && rule.rail !== "virtual_card") {
      throw new Error(`rule '${rule.name}': only rail 'virtual_card' is supported in v1`);
    }
    if (rule.do === "deny" && rule.when && "cart_contains" in rule.when) {
      throw new Error(`rule '${rule.name}': cart_contains is not allowed in deny rules`);
    }
  }
}

function resolveReferences(doc: PolicyDocument): ResolvedPolicy {
  return {
    ...doc,
    rules: doc.rules.map((rule) => resolveRule(doc, rule))
  };
}

function resolveRule(doc: PolicyDocument, rule: Rule): ResolvedRule {
  if (!rule.when) return rule as ResolvedRule;
  const when = rule.when as Record<string, unknown>;
  const ref = typeof when.merchant_domain_in === "string" ? when.merchant_domain_in : undefined;
  if (!ref) return rule as ResolvedRule;

  const resolved = resolveDomainList(doc, ref);
  if (!resolved) {
    throw new Error(`rule '${rule.name}': merchant_domain_in '${ref}' is not declared in trusted_domains or blocked_domains`);
  }

  return {
    ...rule,
    when: {
      ...when,
      merchant_domain_in: resolved
    } as ResolvedWhen
  };
}

function resolveDomainList(doc: PolicyDocument, ref: string): string[] | undefined {
  if (ref === "blocked_domains") return doc.blocked_domains;
  return doc.trusted_domains?.[ref];
}
