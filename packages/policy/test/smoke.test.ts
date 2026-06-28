import { describe, expect, it } from "vitest";
import type { Intent } from "../src/index.js";

describe("scaffold", () => {
  it("exports Intent type", () => {
    const intent: Intent = {
      merchant: { domain: "example.com" },
      amount: { amount_minor: 100n, currency: "USD" },
      type: "one_time"
    };

    expect(intent.merchant.domain).toBe("example.com");
  });
});
