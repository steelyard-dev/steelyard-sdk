// Copyright (c) Steelyard contributors. MIT License.
import { createHash, createPrivateKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MockMandateInProductionError,
  canonicalMandateCheckout,
  mockMandateVerifier,
  steelyardJwsVerifier,
  type MandateVerifier
} from "./index.js";
import type { Checkout, JsonWebKey } from "@steelyard/core";
import type { JsonWebKey as NodeJsonWebKey } from "node:crypto";

const now = new Date("2026-06-14T12:00:00Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const audience = "https://shop.example/.well-known/ucp";

const checkout: Checkout = {
  id: "checkout_1",
  status: "ready_for_complete",
  currency: "USD",
  line_items: [{ id: "line_1", label: "Latte", quantity: 1, price: { amount: 500, currency: "USD" } }],
  totals: [
    { type: "subtotal", amount: 500 },
    { type: "total", amount: 550 }
  ],
  links: [],
  payment: {
    instruments: [
      {
        id: "instrument_1",
        handler_id: "handler_1",
        type: "vault_token",
        credential: { type: "vault_token", token: "vt_1" },
        selected: true
      }
    ]
  }
};

describe("steelyardJwsVerifier", () => {
  it("verifies a buyer-signed Steelyard mandate against a trusted public key", async () => {
    const key = mandateKey();
    const verifier = steelyardJwsVerifier({
      mode: "enabled",
      trustedKeys: { keys: [key.publicJwk] },
      clock: () => now
    });

    await expect(verifier.verify(envelope(signPayload(key)), checkout, audience)).resolves.toEqual({
      ok: true,
      subject_id: "buyer_pairwise_subject",
      key_id: key.keyId
    });
    expect(canonicalMandateCheckout({ ...checkout, status: "ignored", ucp: { version: "2026-04-17" } })).toEqual({
      currency: "USD",
      id: "checkout_1",
      line_items: checkout.line_items,
      totals: checkout.totals
    });
  });

  it("supports async trusted-key lookup", async () => {
    const key = mandateKey();
    const verifier = steelyardJwsVerifier({
      mode: "enabled",
      trustedKeys: async (keyId) => (keyId === key.keyId ? key.publicJwk : null),
      clock: () => now
    });

    await expect(verifier.verify(envelope(signPayload(key)), checkout, audience)).resolves.toMatchObject({ ok: true });
  });

  it("rejects disabled Steelyard mode and AP2 namespace mandates", async () => {
    const key = mandateKey();
    await expect(
      steelyardJwsVerifier({ mode: "disabled", trustedKeys: { keys: [] }, clock: () => now }).verify(
        envelope("not-even-a-jws"),
        checkout,
        audience
      )
    ).resolves.toEqual({ ok: false, reason: "steelyard_mode_not_enabled" });

    await expect(
      verifierFor(key).verify({ ap2: { checkout_mandate: signPayload(key) } }, checkout, audience)
    ).resolves.toEqual({ ok: false, reason: "wrong_namespace" });
    await expect(
      verifierFor(key).verify(
        envelope(
          signPayload(key, {
            "steelyard:mandate_version": undefined,
            "ap2:mandate_version": "0.1"
          })
        ),
        checkout,
        audience
      )
    ).resolves.toEqual({ ok: false, reason: "wrong_namespace" });
  });

  it("rejects malformed, untrusted, and tampered JWS values", async () => {
    const key = mandateKey();
    const other = mandateKey();
    await expect(verifierFor(key).verify(envelope("bad"), checkout, audience)).resolves.toEqual({
      ok: false,
      reason: "invalid_jws"
    });
    await expect(verifierFor(other).verify(envelope(signPayload(key)), checkout, audience)).resolves.toEqual({
      ok: false,
      reason: "untrusted_key"
    });
    await expect(verifierFor(key).verify(envelope(tamperPayload(signPayload(key), { sub: "changed" })), checkout, audience))
      .resolves.toEqual({
        ok: false,
        reason: "invalid_signature"
      });
    await expect(
      verifierFor(key).verify(envelope(signPayload(key, {}, { alg: "none" })), checkout, audience)
    ).resolves.toEqual({ ok: false, reason: "invalid_header" });
  });

  it("checks issuer, subject, audience, timestamps, checkout, credential, and handler", async () => {
    const key = mandateKey();
    const cases: Array<[string, Partial<Record<string, unknown>>, Checkout | undefined, string | undefined]> = [
      ["issuer_mismatch", { iss: "mk_other" }, undefined, undefined],
      ["invalid_subject", { sub: "" }, undefined, undefined],
      ["audience_mismatch", { aud: "https://other.example/.well-known/ucp" }, undefined, undefined],
      ["invalid_iat", { iat: "now" }, undefined, undefined],
      ["issued_in_future", { iat: nowSeconds + 1 }, undefined, undefined],
      ["invalid_exp", { exp: "later" }, undefined, undefined],
      ["expired", { exp: nowSeconds }, undefined, undefined],
      [
        "checkout_mismatch",
        {
          "steelyard:checkout": {
            ...(canonicalMandateCheckout(checkout) as Record<string, unknown>),
            totals: [{ type: "total", amount: 999 }]
          }
        },
        undefined,
        undefined
      ],
      ["selected_payment_missing", {}, { ...checkout, payment: { instruments: [] } }, undefined],
      [
        "payment_credential_missing",
        {},
        { ...checkout, payment: { instruments: [{ id: "instrument_1", handler_id: "handler_1", type: "vault_token" }] } },
        undefined
      ],
      [
        "payment_credential_mismatch",
        { "steelyard:payment": { handler_id: "handler_1", credential_id: "vt_other" } },
        undefined,
        undefined
      ],
      [
        "payment_handler_mismatch",
        { "steelyard:payment": { handler_id: "handler_2", credential_id: "vt_1" } },
        undefined,
        undefined
      ]
    ];

    for (const [reason, overrides, checkoutOverride, expectedAudience] of cases) {
      await expect(
        verifierFor(key).verify(envelope(signPayload(key, overrides)), checkoutOverride ?? checkout, expectedAudience ?? audience)
      ).resolves.toEqual({ ok: false, reason });
    }
  });
});

describe("mockMandateVerifier", () => {
  it("is default-deny outside known test environments", async () => {
    await withMockEnv({}, async () => {
      expect(() => mockMandateVerifier()).toThrow(MockMandateInProductionError);
      expect(() => mockMandateVerifier({ allowInProduction: true })).toThrow(MockMandateInProductionError);
      process.env.STEELYARD_ALLOW_MOCK_MANDATE = "1";
      expect(() => mockMandateVerifier()).toThrow(MockMandateInProductionError);
      expect(() => mockMandateVerifier({ allowInProduction: true })).not.toThrow();
    });
  });

  it("allows stable test signals and supports deterministic mock outcomes", async () => {
    await withMockEnv({ STEELYARD_TEST: "1" }, async () => {
      await expect(
        mockMandateVerifier({ alwaysOk: { subject_id: "subject_1", key_id: "key_1" } }).verify({}, checkout, audience)
      ).resolves.toEqual({ ok: true, subject_id: "subject_1", key_id: "key_1" });
      await expect(mockMandateVerifier({ alwaysOk: false }).verify({}, checkout, audience)).resolves.toEqual({
        ok: false,
        reason: "mock_mandate_rejected"
      });
      await expect(mockMandateVerifier({ alwaysReason: "nope" }).verify({}, checkout, audience)).resolves.toEqual({
        ok: false,
        reason: "nope"
      });
    });
  });
});

function verifierFor(key: MandateKey): MandateVerifier {
  return steelyardJwsVerifier({
    mode: "enabled",
    trustedKeys: { keys: [key.publicJwk] },
    clock: () => now
  });
}

function envelope(jwt: string): { "steelyard.checkout_mandate": string } {
  return { "steelyard.checkout_mandate": jwt };
}

interface MandateKey {
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
  keyId: string;
}

function mandateKey(): MandateKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const privateJwk = privateKey.export({ format: "jwk" }) as JsonWebKey;
  return { publicJwk, privateJwk, keyId: keyIdForJwk(publicJwk) };
}

function signPayload(
  key: MandateKey,
  overrides: Partial<Record<string, unknown>> = {},
  headerOverrides: Partial<Record<string, unknown>> = {}
): string {
  const payload: Record<string, unknown> = {
    iss: key.keyId,
    sub: "buyer_pairwise_subject",
    aud: audience,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    "steelyard:mandate_version": "v0.1",
    "steelyard:checkout": canonicalMandateCheckout(checkout),
    "steelyard:payment": {
      handler_id: "handler_1",
      credential_id: "vt_1",
      expires_at: "2026-06-14T12:05:00.000Z"
    }
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete payload[name];
    else payload[name] = value;
  }
  return signCompactJwt(key.privateJwk, { alg: "EdDSA", typ: "JWT", kid: key.keyId, ...headerOverrides }, payload);
}

function signCompactJwt(privateJwk: JsonWebKey, header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const protectedHeader = base64urlJson(header);
  const body = base64urlJson(payload);
  const signingInput = `${protectedHeader}.${body}`;
  const privateKey = createPrivateKey({ key: privateJwk as NodeJsonWebKey, format: "jwk" });
  const signature = cryptoSign(null, Buffer.from(signingInput, "utf8"), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function tamperPayload(jwt: string, overrides: Record<string, unknown>): string {
  const parts = jwt.split(".");
  const header = parts[0]!;
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  return `${header}.${base64urlJson({ ...payload, ...overrides })}.${parts[2]!}`;
}

function keyIdForJwk(jwk: JsonWebKey): string {
  return `mk_${createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest("base64url")
    .slice(0, 32)}`;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function withMockEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const keys = ["VITEST", "JEST_WORKER_ID", "STEELYARD_TEST", "STEELYARD_ALLOW_MOCK_MANDATE", "NODE_ENV"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
