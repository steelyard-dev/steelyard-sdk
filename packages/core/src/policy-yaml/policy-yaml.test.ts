// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import type { PurchaseIntent } from "../schemas.js";
import { evaluatePolicy, parsePolicyYaml } from "./index.js";
import { domainMatches, normalizeMerchantDomain } from "./index.js";

const intent: PurchaseIntent = {
  merchant: {
    domain: "https://Coffee.Example:443",
    transport_url: "https://Coffee.Example:443/mcp",
    protocol: "mcp"
  },
  offer: { id: "espresso", title: "Espresso", categories: ["coffee"] },
  amount: 450,
  currency: "usd"
};

describe("parsePolicyYaml", () => {
  it("parses strict YAML into normalized policy documents", () => {
    const policy = parsePolicyYaml(`
version: "0.1"
default: deny
rules:
  - name: coffee
    can: buy
    where:
      merchant_domain: ["coffee.example", "*.coffee.example"]
      currency: usd
      amount: { lte: 500 }
limits:
  daily: { usd: 1000 }
`);

    expect(policy.rules[0]).toMatchObject({ name: "coffee", effect: "can", action: "buy" });
    expect(policy.limits.daily?.USD).toBe(1000);
  });

  it("rejects unsupported versions, duplicate keys, anchors, tags, and amount without currency", () => {
    expect(() => parsePolicyYaml('version: "0.2"\ndefault: deny\n')).toThrow(/unsupported policy version/);
    expect(() => parsePolicyYaml('version: "0.1"\ndefault: deny\ndefault: allow\n')).toThrow(/Map keys must be unique/);
    expect(() => parsePolicyYaml('version: "0.1"\ndefault: &d deny\n')).toThrow(/anchors and aliases/);
    expect(() => parsePolicyYaml('%TAG ! tag:example.com,2026:\n---\nversion: "0.1"\ndefault: deny\n')).toThrow(/tags/);
    expect(() => parsePolicyYaml(`
version: "0.1"
default: deny
rules:
  - name: missing-currency
    can: buy
    where:
      amount: { lte: 500 }
`)).toThrow(/where\/currency where.amount requires where.currency/);
  });

  it("rejects oversize files and rules with ambiguous effects", () => {
    expect(() => parsePolicyYaml("x".repeat(1024 * 1024 + 1))).toThrow(/exceeds 1 MB/);
    expect(() => parsePolicyYaml('version: "0.1"\ndefault: deny\nrules: nope\n')).toThrow(/\/rules/);
    expect(() => parsePolicyYaml(`
version: "0.1"
default: deny
rules:
  - name: both
    can: buy
    cannot: buy
`)).toThrow(/exactly one/);
    expect(() => parsePolicyYaml(`
version: "0.1"
default: deny
rules:
  - name: neither
`)).toThrow(/exactly one/);
  });
});

describe("evaluatePolicy", () => {
  it("denies by default and lets matching can rules allow", async () => {
    const deny = parsePolicyYaml('version: "0.1"\ndefault: deny\n');
    await expect(evaluatePolicy([deny], intent)).resolves.toEqual({ status: "denied", reason: "default deny" });

    const allowCoffee = parsePolicyYaml(`
version: "0.1"
default: deny
rules:
  - name: allow coffee
    can: buy
    where: { merchant_domain: coffee.example, currency: USD, amount: { lte: 500 } }
`);
    await expect(evaluatePolicy([allowCoffee], intent)).resolves.toEqual({ status: "allowed", rule: "allow coffee" });
  });

  it("evaluates cannot rules before project and global can rules", async () => {
    const project = parsePolicyYaml(`
version: "0.1"
default: deny
rules:
  - name: project allows coffee
    can: buy
    where: { merchant_domain: coffee.example }
`);
    const global = parsePolicyYaml(`
version: "0.1"
default: deny
rules:
  - name: global blocks coffee
    cannot: buy
    where: { merchant_domain: coffee.example }
`);

    await expect(evaluatePolicy([project, global], intent)).resolves.toEqual({
      status: "denied",
      reason: "blocked by rule 'global blocks coffee'"
    });
  });

  it("returns approval_required above a matching threshold", async () => {
    const policy = parsePolicyYaml(`
version: "0.1"
default: deny
rules:
  - name: coffee with approval
    can: buy
    where: { merchant_domain: coffee.example }
    requires_approval_above: { amount: 400, currency: USD }
`);

    await expect(evaluatePolicy([policy], intent)).resolves.toEqual({
      status: "approval_required",
      threshold: { amount: 400, currency: "USD" },
      matched_rule: "coffee with approval"
    });
  });

  it("requires a vault when non-zero spend limits exist", async () => {
    const policy = parsePolicyYaml(`
version: "0.1"
default: allow
limits:
  daily: { USD: 500 }
`);
    await expect(evaluatePolicy([policy], intent)).resolves.toEqual({
      status: "denied",
      reason: "spend_limits_require_vault"
    });
    await expect(evaluatePolicy([policy], intent, {
      vault: { spendInWindow: async () => ({ pending: 0, captured: 50 }) }
    })).resolves.toEqual({ status: "allowed", rule: "default" });
    await expect(evaluatePolicy([policy], intent, {
      vault: { spendInWindow: async () => ({ pending: 0, captured: 51 }) }
    })).resolves.toEqual({ status: "denied", reason: "daily_limit_exceeded" });
  });

  it("does not match mismatched currency, category, or amount predicates", async () => {
    const policy = parsePolicyYaml(`
version: "0.1"
default: deny
rules:
  - name: wrong currency
    can: buy
    where: { merchant_domain: coffee.example, currency: EUR }
  - name: wrong category
    can: buy
    where: { merchant_domain: coffee.example, offer_category: tea }
  - name: too small
    can: buy
    where: { merchant_domain: coffee.example, currency: USD, amount: { gte: 1000 } }
  - name: outside range
    can: buy
    where: { merchant_domain: coffee.example, currency: USD, amount: { between: [100, 400] } }
`);

    await expect(evaluatePolicy([policy], intent)).resolves.toEqual({ status: "denied", reason: "default deny" });
  });

  it("uses the lowest merged cap across policy documents", async () => {
    const project = parsePolicyYaml(`
version: "0.1"
default: allow
limits:
  weekly: { USD: 1000 }
`);
    const global = parsePolicyYaml(`
version: "0.1"
default: allow
limits:
  weekly: { USD: 500 }
  monthly: { USD: 2000 }
`);

    await expect(evaluatePolicy([project, global], intent, {
      vault: {
        spendInWindow: async (window) =>
          window === "weekly" ? { pending: 0, captured: 51 } : { pending: 0, captured: 0 }
      }
    })).resolves.toEqual({ status: "denied", reason: "weekly_limit_exceeded" });
  });
});

describe("domain normalization", () => {
  it("normalizes transport domains and keeps single-star globs to one segment", async () => {
    expect(normalizeMerchantDomain("https://café.example.:443/path")).toBe("xn--caf-dma.example");
    expect(normalizeMerchantDomain("https://%zz")).toBe("");
    expect(domainMatches("**.github.com", "deep.shop.github.com")).toBe(true);
    expect(domainMatches("**", "anything.example")).toBe(true);

    const policy = parsePolicyYaml(`
version: "0.1"
default: deny
rules:
  - name: subdomain only
    can: buy
    where: { merchant_domain: "*.github.com" }
`);
    const github = { ...intent, merchant: { ...intent.merchant, domain: "github.com" } };
    const shop = { ...intent, merchant: { ...intent.merchant, domain: "shop.github.com" } };

    await Promise.all([
      expect(evaluatePolicy([policy], github)).resolves.toEqual({ status: "denied", reason: "default deny" }),
      expect(evaluatePolicy([policy], shop)).resolves.toEqual({ status: "allowed", rule: "subdomain only" })
    ]);
  });
});
