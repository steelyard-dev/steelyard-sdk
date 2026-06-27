// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import {
  COMMERCE_READ_VERSION,
  defineCommerce,
  ERROR_CODES,
  validate,
  type ErrorCode,
  type Manifest,
  type Offer,
  type Policies
} from "./index.js";

const baseConfig = {
  identity: {
    name: "Acme Coffee",
    domain: "acme.example",
    description: "Coffee beans and espresso drinks.",
    logoUrl: "https://acme.example/logo.png",
    locale: "en-US",
    currencies: ["usd"]
  },
  offers: [
    {
      id: "double",
      title: "Double Espresso",
      description: "Two shots.",
      images: ["javascript:bad", "https://acme.example/double.png"],
      url: "https://acme.example/products/double",
      kind: "product" as const,
      categories: ["espresso"],
      attributes: { size: "double", hot: true, shots: 2, tags: ["coffee", "espresso"] },
      availability: "in_stock" as const,
      pricing: [{ kind: "one_time" as const, amount: 400, currency: "usd" }]
    },
    {
      id: "single",
      title: "Single Espresso",
      pricing: [{ kind: "one_time" as const, amount: 300, currency: "GBP" }]
    }
  ],
  policies: [
    {
      type: "returns" as const,
      url: "https://acme.example/returns",
      summary: "Refunds within 30 days."
    }
  ]
};

describe("defineCommerce", () => {
  it("returns a validated manifest with canonical offers and normalized currencies", () => {
    const manifest = defineCommerce(baseConfig);

    expect(manifest.schemaVersion).toBe(COMMERCE_READ_VERSION);
    expect(manifest.identity.currencies).toEqual(["USD"]);
    expect(manifest.catalog.offers.map((offer) => offer.id)).toEqual(["double", "single"]);
    expect(manifest.catalog.offers[0]!.images).toEqual(["https://acme.example/double.png"]);
    expect(manifest.catalog.offers[0]!.pricing[0]).toEqual({
      kind: "one_time",
      amount: 400,
      currency: "USD"
    });
    expect(manifest.catalog.offers[1]!.pricing[0]).toEqual({
      kind: "one_time",
      amount: 300,
      currency: "GBP"
    });
    expect(manifest.policies[0]).toEqual({
      type: "returns",
      url: "https://acme.example/returns",
      summary: "Refunds within 30 days."
    });
  });

  it("applies read-side defaults and drops unsafe optional URLs", () => {
    const manifest = defineCommerce({
      identity: { name: "Defaults", logoUrl: "data:image/png;base64,abc" },
      offers: [
        {
          id: "usage",
          title: "Usage",
          url: "file:///private/data",
          pricing: [{ kind: "usage_based", currency: "eur", unit: "request", unitAmount: 2 }]
        },
        {
          id: "recurring",
          title: "Recurring",
          kind: "plan" as const,
          pricing: [
            { kind: "recurring", amount: 900, currency: "eur", interval: "month", trialDays: 14 }
          ]
        },
        { id: "sales", title: "Sales", pricing: [{ kind: "contact_sales" }] }
      ],
      policies: [{ type: "privacy", url: "file:///etc/passwd" }]
    });

    expect(manifest.identity.logoUrl).toBeUndefined();
    expect(manifest.identity.currencies).toEqual([]);
    expect(manifest.catalog.offers.map((offer) => offer.kind)).toEqual([
      "plan",
      "product",
      "product"
    ]);
    expect(manifest.catalog.offers[1]!.url).toBeUndefined();
    expect(manifest.catalog.offers[1]!.availability).toBe("unknown");
    expect(manifest.catalog.offers[1]!.categories).toEqual([]);
    expect(manifest.catalog.offers[1]!.attributes).toEqual({});
    expect(manifest.catalog.offers[2]!.pricing[0]).toEqual({
      kind: "usage_based",
      currency: "EUR",
      unit: "request",
      unitAmount: 2
    });
    expect(manifest.catalog.offers[0]!.pricing[0]).toEqual({
      kind: "recurring",
      amount: 900,
      currency: "EUR",
      interval: "month",
      trialDays: 14
    });
    expect(manifest.catalog.offers[1]!.pricing[0]).toEqual({ kind: "contact_sales" });
    expect(manifest.policies[0]!.url).toBeUndefined();
  });

  it("drops malformed URL strings without rejecting the whole manifest", () => {
    const manifest = defineCommerce({
      identity: { name: "Malformed", logoUrl: "not a url" },
      offers: [{ id: "plain", title: "Plain", images: ["also not a url"] }]
    });

    expect(manifest.identity.logoUrl).toBeUndefined();
    expect(manifest.catalog.offers[0]!.images).toEqual([]);
  });

  it("throws with structured issue text when config parsing fails", () => {
    expect(() =>
      defineCommerce({
        identity: { name: "" },
        offers: [{ id: "", title: "Missing id" }]
      })
    ).toThrow(/identity.name/);
  });

  it("throws when duplicate offer ids are provided", () => {
    expect(() =>
      defineCommerce({
        identity: { name: "Dupes" },
        offers: [
          { id: "same", title: "A" },
          { id: "same", title: "B" }
        ]
      })
    ).toThrow(/Duplicate offer id: same/);
  });

  it("rejects invalid price amounts and currency codes", () => {
    expect(() =>
      defineCommerce({
        identity: { name: "Bad price" },
        offers: [
          {
            id: "bad",
            title: "Bad",
            pricing: [{ kind: "one_time", amount: -1, currency: "US" }]
          }
        ]
      })
    ).toThrow(/pricing/);
  });
});

describe("validate", () => {
  it("returns a manifest for valid configs", () => {
    const result = validate(baseConfig);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.manifest?.identity.name).toBe("Acme Coffee");
  });

  it("returns schema issues with root paths when strict top-level parsing fails", () => {
    const result = validate({ ...baseConfig, metadata: { hidden: true } });

    expect(result.ok).toBe(false);
    expect(result.manifest).toBeUndefined();
    expect(result.issues).toEqual([
      {
        path: "(root)",
        message: "Unrecognized key(s) in object: 'metadata'"
      }
    ]);
  });

  it("returns duplicate-id issues without building a manifest", () => {
    const result = validate({
      identity: { name: "Dupes" },
      offers: [
        { id: "same", title: "A" },
        { id: "same", title: "B" }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.manifest).toBeUndefined();
    expect(result.issues).toEqual([
      {
        path: "offers.1.id",
        message: "Duplicate offer id: same"
      }
    ]);
  });
});

describe("types and error taxonomy", () => {
  it("exports the closed v1 error code set", () => {
    const codes = [...ERROR_CODES];
    const networkCode: ErrorCode = "network_error";

    expect(codes).toEqual([
      "not_found",
      "version_mismatch",
      "protocol_mismatch",
      "network_error",
      "internal_error"
    ]);
    expect(networkCode).toBe("network_error");
  });

  it("exports manifest, offer, and policies types", () => {
    const manifest: Manifest = defineCommerce(baseConfig);
    const offer: Offer = manifest.catalog.offers[0]!;
    const policies: Policies = manifest.policies;

    expect(offer.title).toBe("Double Espresso");
    expect(policies).toHaveLength(1);
  });

  it("preserves psp.stripe.priceId so Stripe import binding survives validation", () => {
    const manifest = defineCommerce({
      identity: { name: "Acme", domain: "acme.example", currencies: ["USD"] },
      offers: [
        {
          id: "espresso",
          title: "Espresso",
          availability: "in_stock",
          pricing: [{ kind: "one_time", amount: 300, currency: "USD" }],
          psp: { stripe: { priceId: "price_1ABC" } }
        }
      ]
    });
    expect(manifest.catalog.offers[0]!.psp?.stripe?.priceId).toBe("price_1ABC");
  });
});
