import { createHash } from "node:crypto";
import type { NormalizedFacts } from "./facts.js";
import type { RailName } from "./types.js";

export interface CredentialConstraints {
  amount_minor: bigint;
  currency: string;
  mcc_allowed?: string[];
  mid_allowed?: string[];
  expires_at: string;
}

export interface AuthorizationInputs {
  policy_hash: string;
  rule_name: string;
  rail: RailName;
  credential_constraints: CredentialConstraints;
  approval_prompt_hash: string;
  fx_quote: { id: string; ts: string };
  rail_native: { amount_minor: bigint; currency: string };
  normalized_facts: NormalizedFacts;
}

export function authorizationHash(input: AuthorizationInputs): string {
  const canonical = canonicalJson({
    policy_hash: input.policy_hash,
    rule_name: input.rule_name,
    rail: input.rail,
    credential_constraints: input.credential_constraints,
    approval_prompt_hash: input.approval_prompt_hash,
    fx_quote: input.fx_quote,
    rail_native: input.rail_native,
    normalized_facts: stripUntrusted(input.normalized_facts)
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function stripUntrusted(facts: NormalizedFacts): Omit<NormalizedFacts, "untrusted_agent_text"> {
  const { untrusted_agent_text: _untrusted, ...trusted } = facts;
  return trusted;
}

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}
