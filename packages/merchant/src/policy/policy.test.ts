// Copyright (c) Steelyard contributors. MIT License.
import { mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PurchaseIntent } from "@steelyard-dev/core";
import { MerchantPolicy, MerchantPolicyMissing } from "./index.js";

const intent: PurchaseIntent = {
  merchant: { domain: "coffee.example", transport_url: "https://coffee.example/ucp", protocol: "ucp" },
  offer: { id: "latte", title: "Latte", categories: ["coffee"] },
  amount: 500,
  currency: "USD"
};

describe("MerchantPolicy.load", () => {
  it("throws MerchantPolicyMissing when the policy file is absent", async () => {
    await expect(MerchantPolicy.load({ path: "/tmp/steelyard-missing-merchant-policy.yml" })).rejects.toBeInstanceOf(
      MerchantPolicyMissing
    );
  });

  it("does not cache across load calls", async () => {
    await withPolicyFile(async (path) => {
      await writePolicy(path, allowPolicy("allow coffee"));
      const allow = await MerchantPolicy.load({ path });
      await expect(allow.evaluate(intent)).resolves.toEqual({ status: "allowed", rule: "allow coffee" });

      await writePolicy(path, denyPolicy());
      const deny = await MerchantPolicy.load({ path });
      await expect(deny.evaluate(intent)).resolves.toEqual({ status: "denied", reason: "default deny" });
    });
  });

  it("uses the default merchant policy path when no path is supplied", async () => {
    const originalHome = process.env.HOME;
    const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-policy-home-"));
    process.env.HOME = root;
    try {
      await expect(MerchantPolicy.load()).rejects.toMatchObject({
        name: "MerchantPolicyMissing",
        path: join(root, ".steelyard", "merchant-policy.yml")
      });
    } finally {
      process.env.HOME = originalHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws parse errors when the initial policy file is invalid", async () => {
    await withPolicyFile(async (path) => {
      await writePolicy(path, 'version: "0.1"\ndefault:');

      await expect(MerchantPolicy.load({ path })).rejects.toThrow(/default/);
    });
  });
});

describe("MerchantPolicy.fromPath", () => {
  it("caches parsed policy while mtime is unchanged and reparses after mtime changes", async () => {
    await withPolicyFile(async (path) => {
      const stable = new Date("2026-04-17T10:00:00.000Z");
      const changed = new Date("2026-04-17T10:00:02.000Z");
      await writePolicy(path, allowPolicy("allow coffee"));
      await utimes(path, stable, stable);

      const policy = MerchantPolicy.fromPath(path);
      expect(policy.rules).toEqual([]);
      await expect(policy.evaluate(intent)).resolves.toEqual({ status: "allowed", rule: "allow coffee" });

      await writePolicy(path, denyPolicy());
      await utimes(path, stable, stable);
      await expect(policy.evaluate(intent)).resolves.toEqual({ status: "allowed", rule: "allow coffee" });

      await utimes(path, changed, changed);
      await expect(policy.evaluate(intent)).resolves.toEqual({ status: "denied", reason: "default deny" });
    });
  });

  it("throws MerchantPolicyMissing when a hot-loaded policy is deleted", async () => {
    await withPolicyFile(async (path) => {
      await writePolicy(path, allowPolicy("allow coffee"));
      const policy = MerchantPolicy.fromPath(path);
      await expect(policy.evaluate(intent)).resolves.toEqual({ status: "allowed", rule: "allow coffee" });

      await unlink(path);
      await expect(policy.evaluate(intent)).rejects.toBeInstanceOf(MerchantPolicyMissing);
    });
  });

  it("keeps the previous consistent snapshot while a changed file is not parseable", async () => {
    await withPolicyFile(async (path) => {
      const first = new Date("2026-04-17T10:00:00.000Z");
      const partial = new Date("2026-04-17T10:00:01.000Z");
      const final = new Date("2026-04-17T10:00:02.000Z");
      await writePolicy(path, allowPolicy("allow coffee"));
      await utimes(path, first, first);

      const policy = MerchantPolicy.fromPath(path);
      await expect(policy.evaluate(intent)).resolves.toEqual({ status: "allowed", rule: "allow coffee" });

      await writePolicy(path, 'version: "0.1"\ndefault:');
      await utimes(path, partial, partial);
      await expect(policy.evaluate(intent)).resolves.toEqual({ status: "allowed", rule: "allow coffee" });

      await writePolicy(path, denyPolicy());
      await utimes(path, final, final);
      await expect(policy.evaluate(intent)).resolves.toEqual({ status: "denied", reason: "default deny" });
    });
  });

  it("exposes rules, limits, and vault-backed spend-limit evaluation", async () => {
    await withPolicyFile(async (path) => {
      await writePolicy(path, `
version: "0.1"
default: allow
rules:
  - name: allow coffee
    can: buy
    where: { merchant_domain: coffee.example }
limits:
  daily: { USD: 600 }
`);
      const policy = await MerchantPolicy.load({ path });

      expect(policy.rules.map((rule) => rule.name)).toEqual(["allow coffee"]);
      expect(policy.limits.daily?.USD).toBe(600);
      await expect(policy.evaluate(intent, {
        vault: { spendInWindow: async () => ({ pending: 0, captured: 200 }) }
      })).resolves.toEqual({ status: "denied", reason: "daily_limit_exceeded" });
    });
  });
});

async function withPolicyFile(fn: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "steelyard-merchant-policy-"));
  try {
    await fn(join(root, "merchant-policy.yml"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePolicy(path: string, raw: string): Promise<void> {
  await writeFile(path, raw.trimStart());
}

function allowPolicy(ruleName: string): string {
  return `
version: "0.1"
default: deny
rules:
  - name: ${ruleName}
    can: buy
    where: { merchant_domain: coffee.example }
`;
}

function denyPolicy(): string {
  return `
version: "0.1"
default: deny
`;
}
