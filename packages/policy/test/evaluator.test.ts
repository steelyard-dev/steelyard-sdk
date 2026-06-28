import { describe, expect, it } from "vitest";
import { evaluate } from "../src/evaluator.js";
import type { NormalizedFacts } from "../src/facts.js";
import { loadPolicyFromString } from "../src/schema/load.js";

function facts(overrides: Partial<NormalizedFacts> = {}): NormalizedFacts {
  return {
    merchant_domain: { value: "amazon.com", source: "url_etld+1" },
    amount_usd: { value: { amount_minor: 5000n, currency: "USD" }, source: "agent_declared" },
    type: { value: "one_time", source: "agent_declared" },
    cart_contains: { value: [], source: "agent_declared" },
    merchant_supports_ucp_acp: { value: false, source: "manifest" },
    tls_ok: { value: true, source: "tls_probe" },
    untrusted_agent_text: {},
    ...overrides
  };
}

describe("evaluate", () => {
  it("conditional deny wins regardless of position", () => {
    const { policy } = loadPolicyFromString(`
version: 2026-06-27
trusted_domains: { tier1: [amazon.com] }
rules:
  - name: small-card
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier1, amount_usd: { max: 100 } }
  - name: blocked
    do: deny
    when: { merchant_domain_in: tier1 }
  - name: deny-all
    do: deny
`);

    const decision = evaluate(policy, facts());
    expect(decision.matched_rule).toBe("blocked");
    expect(decision.effect).toBe("deny");
  });

  it("unconditional deny is fallback and does not preempt a matching allow", () => {
    const { policy } = loadPolicyFromString(`
version: 2026-06-27
trusted_domains: { tier1: [amazon.com] }
rules:
  - name: small-card
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier1, amount_usd: { max: 100 }, type: one_time }
  - name: deny-all
    do: deny
`);

    const decision = evaluate(policy, facts());
    expect(decision.matched_rule).toBe("small-card");
    expect(decision.counterfactuals).toContain("deny-all");
  });

  it("first matching allow wins among allows", () => {
    const { policy } = loadPolicyFromString(`
version: 2026-06-27
trusted_domains: { tier1: [amazon.com] }
rules:
  - name: first
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier1, amount_usd: { max: 100 } }
  - name: second
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier1, amount_usd: { max: 200 } }
  - name: deny-all
    do: deny
`);

    expect(evaluate(policy, facts()).matched_rule).toBe("first");
  });

  it("falls through to require_approval when no allow matches", () => {
    const { policy } = loadPolicyFromString(`
version: 2026-06-27
trusted_domains: { tier1: [amazon.com] }
rules:
  - name: small-card
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier1, amount_usd: { max: 50 } }
  - name: ask
    do: require_approval
    approval: { who: user, channel: webhook, expires_in: 5m }
  - name: deny-all
    do: deny
`);

    const decision = evaluate(policy, facts({ amount_usd: { value: { amount_minor: 10000n, currency: "USD" }, source: "agent_declared" } }));
    expect(decision.matched_rule).toBe("ask");
    expect(decision.effect).toBe("require_approval");
  });

  it("matches cart, UCP support, and TLS predicates", () => {
    const { policy } = loadPolicyFromString(`
version: 2026-06-27
rules:
  - name: ucp-safe-cart
    do: allow
    rail: virtual_card
    when: { cart_contains: [book], merchant_supports: ucp_acp, tls: required }
  - name: deny-all
    do: deny
`);

    const decision = evaluate(
      policy,
      facts({
        cart_contains: { value: ["book"], source: "agent_declared" },
        merchant_supports_ucp_acp: { value: true, source: "manifest" },
        tls_ok: { value: true, source: "tls_probe" }
      })
    );
    expect(decision.matched_rule).toBe("ucp-safe-cart");
  });

  it("does not match merchant_signature on the v1 card rail", () => {
    const { policy } = loadPolicyFromString(`
version: 2026-06-27
rules:
  - name: signed
    do: allow
    rail: virtual_card
    when: { merchant_signature: verified }
  - name: deny-all
    do: deny
`);

    expect(evaluate(policy, facts()).matched_rule).toBe("deny-all");
  });

  it("returns synthetic deny when no rule matches", () => {
    const { policy } = loadPolicyFromString(`
version: 2026-06-27
trusted_domains: { tier1: [target.com] }
rules:
  - name: target-only
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier1 }
`);

    const decision = evaluate(policy, facts());
    expect(decision.effect).toBe("deny");
    expect(decision.matched_rule).toBe("<no-match>");
  });
});
