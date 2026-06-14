// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import {
  canonicalMerchantAudience,
  canonicalizeForSigning,
  newIdempotencyKey,
  rawCardFromSimple,
  redactCardData,
  totalAmount,
  type PurchaseIntent
} from "./index.js";

describe("purchase helpers", () => {
  it("preserves the v0.2 nested PurchaseIntent shape", () => {
    const intent: PurchaseIntent = {
      merchant: {
        domain: "coffee.example",
        declared_domain: "coffee.example",
        transport_url: "https://coffee.example/mcp",
        protocol: "mcp"
      },
      offer: { id: "latte", title: "Latte", categories: ["coffee"] },
      amount: 500,
      currency: "USD",
      intent_id: "intent_123"
    };

    expect(intent.merchant.transport_url).toBe("https://coffee.example/mcp");
    expect(intent.amount).toBe(500);
  });

  it("generates UUIDv7 idempotency keys", () => {
    const key = newIdempotencyKey();

    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("reads the unique total amount and fails closed on malformed totals", () => {
    expect(totalAmount([{ type: "subtotal", amount: 300 }, { type: "total", amount: 450 }])).toBe(450);
    expect(() => totalAmount([{ type: "subtotal", amount: 300 }])).toThrow(/exactly one total/);
    expect(() => totalAmount([{ type: "total", amount: 1 }, { type: "total", amount: 2 }])).toThrow(/exactly one total/);
    expect(() => totalAmount([{ type: "total", amount: 1.5 }])).toThrow(/safe integer/);
  });

  it("canonicalizes merchant audiences to origin plus discovery path", () => {
    expect(
      canonicalMerchantAudience({
        id: "merchant_123",
        protocol: "ucp",
        discoveryUrl: "https://Coffee.Example/.well-known/ucp?ignored=true"
      })
    ).toBe("https://coffee.example/.well-known/ucp");
    expect(
      canonicalMerchantAudience({
        id: "merchant_123",
        protocol: "ucp",
        baseUrl: "https://coffee.example/shop",
        discoveryPath: ".well-known/ucp.json"
      })
    ).toBe("https://coffee.example/.well-known/ucp.json");
  });

  it("sorts object keys and omits undefined values for signing canonicalization", () => {
    expect(canonicalizeForSigning({
      z: 1,
      a: { c: true, b: undefined, a: "first" },
      list: [{ b: 2, a: 1 }]
    })).toEqual({
      a: { a: "first", c: true },
      list: [{ a: 1, b: 2 }],
      z: 1
    });
    expect(() => canonicalizeForSigning({ bad: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalizeForSigning({ bad: Symbol("x") })).toThrow(/symbol/);
  });

  it("redacts PANs and CVCs from thrown or logged strings", () => {
    expect(redactCardData("pan=4242 4242 4242 4242 cvc=123")).toBe(
      "pan=[REDACTED_PAN] cvc=[REDACTED_CVC]"
    );
    expect(redactCardData('{"card_number":"5555555555554444","cvv":"999"}')).toBe(
      '{"card_number":"[REDACTED_PAN]","cvv":"[REDACTED_CVC]"}'
    );
  });

  it("builds a RawCard from SimpleCard plus metadata", () => {
    expect(
      rawCardFromSimple(
        { number: "4242 4242 4242 4242", exp: "12/30", name: "Ada", cvc: "123" },
        { id: "card_1", name_on_card: "Ada", exp: "12/30", brand: "visa", last4: "4242", tags: [] }
      )
    ).toEqual({
      id: "card_1",
      name_on_card: "Ada",
      exp: "12/30",
      brand: "visa",
      last4: "4242",
      tags: [],
      pan: "4242424242424242",
      cvc: "123"
    });
  });
});
