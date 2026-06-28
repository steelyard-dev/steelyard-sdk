import { describe, expect, it } from "vitest";
import { authorizationHash, type AuthorizationInputs } from "../src/auth-hash.js";

function inputs(overrides: Partial<AuthorizationInputs> = {}): AuthorizationInputs {
  return {
    policy_hash: "sha256:aaa",
    rule_name: "trusted-small-card",
    rail: "virtual_card",
    credential_constraints: {
      amount_minor: 5000n,
      currency: "USD",
      mcc_allowed: ["5732"],
      mid_allowed: ["acct_123"],
      expires_at: "2026-06-29T00:00:00Z"
    },
    approval_prompt_hash: "",
    fx_quote: { id: "fxq_identity", ts: "2026-06-28T12:00:00Z" },
    rail_native: { amount_minor: 5000n, currency: "USD" },
    normalized_facts: {
      merchant_domain: { value: "amazon.com", source: "url_etld+1" },
      amount_usd: { value: { amount_minor: 5000n, currency: "USD" }, source: "agent_declared" },
      type: { value: "one_time", source: "agent_declared" },
      cart_contains: { value: [], source: "agent_declared" },
      merchant_supports_ucp_acp: { value: false, source: "manifest" },
      tls_ok: { value: true, source: "tls_probe" },
      untrusted_agent_text: {}
    },
    ...overrides
  };
}

describe("authorizationHash", () => {
  it("is deterministic across runs", () => {
    expect(authorizationHash(inputs())).toBe(authorizationHash(inputs()));
  });

  it("changes when policy_hash changes", () => {
    expect(authorizationHash(inputs())).not.toBe(authorizationHash(inputs({ policy_hash: "sha256:bbb" })));
  });

  it("changes when rule_name changes", () => {
    expect(authorizationHash(inputs())).not.toBe(authorizationHash(inputs({ rule_name: "other" })));
  });

  it("changes when credential_constraints amount changes", () => {
    const base = inputs();
    expect(authorizationHash(base)).not.toBe(
      authorizationHash(inputs({ credential_constraints: { ...base.credential_constraints, amount_minor: 5001n } }))
    );
  });

  it("changes when approval prompt, FX quote, or rail-native amount changes", () => {
    const base = inputs();
    expect(authorizationHash(base)).not.toBe(authorizationHash(inputs({ approval_prompt_hash: "sha256:prompt" })));
    expect(authorizationHash(base)).not.toBe(authorizationHash(inputs({ fx_quote: { id: "fxq_2", ts: "2026-06-28T12:01:00Z" } })));
    expect(authorizationHash(base)).not.toBe(authorizationHash(inputs({ rail_native: { amount_minor: 5001n, currency: "USD" } })));
  });

  it("changes when trusted normalized facts change", () => {
    const base = inputs();
    expect(authorizationHash(base)).not.toBe(
      authorizationHash(
        inputs({
          normalized_facts: {
            ...base.normalized_facts,
            merchant_domain: { value: "target.com", source: "url_etld+1" }
          }
        })
      )
    );
  });

  it("ignores untrusted_agent_text", () => {
    const base = inputs();
    const changed = inputs({
      normalized_facts: {
        ...base.normalized_facts,
        untrusted_agent_text: { agent_rationale: "anything" }
      }
    });
    expect(authorizationHash(base)).toBe(authorizationHash(changed));
  });

  it("uses empty string for approval_prompt_hash on non-approval allows", () => {
    const hash = authorizationHash(inputs({ approval_prompt_hash: "" }));
    expect(hash.startsWith("sha256:")).toBe(true);
  });
});
