import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PurchaseIntent } from "@steelyard/core";
import { BuyerPolicy, _resetPermissiveWarningForTests } from "./index.js";

const originalCwd = process.cwd();

const intent: PurchaseIntent = {
  merchant: { domain: "coffee.example", transport_url: "https://coffee.example/mcp", protocol: "mcp" },
  offer: { id: "latte", title: "Latte", categories: ["coffee"] },
  amount: 500,
  currency: "USD"
};

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  _resetPermissiveWarningForTests();
});

describe("BuyerPolicy.load", () => {
  it("throws when no policy file exists unless permissive mode is explicit", async () => {
    const missing = ["/tmp/steelyard-missing-policy.yml"];
    await expect(BuyerPolicy.load({ paths: missing })).rejects.toThrow(/no policy file found/);

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const policy = await BuyerPolicy.load({ paths: missing, allowMissingPolicy: true });

    expect(policy.isPermissive).toBe(true);
    await expect(policy.evaluate(intent)).resolves.toEqual({ status: "allowed", rule: "no-policy-permissive" });
    expect(stderr).toHaveBeenCalledTimes(1);

    await BuyerPolicy.load({ paths: missing, allowMissingPolicy: true });
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("loads explicit paths and exposes rules, limits, and evaluation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steelyard-policy-"));
    const policyPath = join(dir, "policy.yml");
    await writeFile(policyPath, `
version: "0.1"
default: deny
rules:
  - name: allow coffee
    can: buy
    where: { merchant_domain: coffee.example }
limits:
  daily: { USD: 1000 }
`);

    const policy = await BuyerPolicy.load({ paths: [join(dir, "missing.yml"), policyPath] });

    expect(policy.isPermissive).toBe(false);
    expect(policy.rules.map((rule) => rule.name)).toEqual(["allow coffee"]);
    expect(policy.limits.daily?.USD).toBe(1000);
    await expect(policy.evaluate(intent, {
      vault: { spendInWindow: async () => 0 }
    })).resolves.toEqual({ status: "allowed", rule: "allow coffee" });
  });

  it("loadProject reads only the project policy location", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steelyard-policy-"));
    await mkdir(join(dir, ".steelyard"));
    await writeFile(join(dir, ".steelyard", "policy.yml"), 'version: "0.1"\ndefault: allow\n');
    process.chdir(dir);

    const project = await BuyerPolicy.loadProject();

    await expect(project.evaluate(intent)).resolves.toEqual({ status: "allowed", rule: "default" });
  });
});
