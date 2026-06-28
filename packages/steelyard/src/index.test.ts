import { describe, expect, it } from "vitest";
import {
  PolicyEngine,
  Wallet,
  createCheckoutServer,
  createCommerceReadHandler,
  createPolicyEngine,
  referenceMandate,
  stripeSpt,
  vaultedCard
} from "./index.js";

describe("steelyard front-door exports", () => {
  it("exports the developer-facing DX names", () => {
    expect(Wallet).toBeTypeOf("function");
    expect(createCommerceReadHandler).toBeTypeOf("function");
    expect(createCheckoutServer).toBeTypeOf("function");
    expect(PolicyEngine).toBeTypeOf("function");
    expect(createPolicyEngine).toBeTypeOf("function");
    expect(referenceMandate).toBeTypeOf("function");
    expect(stripeSpt).toBeTypeOf("function");
    expect(vaultedCard).toBeTypeOf("function");
  });
});
