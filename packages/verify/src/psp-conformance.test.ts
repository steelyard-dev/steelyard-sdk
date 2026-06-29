// Copyright (c) Steelyard contributors. MIT License.
import type { EcJwk, PaymentMandateRequest } from "@steelyard-dev/core";
import { createReferencePaymentMandateIssuer } from "@steelyard-dev/buyer";
import { mockPsp, referencePsp, stripePsp, type PspCaptureArgs } from "@steelyard-dev/merchant/psp";
import { runMandateIssuerConformance, runPspConformance } from "@steelyard-dev/psp/conformance";
import { describe, expect, it } from "vitest";

const now = new Date("2026-06-14T12:00:00.000Z");
const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();

describe("@steelyard-dev/psp conformance", () => {
  it("passes the first-party mock and Stripe merchant adapters", async () => {
    const mockReport = await runPspConformance(mockPsp({ handlerIds: ["mock"], seed: "conformance" }), {
      success: captureArgs({ handler_id: "mock", instrument_type: "vault_token", idempotencyKey: "idem_mock_ok" }),
      unsupportedHandlerId: "missing"
    });
    expect(mockReport.failed).toBe(0);

    const stripeReport = await runPspConformance(stripePsp({
      apiKey: "sk_test_conformance",
      fetch: stripeFetch,
      clock: () => now
    }), {
      success: captureArgs({
        vault_token: "pm_card_visa",
        handler_id: "stripe",
        instrument_type: "shared_payment_token",
        idempotencyKey: "idem_stripe_ok"
      }),
      unsupportedHandlerId: "reference",
      failures: [
        {
          id: "declined",
          args: captureArgs({
            vault_token: "pm_card_visa",
            handler_id: "stripe",
            instrument_type: "shared_payment_token",
            idempotencyKey: "idem_stripe_declined"
          }),
          expectedReason: "declined"
        }
      ]
    });
    expect(stripeReport.failed).toBe(0);
  });

  it("passes the first-party reference PSP and issuer", async () => {
    const issuer = createReferencePaymentMandateIssuer({ signingKey: referencePrivateKey, clock: () => now });
    const draft = mandateDraft();
    const handle = await issuer.issueMandate(draft);
    const psp = referencePsp({ signingKey: referencePublicKey, clock: () => now });
    const success = captureArgs({
      vault_token: handle.id,
      handler_id: "reference",
      instrument_type: "delegated_payment_token",
      idempotencyKey: "idem_reference_ok"
    });
    const mismatch = captureArgs({
      ...success,
      amount: 501,
      idempotencyKey: "idem_reference_mismatch"
    });

    const pspReport = await runPspConformance(psp, {
      success,
      unsupportedHandlerId: "stripe",
      mismatch
    });
    expect(pspReport.failed).toBe(0);

    const issuerReport = await runMandateIssuerConformance(issuer, {
      draft,
      incompleteDraft: { ...draft, merchant_id: undefined }
    });
    expect(issuerReport.failed).toBe(0);
  });
});

function captureArgs(overrides: Partial<PspCaptureArgs> = {}): PspCaptureArgs {
  return {
    vault_token: "vt_conformance",
    amount: 500,
    currency: "USD",
    metadata: { purchase_key: "purchase_conformance" },
    idempotencyKey: "idem_conformance",
    session_id: "checkout_conformance",
    merchant_id: "https://coffee.example/.well-known/ucp",
    ...overrides
  };
}

function mandateDraft(): PaymentMandateRequest {
  return {
    iat: Math.floor(now.getTime() / 1000),
    nonce: "payment_nonce_conformance",
    merchant_id: "https://coffee.example/.well-known/ucp",
    handler_id: "reference",
    instrument_type: "delegated_payment_token",
    transaction_id: "checkout_conformance",
    payment: {
      amount: 500,
      currency: "USD",
      checkout_id: "checkout_conformance",
      expires_at: expiresAt
    }
  };
}

async function stripeFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
  const idempotencyKey = String(new Headers(init?.headers).get("idempotency-key") ?? "");
  if (body.get("amount") !== "500") return json({ error: { code: "amount_exceeded", message: "amount mismatch" } }, 402);
  if (body.get("currency") !== "usd") return json({ error: { code: "currency_invalid", message: "currency mismatch" } }, 402);
  if (idempotencyKey.includes("declined")) {
    return json({ error: { code: "card_declined", message: "declined by conformance fixture" } }, 402);
  }
  return json({ id: `pi_${idempotencyKey}`, status: "succeeded" });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

const referencePublicKey = {
  kid: "reference-p256",
  kty: "EC",
  crv: "P-256",
  x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
  use: "sig",
  alg: "ES256"
} satisfies EcJwk;

const referencePrivateKey = {
  ...referencePublicKey,
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
} satisfies EcJwk;
