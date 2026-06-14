// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it } from "vitest";
import {
  COMMERCE_MANIFEST_PATH,
  COMMERCE_MANIFEST_SCHEMA_VERSION,
  DuplicateExplicitPolicyId,
  canonicalCommerceManifestHash,
  commerceManifest,
  defineCommerce,
  validateCommerceManifest,
  type CommerceManifestDoc,
  type CommerceManifestPeer,
  type PeerName
} from "./index.js";

const fixedDate = new Date("2026-06-14T12:34:56.789Z");
const peers = {
  acp: {
    url: "https://coffee.example/acp/feed",
    protocol_version: "2026-04-17",
    steelyard_read_version: "0.1"
  },
  http: {
    url: "/commerce",
    protocol_version: "0.1"
  }
} satisfies Partial<Record<PeerName, CommerceManifestPeer>>;

function coffeeManifest() {
  return defineCommerce({
    identity: {
      name: "Acme Coffee",
      domain: "coffee.example",
      currencies: ["usd"]
    },
    offers: [
      {
        id: "latte",
        title: "Latte",
        url: "file:///etc/passwd",
        pricing: [{ kind: "one_time", amount: 550, currency: "usd" }]
      }
    ],
    policies: [
      {
        type: "returns",
        summary: "Unused beans may be returned within 14 days."
      }
    ]
  });
}

describe("commerceManifest", () => {
  it("emits a validated manifest with checksum, constants, peers, and normalized policies", () => {
    const doc = commerceManifest(coffeeManifest(), { peers, clock: () => fixedDate });

    expect(COMMERCE_MANIFEST_PATH).toBe("/.well-known/commerce.json");
    expect(COMMERCE_MANIFEST_SCHEMA_VERSION).toBe("0.1");
    expect(doc.$schema).toBe("https://steelyard.dev/schemas/commerce-manifest/0.1.json");
    expect(doc.schema_version).toBe("0.1");
    expect(doc.generated_at).toBe("2026-06-14T12:34:56.789Z");
    expect(doc.identity.currencies).toEqual(["USD"]);
    expect(doc.offers[0]).not.toHaveProperty("url");
    expect(doc.policies).toEqual([
      {
        id: "returns",
        type: "returns",
        summary: "Unused beans may be returned within 14 days."
      }
    ]);
    expect(doc.peers).toEqual(peers);
    expect(doc.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(canonicalCommerceManifestHash(doc)).toBe(doc.content_hash);
    expect(validateCommerceManifest(doc)).toEqual({ valid: true, errors: [], doc });
  });

  it("is deterministic with a fixed clock or generatedAt override", () => {
    const manifest = coffeeManifest();
    const fromClock = commerceManifest(manifest, { peers, clock: () => fixedDate });
    const fromGeneratedAt = commerceManifest(manifest, {
      peers,
      generatedAt: "2026-06-14T12:34:56.789Z"
    });

    expect(fromClock).toEqual(fromGeneratedAt);
  });

  it("omits content_hash from canonical hash input", () => {
    const doc = commerceManifest(coffeeManifest(), { clock: () => fixedDate });
    const tamperedHash = {
      ...doc,
      content_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    } satisfies CommerceManifestDoc;

    expect(canonicalCommerceManifestHash(tamperedHash)).toBe(doc.content_hash);
  });

  it("rejects invalid generatedAt overrides and invalid peer payloads", () => {
    expect(() => commerceManifest(coffeeManifest(), { generatedAt: "2026-06-14T12:34:56Z" })).toThrow(
      /generatedAt/
    );
    expect(() =>
      commerceManifest(coffeeManifest(), {
        peers: { http: { url: "", protocol_version: "0.1" } },
        clock: () => fixedDate
      })
    ).toThrow(/Commerce manifest failed validation/);
  });
});

describe("commerce manifest policy ids", () => {
  it("derives deterministic ids for repeated policy types", () => {
    const manifest = defineCommerce({
      identity: { name: "Policies" },
      policies: [{ type: "returns" }, { type: "returns" }, { type: "privacy" }]
    });

    expect(commerceManifest(manifest, { clock: () => fixedDate }).policies.map((policy) => policy.id)).toEqual([
      "returns",
      "returns-2",
      "privacy"
    ]);
  });

  it("derives missing ids around explicit reservations", () => {
    const manifest = defineCommerce({
      identity: { name: "Policies" },
      policies: [{ id: "returns", type: "privacy" }, { type: "returns" }]
    });

    expect(commerceManifest(manifest, { clock: () => fixedDate }).policies).toEqual([
      { id: "returns", type: "privacy" },
      { id: "returns-2", type: "returns" }
    ]);
  });

  it("throws on duplicate explicit policy ids", () => {
    const manifest = defineCommerce({
      identity: { name: "Policies" },
      policies: [
        { id: "terms", type: "terms" },
        { id: "terms", type: "privacy" }
      ]
    });

    expect(() => commerceManifest(manifest, { clock: () => fixedDate })).toThrow(DuplicateExplicitPolicyId);
    expect(() => commerceManifest(manifest, { clock: () => fixedDate })).toThrow(/terms/);
  });
});

describe("validateCommerceManifest", () => {
  it("reports schema and checksum errors without throwing", () => {
    expect(validateCommerceManifest({})).toMatchObject({ valid: false });

    const doc = commerceManifest(coffeeManifest(), { clock: () => fixedDate });
    const result = validateCommerceManifest({
      ...doc,
      content_hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      instancePath: "/content_hash",
      keyword: "checksum"
    });
  });
});
