// Copyright (c) Steelyard contributors. MIT License.
import type { PaymentIssuerMandateDraft, PspCaptureArgs } from "@steelyard/psp";
import { runIssuerConformance, runPspConformance } from "@steelyard/psp/conformance";
import { describe, expect, it } from "vitest";
import {
  TEMPLATE_HANDLER_ID,
  TEMPLATE_INSTRUMENT_TYPE,
  createTemplateIssuer,
  createTemplatePsp
} from "./index.js";

const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

describe("template PSP adapter", () => {
  it("passes the Steelyard PSP and issuer conformance kit", async () => {
    const issuer = createTemplateIssuer();
    const draft = mandateDraft();
    const handle = await issuer.mintForMandate(draft);
    const success = captureArgs({ vault_token: handle.id });

    const pspReport = await runPspConformance(createTemplatePsp(), {
      success,
      unsupportedHandlerId: "stripe",
      mismatch: {
        ...success,
        amount: success.amount + 1,
        idempotencyKey: "idem_template_mismatch"
      }
    });
    expect(pspReport.failed).toBe(0);

    const issuerReport = await runIssuerConformance(issuer, {
      draft,
      incompleteDraft: { ...draft, merchant_id: undefined }
    });
    expect(issuerReport.failed).toBe(0);
  });
});

function mandateDraft(): PaymentIssuerMandateDraft {
  return {
    iat: Math.floor(Date.now() / 1000),
    nonce: "nonce_template",
    merchant_id: "https://merchant.example/.well-known/ucp",
    handler_id: TEMPLATE_HANDLER_ID,
    instrument_type: TEMPLATE_INSTRUMENT_TYPE,
    transaction_id: "checkout_template",
    payment: {
      amount: 500,
      currency: "USD",
      checkout_id: "checkout_template",
      expires_at: expiresAt
    }
  };
}

function captureArgs(overrides: Partial<PspCaptureArgs> = {}): PspCaptureArgs {
  return {
    vault_token: "tpl_missing",
    amount: 500,
    currency: "USD",
    metadata: { purchase_key: "purchase_template" },
    idempotencyKey: "idem_template_ok",
    session_id: "checkout_template",
    merchant_id: "https://merchant.example/.well-known/ucp",
    handler_id: TEMPLATE_HANDLER_ID,
    instrument_type: TEMPLATE_INSTRUMENT_TYPE,
    ...overrides
  };
}
