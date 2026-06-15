// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import { defineCommerce } from "@steelyard/core";
import {
  ACP_VERSION,
  ACP_WEBHOOK_SIGNATURE_HEADER,
  applyCancelRequest,
  applyCompleteRequest,
  applyCreateRequest,
  applyDiscountsRequest,
  applyUpdateRequest,
  assertValidAcpDiscovery,
  assertValidCheckoutSession,
  assertValidCheckoutSessionCreateRequest,
  assertValidCheckoutSessionWithOrder,
  assertValidDiscountsResponse,
  buildAcpDiscovery,
  signAcpWebhook,
  validateAcpDiscovery,
  validateCheckoutSessionCreateRequest,
  validateDiscountsRequest,
  validateDiscountsResponse,
  verifyAcpWebhookSignature
} from "./checkout.js";

const manifest = defineCommerce({
  identity: { name: "Acme Coffee", domain: "coffee.example", currencies: ["usd"] },
  offers: [
    {
      id: "latte",
      title: "Latte",
      pricing: [{ kind: "one_time", amount: 500, currency: "usd" }]
    }
  ]
});

const now = new Date("2026-04-17T10:00:00.000Z");
const total = { type: "total", display_text: "Total", amount: 500 };
const requestItem = { id: "latte", name: "Latte", unit_amount: 500 };

describe("ACP checkout wire validators", () => {
  it("builds and validates the ACP well-known discovery document", () => {
    const doc = buildAcpDiscovery({
      apiBaseUrl: "https://coffee.example/acp/",
      supportedCurrencies: ["USD"],
      supportedLocales: ["en-US"]
    });

    expect(doc).toEqual({
      protocol: { name: "acp", version: ACP_VERSION, supported_versions: [ACP_VERSION] },
      api_base_url: "https://coffee.example/acp",
      transports: ["rest"],
      capabilities: {
        services: ["checkout"],
        supported_currencies: ["usd"],
        supported_locales: ["en-US"]
      }
    });
    expect(validateAcpDiscovery(doc).valid).toBe(true);
    expect(() => assertValidAcpDiscovery(doc)).not.toThrow();
    expect(validateAcpDiscovery({ ...doc, api_base_url: "not a url" }).valid).toBe(false);
  });

  it("validates checkout session create requests against the vendored schema", () => {
    const request = { line_items: [requestItem], currency: "USD", capabilities: {} };

    expect(validateCheckoutSessionCreateRequest(request).valid).toBe(true);
    expect(() => assertValidCheckoutSessionCreateRequest(request)).not.toThrow();
    expect(validateCheckoutSessionCreateRequest({ line_items: [requestItem], currency: "USD" }).valid).toBe(
      false
    );
  });

  it("applies create, update, complete, and cancel transitions as pure spec-validated data", () => {
    const created = applyCreateRequest(
      { line_items: [requestItem], currency: "USD", capabilities: {} },
      { manifest, now, sessionId: "cs_1" }
    ).next;

    expect(created.status).toBe("ready_for_payment");
    expect(created.line_items).toEqual([{ id: "latte", item: requestItem, quantity: 1, totals: [total] }]);
    expect(created.totals).toEqual([total]);
    expect(() => assertValidCheckoutSession(created)).not.toThrow();

    const updated = applyUpdateRequest(created, { selected_fulfillment_options: [] }, { now }).next;
    expect(updated.selected_fulfillment_options).toEqual([]);
    expect(() => assertValidCheckoutSession(updated)).not.toThrow();

    const completed = applyCompleteRequest(
      updated,
      {
        payment_data: {
          handler_id: "stripe",
          instrument: {
            type: "vault_token",
            credential: { type: "vault_token", token: "vt_1" }
          }
        }
      },
      { now, pspResult: { ok: true, psp_payment_id: "pi_1", status: "captured" } }
    ).next;

    expect(completed.status).toBe("completed");
    expect(completed.order).toMatchObject({
      id: "order_cs_1",
      checkout_session_id: "cs_1",
      status: "confirmed"
    });
    expect(() => assertValidCheckoutSessionWithOrder(completed)).not.toThrow();

    const canceled = applyCancelRequest(updated, {}, { now }).next;
    expect(canceled.status).toBe("canceled");
    expect(() => assertValidCheckoutSession(canceled)).not.toThrow();
  });

  it("rejects failed PSP completion attempts before creating an order", () => {
    const created = applyCreateRequest(
      { line_items: [requestItem], currency: "USD", capabilities: {} },
      { manifest, now, sessionId: "cs_2" }
    ).next;

    expect(() =>
      applyCompleteRequest(
        created,
        {
          payment_data: {
            handler_id: "stripe",
            instrument: {
              type: "vault_token",
              credential: { type: "vault_token", token: "vt_1" }
            }
          }
        },
        { now, pspResult: { ok: false, reason: "declined", message: "declined" } }
      )
    ).toThrow(/successful PSP capture/);
  });

  it("validates discount requests and responses", () => {
    expect(validateDiscountsRequest({ codes: ["SAVE20"] }).valid).toBe(true);
    expect(validateDiscountsRequest({ codes: [20] }).valid).toBe(false);

    const response = applyDiscountsRequest(manifest, { codes: ["SAVE20"] });
    expect(response.codes).toEqual(["SAVE20"]);
    expect(response.applied).toEqual([]);
    expect(response.rejected).toEqual([
      {
        code: "SAVE20",
        reason: "discount_code_invalid",
        message: "Discount code is not configured"
      }
    ]);
    expect(validateDiscountsResponse(response).valid).toBe(true);
    expect(() => assertValidDiscountsResponse(response)).not.toThrow();
  });

  it("signs and verifies ACP webhooks with Merchant-Signature HMAC", async () => {
    const rawBody = "{\"type\":\"order_create\"}";
    const now = new Date("2026-04-17T10:00:00.000Z");
    const header = await signAcpWebhook({ rawBody, secret: "whsec_test", timestamp: now });

    expect(ACP_WEBHOOK_SIGNATURE_HEADER).toBe("Merchant-Signature");
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    await expect(verifyAcpWebhookSignature({ rawBody, secret: "whsec_test", header, now })).resolves.toMatchObject({
      ok: true,
      timestamp: Math.floor(now.getTime() / 1000)
    });
    await expect(
      verifyAcpWebhookSignature({
        rawBody,
        secret: "whsec_test",
        header,
        now: new Date(now.getTime() + 301_000)
      })
    ).resolves.toEqual({
      ok: false,
      code: "acp_webhook_signature_stale",
      message: "Merchant-Signature timestamp is outside tolerance."
    });
    await expect(
      verifyAcpWebhookSignature({
        rawBody: `${rawBody}\n`,
        secret: "whsec_test",
        header,
        now
      })
    ).resolves.toMatchObject({ ok: false, code: "acp_webhook_signature_invalid" });
    await expect(verifyAcpWebhookSignature({ rawBody, secret: "whsec_test", header: undefined, now })).resolves.toMatchObject({
      ok: false,
      code: "acp_webhook_signature_missing"
    });
    await expect(verifyAcpWebhookSignature({ rawBody, secret: "whsec_test", header: "bad", now })).resolves.toMatchObject({
      ok: false,
      code: "acp_webhook_signature_malformed"
    });
  });
});
