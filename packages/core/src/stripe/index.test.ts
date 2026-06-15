// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import {
  STRIPE_API_VERSION,
  STRIPE_LIVE_DISABLED_CODE,
  StripeLiveDisabledError,
  StripeSptMintError,
  chargeSharedPaymentToken,
  mintSharedPaymentToken
} from "./index.js";

describe("Stripe SPT primitives", () => {
  it("mints a Shared Payment Token with preview headers and form fields (SP1, SP4)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const result = await mintSharedPaymentToken({
      apiKey: "sk_test_unit",
      apiBaseUrl: "https://stripe.test",
      paymentMethod: "pm_card_visa",
      sellerProfile: "profile_test_61TU90nIeGjU7NNVXA6TU90m7ISQWsBxpcx9lASWWXTk",
      usageLimits: { currency: "USD", maxAmount: 1250, expiresAt: 1_782_000_000 },
      idempotencyKey: "mint_1",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return jsonResponse({
          id: "spt_123",
          expires_at: 1_782_000_000,
          max_amount: 1250,
          currency: "usd"
        });
      }
    });

    expect(result).toEqual({ id: "spt_123", expires_at: 1_782_000_000, max_amount: 1250, currency: "USD" });
    expect(calls[0]!.url).toBe("https://stripe.test/v1/shared_payment/issued_tokens");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(headers["Stripe-Version"]).toBe(STRIPE_API_VERSION);
    expect(headers["Idempotency-Key"]).toBe("mint_1");
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("payment_method")).toBe("pm_card_visa");
    expect(body.get("seller_details[network_business_profile]")).toBe(
      "profile_test_61TU90nIeGjU7NNVXA6TU90m7ISQWsBxpcx9lASWWXTk"
    );
    expect(body.get("usage_limits[currency]")).toBe("usd");
    expect(body.get("usage_limits[expires_at]")).toBe("1782000000");
    expect(body.get("usage_limits[max_amount]")).toBe("1250");
  });

  it("rejects live and restricted keys for v0.6 SPT work (SP1, SI3)", async () => {
    await expect(
      mintSharedPaymentToken({
        apiKey: "sk_live_secret",
        paymentMethod: "pm_card_visa",
        sellerProfile: "profile_test",
        usageLimits: { currency: "USD", maxAmount: 1250, expiresAt: 1_782_000_000 },
        idempotencyKey: "mint_1"
      })
    ).rejects.toMatchObject({ code: STRIPE_LIVE_DISABLED_CODE });

    await expect(
      mintSharedPaymentToken({
        apiKey: "rk_test_restricted",
        paymentMethod: "pm_card_visa",
        sellerProfile: "profile_test",
        usageLimits: { currency: "USD", maxAmount: 1250, expiresAt: 1_782_000_000 },
        idempotencyKey: "mint_1"
      })
    ).rejects.toBeInstanceOf(StripeLiveDisabledError);
  });

  it("redacts Stripe secrets from mint errors (SP1, SP3)", async () => {
    const secret = "sk_test_secret_123";
    await expect(
      mintSharedPaymentToken({
        apiKey: secret,
        apiBaseUrl: "https://stripe.test",
        paymentMethod: "pm_card_visa",
        sellerProfile: "profile_test",
        usageLimits: { currency: "USD", maxAmount: 1250, expiresAt: 1_782_000_000 },
        idempotencyKey: "mint_1",
        fetch: async () =>
          jsonResponse({ error: { code: "invalid_request_error", message: `bad key ${secret}` } }, 400)
      })
    ).rejects.toThrow(/\[redacted\]/);
  });

  it("validates mint arguments before network calls (SP1)", async () => {
    const base = {
      apiKey: "sk_test_unit",
      paymentMethod: "pm_card_visa",
      sellerProfile: "profile_test",
      usageLimits: { currency: "USD", maxAmount: 1250, expiresAt: new Date("2026-06-16T00:00:00Z") },
      idempotencyKey: "mint_1",
      fetch: async () => jsonResponse({ id: "spt_123" })
    };

    await expect(mintSharedPaymentToken({ ...base, sellerProfile: "" })).rejects.toThrow(/sellerProfile/);
    await expect(
      mintSharedPaymentToken({ ...base, usageLimits: { ...base.usageLimits, maxAmount: -1 } })
    ).rejects.toThrow(/maxAmount/);
    await expect(
      mintSharedPaymentToken({ ...base, usageLimits: { ...base.usageLimits, expiresAt: "not-a-date" } })
    ).rejects.toThrow(/expiresAt/);
    await expect(mintSharedPaymentToken({ ...base, idempotencyKey: "" })).rejects.toThrow(/idempotencyKey/);
    await expect(
      mintSharedPaymentToken({
        ...base,
        fetch: async () => {
          throw new Error("network down for sk_test_unit");
        }
      })
    ).rejects.toThrow(/network down for \[redacted\]/);
    await expect(
      mintSharedPaymentToken({ ...base, fetch: async () => jsonResponse({ id: "tok_123" }) })
    ).rejects.toThrow(/spt_/);
  });

  it("charges an SPT with payment_method_data[shared_payment_granted_token] (SP2)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const result = await chargeSharedPaymentToken({
      apiKey: "sk_test_unit",
      apiBaseUrl: "https://stripe.test",
      sptId: "spt_123",
      amount: 1250,
      currency: "USD",
      idempotencyKey: "charge_1",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return jsonResponse({
          id: "pi_123",
          status: "succeeded",
          charges: { data: [{ id: "ch_123", status: "succeeded" }] }
        });
      }
    });

    expect(result).toEqual({
      ok: true,
      psp_payment_id: "pi_123",
      psp_charge_id: "ch_123",
      psp_charge_status: "succeeded",
      status: "captured"
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Stripe-Version"]).toBe(STRIPE_API_VERSION);
    expect(headers["Idempotency-Key"]).toBe("charge_1");
    const body = calls[0]!.init.body as URLSearchParams;
    expect(body.get("payment_method_data[shared_payment_granted_token]")).toBe("spt_123");
    expect(body.get("confirm")).toBe("true");
  });

  it("maps SPT-specific Stripe failures (SP2, SP3)", async () => {
    await expect(
      chargeSharedPaymentToken({
        apiKey: "sk_test_unit",
        sptId: "spt_123",
        amount: 1250,
        currency: "USD",
        idempotencyKey: "charge_1",
        fetch: async () => jsonResponse({ error: { code: "spt_max_amount_exceeded", message: "too much" } }, 402)
      })
    ).resolves.toEqual({ ok: false, reason: "amount_exceeded", message: "too much" });

    await expect(
      chargeSharedPaymentToken({
        apiKey: "sk_test_unit",
        sptId: "spt_123",
        amount: 1250,
        currency: "USD",
        idempotencyKey: "charge_2",
        fetch: async () => jsonResponse({ error: { code: "spt_revoked", message: "revoked" } }, 402)
      })
    ).resolves.toEqual({ ok: false, reason: "spt_revoked", message: "revoked" });
  });

  it("validates SPT input shape before network calls (SP2)", async () => {
    await expect(
      chargeSharedPaymentToken({
        apiKey: "sk_test_unit",
        sptId: "pm_card_visa",
        amount: 1250,
        currency: "USD",
        idempotencyKey: "charge_1"
      })
    ).rejects.toThrow(/sptId/);
    await expect(
      mintSharedPaymentToken({
        apiKey: "sk_test_unit",
        paymentMethod: "card",
        sellerProfile: "profile_test",
        usageLimits: { currency: "USD", maxAmount: 1250, expiresAt: 1_782_000_000 },
        idempotencyKey: "mint_1"
      })
    ).rejects.toBeInstanceOf(StripeSptMintError);
    await expect(
      chargeSharedPaymentToken({
        apiKey: "sk_test_unit",
        sptId: "spt_123",
        amount: -1,
        currency: "USD",
        idempotencyKey: "charge_1"
      })
    ).rejects.toThrow(/amount/);
    await expect(
      chargeSharedPaymentToken({
        apiKey: "sk_test_unit",
        sptId: "spt_123",
        amount: 1250,
        currency: "usd",
        idempotencyKey: "charge_1"
      })
    ).rejects.toThrow(/currency/);
    await expect(
      chargeSharedPaymentToken({
        apiKey: "sk_test_unit",
        sptId: "spt_123",
        amount: 1250,
        currency: "USD",
        idempotencyKey: ""
      })
    ).rejects.toThrow(/idempotencyKey/);
    await expect(
      chargeSharedPaymentToken({
        apiKey: "sk_test_unit",
        sptId: "spt_123",
        amount: 1250,
        currency: "USD",
        idempotencyKey: "charge_1",
        fetch: async () => {
          throw new Error("network down sk_test_unit");
        }
      })
    ).rejects.toThrow(/network down \[redacted\]/);
  });

  it("maps non-SPT Stripe charge states and failures (SP2, SP3)", async () => {
    await expect(
      chargeSharedPaymentToken({
        apiKey: "sk_test_unit",
        sptId: "spt_123",
        amount: 1250,
        currency: "USD",
        idempotencyKey: "charge_auth",
        fetch: async () => jsonResponse({ id: "pi_auth", status: "requires_capture", latest_charge: "ch_auth" })
      })
    ).resolves.toEqual({ ok: true, psp_payment_id: "pi_auth", psp_charge_id: "ch_auth", status: "authorized" });

    await expect(
      chargeSharedPaymentToken({
        apiKey: "sk_test_unit",
        sptId: "spt_123",
        amount: 1250,
        currency: "USD",
        idempotencyKey: "charge_action",
        fetch: async () =>
          jsonResponse({
            id: "pi_action",
            status: "requires_action",
            next_action: { redirect_to_url: { url: "https://stripe.test/auth" } }
          })
      })
    ).resolves.toEqual({ ok: false, requires_authentication: true, continue_url: "https://stripe.test/auth" });

    const cases = [
      ["card_declined", { ok: false, reason: "declined", message: "declined" }],
      ["expired_card", { ok: false, reason: "expired_card", message: "expired" }],
      ["insufficient_funds", { ok: false, reason: "insufficient_funds", message: "funds" }],
      ["spt_expired", { ok: false, reason: "spt_expired", message: "expired" }],
      ["spt_seller_mismatch", { ok: false, reason: "spt_seller_mismatch", message: "seller" }],
      ["other", { ok: false, reason: "other", message: "other" }]
    ] as const;
    for (const [code, expected] of cases) {
      await expect(
        chargeSharedPaymentToken({
          apiKey: "sk_test_unit",
          sptId: "spt_123",
          amount: 1250,
          currency: "USD",
          idempotencyKey: `charge_${code}`,
          fetch: async () => jsonResponse({ error: { code, message: expected.message } }, 402)
        })
      ).resolves.toEqual(expected);
    }

    await expect(
      chargeSharedPaymentToken({
        apiKey: "sk_test_unit",
        sptId: "spt_123",
        amount: 1250,
        currency: "USD",
        idempotencyKey: "charge_requires_authentication",
        fetch: async () =>
          jsonResponse({
            error: {
              code: "requires_authentication",
              payment_intent: { next_action: { redirect_to_url: { url: "https://stripe.test/3ds" } } }
            }
          }, 402)
      })
    ).resolves.toEqual({ ok: false, requires_authentication: true, continue_url: "https://stripe.test/3ds" });

    await expect(
      chargeSharedPaymentToken({
        apiKey: "sk_test_unit",
        sptId: "spt_123",
        amount: 1250,
        currency: "USD",
        idempotencyKey: "charge_unknown_status",
        fetch: async () => jsonResponse({ id: "pi_unknown", status: "processing" })
      })
    ).resolves.toEqual({ ok: false, reason: "other", message: "Stripe returned status processing" });
  });

});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
