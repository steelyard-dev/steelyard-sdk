import { describe, expect, it } from "vitest";
import { loadPolicyFromString } from "../src/schema/load.js";

describe("loadPolicyFromString", () => {
  it("loads a minimal valid policy", () => {
    const yaml = `
version: 2026-06-27
rules:
  - name: default-deny
    do: deny
`;

    const { policy, warnings } = loadPolicyFromString(yaml);
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0]?.name).toBe("default-deny");
    expect(warnings).toEqual([]);
  });

  it("rejects allow without rail", () => {
    const yaml = `
version: 2026-06-27
rules:
  - name: bad
    do: allow
    when: { amount_usd: { max: 10 } }
`;

    expect(() => loadPolicyFromString(yaml)).toThrow(/'rail' is required on 'allow' rules/);
  });

  it("rejects deny with cart_contains", () => {
    const yaml = `
version: 2026-06-27
rules:
  - name: bad
    do: deny
    when: { cart_contains: [gift_card] }
`;

    expect(() => loadPolicyFromString(yaml)).toThrow(/cart_contains.*deny/);
  });

  it("resolves merchant_domain_in to declared trusted list", () => {
    const yaml = `
version: 2026-06-27
trusted_domains:
  safe: [amazon.com, target.com]
rules:
  - name: ok
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: safe }
  - name: deny-all
    do: deny
`;

    const { policy } = loadPolicyFromString(yaml);
    expect(policy.rules[0]?.when?.merchant_domain_in).toEqual(["amazon.com", "target.com"]);
  });

  it("resolves merchant_domain_in to blocked_domains", () => {
    const yaml = `
version: 2026-06-27
blocked_domains: [temu.com]
rules:
  - name: block-listed
    do: deny
    when: { merchant_domain_in: blocked_domains }
`;

    const { policy } = loadPolicyFromString(yaml);
    expect(policy.rules[0]?.when?.merchant_domain_in).toEqual(["temu.com"]);
  });

  it("rejects unresolved list reference", () => {
    const yaml = `
version: 2026-06-27
rules:
  - name: bad
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: undefined_list }
`;

    expect(() => loadPolicyFromString(yaml)).toThrow(/undefined_list/);
  });

  it("throws human-readable schema errors", () => {
    expect(() => loadPolicyFromString("version: 1999-01-01\nrules: []")).toThrow(/policy schema validation failed/);
  });
});
