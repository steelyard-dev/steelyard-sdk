import { describe, expect, it } from "vitest";
import { loadPolicyFromString } from "../src/schema/load.js";

describe("lint warnings", () => {
  it("warns when default-deny is missing", () => {
    const yaml = `
version: 2026-06-27
rules:
  - name: only-allow
    do: allow
    rail: virtual_card
`;

    const { warnings } = loadPolicyFromString(yaml);
    expect(warnings.find((warning) => warning.code === "missing_default_deny")).toBeTruthy();
  });

  it("warns on overlapping allow rules", () => {
    const yaml = `
version: 2026-06-27
trusted_domains: { tier1: [amazon.com] }
rules:
  - name: a
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier1, amount_usd: { max: 100 }, type: one_time }
  - name: b
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier1, amount_usd: { max: 200 }, type: one_time }
  - name: deny-all
    do: deny
`;

    const { warnings } = loadPolicyFromString(yaml);
    expect(warnings.find((warning) => warning.code === "overlapping_allow")).toBeTruthy();
  });

  it("does not warn on non-overlapping allow rules", () => {
    const yaml = `
version: 2026-06-27
trusted_domains: { tier1: [amazon.com], tier2: [target.com] }
rules:
  - name: a
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier1, amount_usd: { max: 100 }, type: one_time }
  - name: b
    do: allow
    rail: virtual_card
    when: { merchant_domain_in: tier2, amount_usd: { min: 101, max: 200 }, type: subscription }
  - name: deny-all
    do: deny
`;

    const { warnings } = loadPolicyFromString(yaml);
    expect(warnings.find((warning) => warning.code === "overlapping_allow")).toBeUndefined();
  });

  it("warns when merchant_signature is used", () => {
    const yaml = `
version: 2026-06-27
rules:
  - name: x
    do: allow
    rail: virtual_card
    when: { merchant_signature: verified }
  - name: deny-all
    do: deny
`;

    const { warnings } = loadPolicyFromString(yaml);
    expect(warnings.find((warning) => warning.code === "unreachable_predicate_card_rail")).toBeTruthy();
  });

  it("rejects require_approval without expires_in at schema layer", () => {
    expect(() =>
      loadPolicyFromString(`
version: 2026-06-27
rules:
  - name: x
    do: require_approval
    approval: { who: user, channel: webhook }
`)
    ).toThrow(/expires_in/);
  });

  it("rejects trusted_domains values that are not hostnames at schema layer", () => {
    expect(() =>
      loadPolicyFromString(`
version: 2026-06-27
trusted_domains: { tier1: [https://amazon.com] }
rules:
  - name: deny-all
    do: deny
`)
    ).toThrow(/hostname|format/);
  });
});
