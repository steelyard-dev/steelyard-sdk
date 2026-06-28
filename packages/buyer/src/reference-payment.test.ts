// Copyright (c) Steelyard contributors. MIT License.
import type { EcJwk } from "@steelyard/core";
import { describe, expect, it } from "vitest";
import {
  REFERENCE_PAYMENT_INSTRUMENT_TYPE,
  REFERENCE_PAYMENT_TOKEN_PREFIX,
  ReferencePaymentMandateIssuerError,
  ReferencePaymentMandateIssuerInProductionError,
  createReferencePaymentMandateIssuer,
  referenceMandate
} from "./reference-payment.js";

const now = new Date("2026-06-14T12:00:00.000Z");

describe("createReferencePaymentMandateIssuer", () => {
  it("is default-deny outside known test environments", async () => {
    await withReferenceEnv({}, async () => {
      expect(() => createReferencePaymentMandateIssuer({ signingKey: referencePrivateKey })).toThrow(ReferencePaymentMandateIssuerInProductionError);
      expect(() => createReferencePaymentMandateIssuer({ signingKey: referencePrivateKey, allowInProduction: true }))
        .toThrow(ReferencePaymentMandateIssuerInProductionError);
      process.env.STEELYARD_ALLOW_REFERENCE_PSP = "1";
      expect(() => createReferencePaymentMandateIssuer({ signingKey: referencePrivateKey })).toThrow(ReferencePaymentMandateIssuerInProductionError);
      expect(() => createReferencePaymentMandateIssuer({ signingKey: referencePrivateKey, allowInProduction: true })).not.toThrow();
    });
  });

  it("mints a context-bound delegated payment token", async () => {
    const issuer = createReferencePaymentMandateIssuer({ signingKey: referencePrivateKey, clock: () => now });
    const handle = await issuer.issueMandate({
      iat: Math.floor(now.getTime() / 1000),
      nonce: "payment_nonce_1",
      merchant_id: "https://coffee.example/.well-known/ucp",
      handler_id: "reference",
      instrument_type: REFERENCE_PAYMENT_INSTRUMENT_TYPE,
      transaction_id: "checkout_1",
      payment: {
        amount: 500,
        currency: "USD",
        checkout_id: "checkout_1",
        expires_at: new Date(now.getTime() + 15 * 60_000).toISOString()
      }
    });

    expect(issuer.instrumentType).toBe(REFERENCE_PAYMENT_INSTRUMENT_TYPE);
    expect(handle.id).toMatch(new RegExp(`^${REFERENCE_PAYMENT_TOKEN_PREFIX}[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`));
    expect(handle).toMatchObject({
      expires_at: Math.floor((now.getTime() + 15 * 60_000) / 1000),
      max_amount: 500,
      currency: "USD",
      scope_proof: {
        type: "reference_delegated_payment_token",
        kid: "reference-p256",
        transaction_id: "checkout_1"
      }
    });
  });

  it("rejects incomplete mandate scope", async () => {
    const issuer = createReferencePaymentMandateIssuer({ signingKey: referencePrivateKey, clock: () => now });
    await expect(
      issuer.issueMandate({
        iat: Math.floor(now.getTime() / 1000),
        nonce: "payment_nonce_1",
        payment: {
          amount: 500,
          currency: "USD",
          checkout_id: "checkout_1",
          expires_at: new Date(now.getTime() + 15 * 60_000).toISOString()
        }
      })
    ).rejects.toThrow(ReferencePaymentMandateIssuerError);
  });

  it("wraps the issuer as an agent-native wallet instrument", () => {
    const instrument = referenceMandate({ signingKey: referencePrivateKey, clock: () => now });

    expect(instrument).toMatchObject({
      mode: "agent-native",
      type: REFERENCE_PAYMENT_INSTRUMENT_TYPE,
      label: "Reference mandate"
    });
    expect(instrument.issuer.instrumentType).toBe(REFERENCE_PAYMENT_INSTRUMENT_TYPE);
  });
});

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

const referencePublicKey = {
  kid: "reference-p256",
  kty: "EC",
  crv: "P-256",
  x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
  use: "sig",
  alg: "ES256"
} satisfies EcJwk;

const referencePrivateKey = {
  ...referencePublicKey,
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
} satisfies EcJwk;

async function withReferenceEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const keys = ["VITEST", "JEST_WORKER_ID", "STEELYARD_TEST", "STEELYARD_ALLOW_REFERENCE_PSP", "NODE_ENV"] as const;
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
