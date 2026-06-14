// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import cartBaseSchema from "../../spec/ucp/2026-04-17/schemas/shopping/cart.json";
import checkoutBaseSchema from "../../spec/ucp/2026-04-17/schemas/shopping/checkout.json";
import {
  applyUcpCancel,
  applyUcpComplete,
  applyUcpCreate,
  applyUcpUpdate,
  cartUpdateRequestSchema,
  deriveRequestSchema,
  requestCompleteSchema,
  requestCreateSchema,
  validateSelectedPaymentInstrument,
  validateUcpCheckout,
  validateUcpCompleteRequest,
  validateUcpCreateRequest,
  validateUcpUpdateRequest,
  type JsonSchema
} from "./checkout.js";

const now = new Date("2026-04-17T10:00:00.000Z");
const requestLineItem = { item: { id: "latte" }, quantity: 2 };
const selectedInstrument = {
  id: "pi_1",
  handler_id: "stripe",
  type: "tokenized_card",
  credential: { type: "vault_token", token: "vt_1" },
  selected: true
};

describe("UCP request schema derivation", () => {
  it("derives checkout create/update/complete schemas from ucp_request annotations", () => {
    expect(requestCreateSchema.required).toEqual(["line_items"]);
    expect(requestCreateSchema.properties).not.toHaveProperty("currency");
    expect(requestCreateSchema.properties).not.toHaveProperty("status");
    expect(requestCompleteSchema.required).toEqual(["payment"]);

    expect(validateUcpCreateRequest({ line_items: [requestLineItem] }).valid).toBe(true);
    expect(validateUcpCreateRequest({ line_items: [requestLineItem], status: "incomplete" }).valid).toBe(
      false
    );
    expect(validateUcpCreateRequest({ line_items: [requestLineItem], currency: "USD" }).valid).toBe(
      false
    );
    expect(
      validateUcpCreateRequest({
        line_items: [{ item: { id: "latte", title: "Latte" }, quantity: 1 }]
      }).valid
    ).toBe(false);
    expect(validateUcpUpdateRequest({ buyer: {} }).valid).toBe(false);
  });

  it("derives cart update requirements from the cart schema", () => {
    expect(cartUpdateRequestSchema.required).toEqual(["id", "line_items"]);

    const cartCreate = deriveRequestSchema(cartBaseSchema as JsonSchema, "create");
    expect(cartCreate.required).toEqual(["line_items"]);
    expect(cartCreate.properties).not.toHaveProperty("currency");
  });

  it("keeps unannotated required fields while removing omitted request fields recursively", () => {
    const synthetic = deriveRequestSchema(
      {
        $id: "urn:steelyard:test-request-derivation",
        type: "object",
        required: ["kept", "server", "nested"],
        properties: {
          kept: { type: "string" },
          server: { type: "string", ucp_request: "omit" },
          created: { type: "string", ucp_request: { create: "required", update: "omit" } },
          nested: {
            type: "object",
            required: ["child", "server_child"],
            properties: {
              child: { type: "string" },
              server_child: { type: "string", ucp_request: "omit" }
            }
          }
        }
      },
      "create"
    );

    expect(synthetic.required).toEqual(["kept", "created", "nested"]);
    expect(synthetic.properties?.server).toBeUndefined();
    expect(synthetic.properties?.nested?.required).toEqual(["child"]);
  });
});

describe("UCP checkout wire transitions", () => {
  it("creates and updates spec-valid checkout responses from request-shaped line items", () => {
    const created = applyUcpCreate(
      { line_items: [requestLineItem] },
      { now, checkoutId: "chk_1", currency: "USD" }
    ).next;

    expect(created.status).toBe("ready_for_complete");
    expect(created.currency).toBe("USD");
    expect(created.line_items).toEqual([
      {
        id: "line_1",
        item: { id: "latte", title: "latte", price: 0 },
        quantity: 2,
        totals: [{ type: "total", display_text: "Total", amount: 0 }]
      }
    ]);
    expect(validateUcpCheckout(created).valid).toBe(true);

    const updated = applyUcpUpdate(
      created,
      { line_items: [{ item: { id: "cortado" }, quantity: 1 }] },
      { now }
    ).next;

    expect(updated.line_items).toEqual([
      {
        id: "line_1",
        item: { id: "cortado", title: "cortado", price: 0 },
        quantity: 1,
        totals: [{ type: "total", display_text: "Total", amount: 0 }]
      }
    ]);
    expect(validateUcpCheckout(updated).valid).toBe(true);
  });

  it("completes with a selected payment instrument and order_confirmation shape only", () => {
    const created = applyUcpCreate(
      { line_items: [requestLineItem] },
      { now, checkoutId: "chk_2", currency: "USD" }
    ).next;
    const completeRequest = {
      payment: { instruments: [selectedInstrument] },
      "steelyard.checkout_mandate": "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJidXllciJ9.sig"
    };

    expect(validateUcpCompleteRequest(completeRequest).valid).toBe(true);
    expect(validateSelectedPaymentInstrument(selectedInstrument).valid).toBe(true);
    expect(validateSelectedPaymentInstrument({ id: "pi_1", type: "tokenized_card" }).valid).toBe(
      false
    );

    const completed = applyUcpComplete(created, completeRequest, {
      now,
      mandateOk: { subject_id: "buyer_1", key_id: "key_1" },
      pspResult: { ok: true, psp_payment_id: "charge_1", status: "captured" },
      orderId: "ord_1",
      permalinkUrl: "https://coffee.example/orders/ord_1"
    }).next;

    expect(completed.status).toBe("completed");
    expect(completed.order).toEqual({
      id: "ord_1",
      permalink_url: "https://coffee.example/orders/ord_1"
    });
    expect(completed.order).not.toHaveProperty("status");
    expect(completed.order).not.toHaveProperty("totals");
    expect(validateUcpCheckout(completed).valid).toBe(true);
  });

  it("cancels a checkout without PSP or mandate side effects", () => {
    const created = applyUcpCreate(
      { line_items: [requestLineItem] },
      { now, checkoutId: "chk_3", currency: "USD" }
    ).next;

    const canceled = applyUcpCancel(created, { now }).next;

    expect(canceled.status).toBe("canceled");
    expect(validateUcpCheckout(canceled).valid).toBe(true);
  });

  it("rejects failed PSP completion attempts", () => {
    const created = applyUcpCreate(
      { line_items: [requestLineItem] },
      { now, checkoutId: "chk_4", currency: "USD" }
    ).next;

    expect(() =>
      applyUcpComplete(
        created,
        { payment: { instruments: [selectedInstrument] } },
        {
          now,
          mandateOk: { subject_id: "buyer_1", key_id: "key_1" },
          pspResult: { ok: false, reason: "declined", message: "declined" },
          orderId: "ord_2",
          permalinkUrl: "https://coffee.example/orders/ord_2"
        }
      )
    ).toThrow(/successful PSP capture/);
  });

  it("derives directly from the vendored checkout schema", () => {
    const direct = deriveRequestSchema(checkoutBaseSchema as JsonSchema, "complete");

    expect(direct.required).toEqual(["payment"]);
    expect(direct.properties).not.toHaveProperty("order");
  });
});
