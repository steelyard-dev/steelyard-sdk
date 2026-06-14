// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import { defineCommerce } from "@steelyard/core";
import {
  applyCancelRequest,
  applyCompleteRequest,
  applyCreateRequest,
  applyDiscountsRequest,
  applyUpdateRequest,
  assertValidCheckoutSession,
  assertValidCheckoutSessionCreateRequest,
  assertValidCheckoutSessionWithOrder,
  assertValidDiscountsResponse,
  validateCheckoutSessionCreateRequest,
  validateDiscountsRequest,
  validateDiscountsResponse
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
});
