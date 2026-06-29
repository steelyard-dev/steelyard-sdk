// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import { StripeLiveDisabledError } from "@steelyard-dev/core/stripe";
import {
  Ap2MandateScopeIncomplete,
  STRIPE_TEST_NETWORK_BUSINESS_PROFILE,
  StripeSptScopeMismatch,
  createStripeSptPaymentMandateIssuer,
  stripeSpt
} from "./buyer.js";

const now = new Date("2026-06-16T12:00:00.000Z");
const mandate = {
  iat: Math.floor(now.getTime() / 1000),
  nonce: "payment_nonce_1",
  payment: {
    amount: 1250,
    currency: "USD",
    checkout_id: "checkout_123",
    expires_at: new Date(now.getTime() + 15 * 60_000).toISOString()
  }
};

describe("createStripeSptPaymentMandateIssuer", () => {
  it("mints an SPT scoped to the AP2 payment mandate draft (SI1, SI2, SI4)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const issuer = createStripeSptPaymentMandateIssuer({
      apiKey: "sk_test_unit",
      clock: () => now,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return jsonResponse({
          id: "spt_123",
          expires_at: Math.floor(Date.parse(mandate.payment.expires_at) / 1000),
          max_amount: 1250,
          currency: "usd"
        });
      }
    });

    const first = await issuer.issueMandate(mandate);
    const second = await issuer.issueMandate(mandate);

    expect(first).toMatchObject({
      id: "spt_123",
      max_amount: 1250,
      currency: "USD",
      scope_proof: { type: "stripe_spt_usage_limits" }
    });
    expect(second.scope_proof.idempotency_key).toBe(first.scope_proof.idempotency_key);
    expect(calls).toHaveLength(2);
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("payment_method")).toBe("pm_card_visa");
    expect(body.get("seller_details[network_business_profile]")).toBe(STRIPE_TEST_NETWORK_BUSINESS_PROFILE);
    expect(body.get("usage_limits[max_amount]")).toBe("1250");
    expect(body.get("usage_limits[currency]")).toBe("usd");
  });

  it("rejects live and restricted keys without a bypass flag (SI3)", () => {
    expect(() => createStripeSptPaymentMandateIssuer({ apiKey: "sk_live_unit" })).toThrow(StripeLiveDisabledError);
    expect(() => createStripeSptPaymentMandateIssuer({ apiKey: "rk_test_unit" })).toThrow(StripeLiveDisabledError);
    process.env.STEELYARD_TEST_STRIPE_LIVE_OK = "1";
    expect(() => createStripeSptPaymentMandateIssuer({ apiKey: "sk_live_unit" })).toThrow(StripeLiveDisabledError);
    delete process.env.STEELYARD_TEST_STRIPE_LIVE_OK;
  });

  it("fails before Stripe when mandate scope is incomplete (SI2)", async () => {
    const issuer = createStripeSptPaymentMandateIssuer({
      apiKey: "sk_test_unit",
      clock: () => now,
      fetch: async () => jsonResponse({ id: "spt_123" })
    });

    await expect(issuer.issueMandate({ ...mandate, nonce: "" })).rejects.toThrow(Ap2MandateScopeIncomplete);
    await expect(issuer.issueMandate({ ...mandate, iat: Number.NaN })).rejects.toThrow(Ap2MandateScopeIncomplete);
    await expect(issuer.issueMandate({ ...mandate, payment: undefined as never })).rejects.toThrow(
      Ap2MandateScopeIncomplete
    );
    await expect(
      issuer.issueMandate({ ...mandate, payment: { ...mandate.payment, amount: -1 } })
    ).rejects.toThrow(Ap2MandateScopeIncomplete);
    await expect(
      issuer.issueMandate({ ...mandate, payment: { ...mandate.payment, currency: "usd" } })
    ).rejects.toThrow(Ap2MandateScopeIncomplete);
    await expect(
      issuer.issueMandate({ ...mandate, payment: { ...mandate.payment, checkout_id: "" } })
    ).rejects.toThrow(Ap2MandateScopeIncomplete);
    await expect(
      issuer.issueMandate({ ...mandate, payment: { ...mandate.payment, expires_at: "not-a-date" } })
    ).rejects.toThrow(Ap2MandateScopeIncomplete);
    await expect(
      issuer.issueMandate({ ...mandate, payment: { ...mandate.payment, expires_at: now.toISOString() } })
    ).rejects.toThrow(Ap2MandateScopeIncomplete);
    await expect(
      issuer.issueMandate({
        ...mandate,
        payment: { ...mandate.payment, expires_at: new Date(now.getTime() + 25 * 60 * 60_000).toISOString() }
      })
    ).rejects.toThrow(Ap2MandateScopeIncomplete);
  });

  it("rejects Stripe-returned scope widening (SI2)", async () => {
    const expires = Math.floor(Date.parse(mandate.payment.expires_at) / 1000);
    const cases = [
      { currency: "eur", max_amount: 1250, expires_at: expires },
      { currency: "usd", max_amount: 1251, expires_at: expires },
      { currency: "usd", max_amount: 1250, expires_at: expires + 1 }
    ];

    for (const response of cases) {
      const issuer = createStripeSptPaymentMandateIssuer({
        apiKey: "sk_test_unit",
        clock: () => now,
        fetch: async () => jsonResponse({ id: "spt_123", ...response })
      });
      await expect(issuer.issueMandate(mandate)).rejects.toThrow(StripeSptScopeMismatch);
    }
  });

  it("wraps Stripe SPT as an agent-native wallet instrument", () => {
    const instrument = stripeSpt({
      apiKey: "sk_test_unit",
      clock: () => now,
      fetch: async () => jsonResponse({ id: "spt_123" })
    });

    expect(instrument).toMatchObject({
      mode: "agent-native",
      type: "shared_payment_token",
      label: "Stripe SPT"
    });
    expect(instrument.issuer.instrumentType).toBe("shared_payment_token");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
