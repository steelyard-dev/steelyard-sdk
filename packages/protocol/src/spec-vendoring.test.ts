// Copyright (c) Steelyard contributors. MIT License.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UCP_VERSION } from "./ucp/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("vendored protocol schemas", () => {
  it("ships the ACP checkout schema set required by v0.3", () => {
    const acpSchemaRoot = resolve(packageRoot, "spec/acp/2026-04-17/json-schema");
    const requiredSchemas = [
      "schema.agentic_checkout.json",
      "schema.cart.json",
      "schema.delegate_payment.json",
      "schema.feed.json"
    ];

    expect(requiredSchemas.every((schema) => existsSync(resolve(acpSchemaRoot, schema)))).toBe(true);
  });

  it("uses a single UCP 2026-04-17 runtime schema tree", () => {
    expect(UCP_VERSION).toBe("2026-04-17");
    expect(existsSync(resolve(packageRoot, "spec/ucp/2026-04-08"))).toBe(false);

    const ucpSchemaRoot = resolve(packageRoot, "spec/ucp/2026-04-17/schemas");
    const requiredSchemas = [
      "ucp.json",
      "profile.json",
      "payment_handler.json",
      "shopping/ap2_mandate.json",
      "shopping/buyer_consent.json",
      "shopping/cart.json",
      "shopping/checkout.json",
      "shopping/discount.json",
      "shopping/fulfillment.json",
      "shopping/order.json",
      "shopping/payment.json",
      "shopping/split_payments.json",
      "shopping/types/order_confirmation.json",
      "shopping/types/payment_instrument.json"
    ];

    expect(requiredSchemas.every((schema) => existsSync(resolve(ucpSchemaRoot, schema)))).toBe(true);
  });
});
