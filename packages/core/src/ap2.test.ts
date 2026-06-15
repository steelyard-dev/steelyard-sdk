// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import {
  AP2_ERROR_CODES,
  UCP_AP2_CAPABILITY,
  type Ap2ErrorCode,
  type DisclosureClaim,
  type DisclosureTree
} from "./index.js";

describe("AP2 core constants and types", () => {
  it("exports the canonical UCP AP2 capability key (CO5-1)", () => {
    expect(UCP_AP2_CAPABILITY).toBe("dev.ucp.shopping.ap2_mandate");
  });

  it("exports the canonical AP2 mandate error code set (CO5-1)", () => {
    const code: Ap2ErrorCode = "merchant_authorization_missing";

    expect(AP2_ERROR_CODES).toEqual([
      "mandate_required",
      "agent_missing_key",
      "mandate_invalid_signature",
      "mandate_expired",
      "mandate_scope_mismatch",
      "merchant_authorization_invalid",
      "merchant_authorization_missing"
    ]);
    expect(code).toBe("merchant_authorization_missing");
  });

  it("exports disclosure tree types for SD-JWT mandate design (CO5-2)", () => {
    const always: DisclosureClaim = "always";
    const selective: DisclosureClaim = "selective";
    const tree: DisclosureTree = {
      alwaysDisclosed: ["$.checkout.id", "$.checkout.totals"],
      selectivelyDisclosed: ["$.buyer.email"]
    };

    expect(always).toBe("always");
    expect(selective).toBe("selective");
    expect(tree.alwaysDisclosed).toContain("$.checkout.id");
  });
});
