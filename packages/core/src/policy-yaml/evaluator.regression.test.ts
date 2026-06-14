// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import type { PurchaseIntent } from "../schemas.js";
import { evaluatePolicy } from "./evaluate.js";
import { parsePolicyYaml } from "./schema.js";

const intent: PurchaseIntent = {
  merchant: { domain: "coffee.example", transport_url: "https://coffee.example/mcp", protocol: "mcp" },
  offer: { id: "latte", title: "Latte", categories: ["coffee"] },
  amount: 20,
  currency: "USD"
};

describe("evaluatePolicy spend limit accounting", () => {
  it("denies when pending plus captured plus requested amount exceeds the cap", async () => {
    const policy = parsePolicyYaml(`
version: "0.1"
default: allow
limits:
  daily: { USD: 100 }
`);

    await expect(
      evaluatePolicy([policy], intent, {
        vault: { spendInWindow: async () => ({ pending: 60, captured: 30 }) }
      })
    ).resolves.toEqual({ status: "denied", reason: "daily_limit_exceeded" });
  });
});
