import { describe, expect, it } from "vitest";
import { runPspConformance } from "./conformance.js";
import type { PspAdapter, PspCaptureArgs } from "./index.js";

const success: PspCaptureArgs = {
  vault_token: "vt_test",
  amount: 500,
  currency: "USD",
  metadata: {},
  idempotencyKey: "capture_key",
  session_id: "checkout_1",
  merchant_id: "coffee.example",
  handler_id: "reference",
  instrument_type: "delegated_payment_token"
};

describe("runPspConformance", () => {
  it("validates adapter capabilities", async () => {
    const adapter: PspAdapter = {
      name: "test-psp",
      capabilities: [{ handlerId: "reference", instrumentType: "delegated_payment_token" }],
      supportsHandler: (handlerId) => handlerId === "reference",
      capture: async () => ({
        ok: true,
        psp_payment_id: "pi_test",
        status: "captured"
      }),
      cancel: async () => {}
    };

    const report = await runPspConformance(adapter, {
      success,
      unsupportedHandlerId: "stripe"
    });

    expect(report.failed).toBe(0);
  });
});
