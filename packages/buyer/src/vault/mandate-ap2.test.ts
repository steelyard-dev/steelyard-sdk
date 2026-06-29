// Copyright (c) Steelyard contributors. MIT License.
import { createHash } from "node:crypto";
import { ecdsaVerifyRaw, type EcJwk } from "@steelyard-dev/core";
import type { Checkout } from "@steelyard-dev/protocol/ucp/checkout";
import { describe, expect, it } from "vitest";
import {
  BuyerVault,
  memoryBoxStore,
  memoryKeystore,
  AP2_CHECKOUT_MANDATE_DISCLOSURE_TREE,
  ap2CheckoutMandateSdHash,
  ap2CheckoutMandateSdHashInput,
  issueAp2CheckoutMandate,
  issueAp2PaymentMandate,
  parseAp2CheckoutMandate,
  parseAp2PaymentMandate,
  ucpAp2PaymentTransactionId
} from "./index.js";

const now = new Date("2026-06-14T12:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const issuer = "did:example:bank-dpc-issuer";
const audience = "https://coffee.example/.well-known/ucp";

describe("AP2 checkout mandate issuer", () => {
  it("issues an SD-JWT+KB checkout mandate with checkout terms always disclosed", async () => {
    const vault = await vaultWithUcpSigningKey();
    const publicKey = await vault.exportUcpSigningPublicKey();

    const issued = await issueAp2CheckoutMandate({
      signer: vault,
      checkout: sampleCheckout(),
      issuer,
      audience,
      nonce: "nonce_1",
      buyer: {
        email: "jane@example.com",
        name: "Jane Buyer",
        address: { postal_code: "12345", address_country: "US" }
      },
      clock: () => now,
      saltGenerator: saltSequence()
    });
    const parsed = parseAp2CheckoutMandate(issued.checkout_mandate);

    expect(parsed.issuerHeader).toMatchObject({ alg: "ES256", typ: "dc+sd-jwt", kid: publicKey.kid });
    expect(parsed.issuerPayload).toMatchObject({
      iss: issuer,
      iat: nowSeconds,
      exp: nowSeconds + 300,
      aud: audience,
      _sd_alg: "sha-256",
      cnf: { jwk: publicKey },
      "ap2:checkout": sampleCheckout()
    });
    expect(JSON.stringify(parsed.issuerPayload)).not.toContain("jane@example.com");
    expect(parsed.disclosures).toEqual([]);

    expect(parsed.kbHeader).toEqual({ alg: "ES256", typ: "kb+jwt" });
    expect(parsed.kbPayload).toMatchObject({
      iat: nowSeconds,
      aud: audience,
      nonce: "nonce_1",
      sd_hash: ap2CheckoutMandateSdHash(parsed)
    });
    expect(ap2CheckoutMandateSdHashInput(parsed)).toBe(`${parsed.sdJwt}~`);
    await expect(verifyCompactJws(parsed.sdJwt, publicKey)).resolves.toBe(true);
    await expect(verifyCompactJws(parsed.kbJwt, publicKey)).resolves.toBe(true);
  });

  it("can disclose selected buyer identity claims while keeping other buyer claims withheld", async () => {
    const vault = await vaultWithUcpSigningKey();
    const publicKey = await vault.exportUcpSigningPublicKey();

    const issued = await issueAp2CheckoutMandate({
      signer: vault,
      checkout: sampleCheckout(),
      issuer,
      audience,
      nonce: "nonce_2",
      buyer: {
        email: "jane@example.com",
        name: "Jane Buyer"
      },
      disclose: { buyer: { email: true } },
      clock: () => now,
      saltGenerator: saltSequence()
    });
    const parsed = parseAp2CheckoutMandate(issued.checkout_mandate);
    const disclosure = decodeDisclosure(parsed.disclosures[0]!);

    expect(parsed.disclosures).toHaveLength(1);
    expect(disclosure).toEqual(["salt-0", "email", "jane@example.com"]);
    expect(JSON.stringify(parsed.issuerPayload)).not.toContain("Jane Buyer");
    expect(ap2CheckoutMandateSdHashInput(parsed)).toBe(`${parsed.sdJwt}~${parsed.disclosures[0]}~`);
    expect(parsed.kbPayload.sd_hash).toBe(ap2CheckoutMandateSdHash(parsed));
    await expect(verifyCompactJws(parsed.sdJwt, publicKey)).resolves.toBe(true);
    await expect(verifyCompactJws(parsed.kbJwt, publicKey)).resolves.toBe(true);
  });

  it("can disclose selected buyer address claims", async () => {
    const vault = await vaultWithUcpSigningKey();
    const issued = await issueAp2CheckoutMandate({
      signer: vault,
      checkout: sampleCheckout(),
      issuer,
      audience,
      nonce: "nonce_address",
      buyer: {
        address: { postal_code: "12345", address_country: "US" }
      },
      disclose: { buyer: { address: ["postal_code"] } },
      clock: () => now,
      saltGenerator: saltSequence()
    });
    const parsed = parseAp2CheckoutMandate(issued.checkout_mandate);
    const disclosures = parsed.disclosures.map(decodeDisclosure);

    expect(disclosures).toContainEqual(["salt-0", "postal_code", "12345"]);
    expect(JSON.stringify(disclosures)).not.toContain("address_country");
    expect(parsed.kbPayload.sd_hash).toBe(ap2CheckoutMandateSdHash(parsed));
  });

  it("can disclose the full buyer address object", async () => {
    const vault = await vaultWithUcpSigningKey();
    const issued = await issueAp2CheckoutMandate({
      signer: vault,
      checkout: sampleCheckout(),
      issuer,
      audience,
      nonce: "nonce_address_all",
      buyer: {
        address: { postal_code: "12345", address_country: "US" }
      },
      disclose: { buyer: { address: true } },
      clock: () => now,
      saltGenerator: saltSequence()
    });
    const parsed = parseAp2CheckoutMandate(issued.checkout_mandate);
    const disclosures = parsed.disclosures.map(decodeDisclosure);

    expect(disclosures).toContainEqual(["salt-0", "postal_code", "12345"]);
    expect(disclosures).toContainEqual(["salt-1", "address_country", "US"]);
    expect(parsed.kbPayload.sd_hash).toBe(ap2CheckoutMandateSdHash(parsed));
  });

  it("supports ES384 holder keys and custom expiry", async () => {
    const vault = await vaultWithUcpSigningKey("ES384");
    const publicKey = await vault.exportUcpSigningPublicKey();

    const issued = await issueAp2CheckoutMandate({
      signer: vault,
      checkout: sampleCheckout(),
      issuer,
      audience,
      nonce: "nonce_es384",
      buyer: { email: "jane@example.com" },
      disclose: { buyer: { email: true } },
      clock: () => now,
      expiresInSeconds: 900
    });
    const parsed = parseAp2CheckoutMandate(issued.checkout_mandate);

    expect(parsed.issuerHeader).toMatchObject({ alg: "ES384", typ: "dc+sd-jwt", kid: publicKey.kid });
    expect(parsed.kbHeader).toEqual({ alg: "ES384", typ: "kb+jwt" });
    expect(parsed.issuerPayload.exp).toBe(nowSeconds + 900);
    await expect(verifyCompactJws(parsed.sdJwt, publicKey)).resolves.toBe(true);
    await expect(verifyCompactJws(parsed.kbJwt, publicKey)).resolves.toBe(true);
  });

  it("issues an AP2-defined closed payment mandate bound to the UCP merchant authorization (PM5-1)", async () => {
    const vault = await vaultWithUcpSigningKey();
    const publicKey = await vault.exportUcpSigningPublicKey();
    const checkout = sampleCheckout();
    const payment = {
      amount: 500,
      currency: "USD",
      checkout_id: "checkout_123",
      expires_at: new Date(now.getTime() + 15 * 60_000).toISOString()
    };

    const issued = await issueAp2PaymentMandate({
      signer: vault,
      checkout,
      issuer,
      audience,
      nonce: "payment_nonce_1",
      payment,
      payee: {
        id: "merchant_1",
        name: "Demo Merchant",
        website: "https://coffee.example"
      },
      handlerId: "stripe",
      paymentInstrument: {
        id: "card_1",
        type: "card",
        description: "Visa 4242"
      },
      clock: () => now,
      saltGenerator: saltSequence()
    });
    const parsed = parseAp2PaymentMandate(issued.payment_mandate);

    expect(issued.transaction_id).toBe(ucpAp2PaymentTransactionId(checkout));
    expect(issued.transaction_id).toBe(
      Buffer.from(createHash("sha256").update("eyJhbGciOiJFUzI1NiIsImtpZCI6Im0ifQ..c2ln").digest()).toString("base64url")
    );
    expect(parsed.issuerHeader).toMatchObject({ alg: "ES256", typ: "dc+sd-jwt", kid: publicKey.kid });
    expect(parsed.issuerPayload).toMatchObject({
      iss: issuer,
      iat: nowSeconds,
      exp: nowSeconds + 300,
      aud: audience,
      cnf: { jwk: publicKey },
      vct: "mandate.payment.1",
      transaction_id: issued.transaction_id,
      payee: { id: "merchant_1", name: "Demo Merchant", website: "https://coffee.example" },
      payment: { handler: "stripe" },
      payment_amount: { amount: 500, currency: "USD" },
      payment_instrument: { id: "card_1", type: "card", description: "Visa 4242" }
    });
    expect(parsed.issuerPayload).not.toHaveProperty("execution_date");
    expect(parsed.disclosures).toEqual([]);
    expect(parsed.kbHeader).toEqual({ alg: "ES256", typ: "kb+jwt" });
    expect(parsed.kbPayload).toMatchObject({
      iat: nowSeconds,
      aud: audience,
      nonce: "payment_nonce_1",
      sd_hash: ap2CheckoutMandateSdHash(parsed)
    });
    await expect(verifyCompactJws(parsed.sdJwt, publicKey)).resolves.toBe(true);
    await expect(verifyCompactJws(parsed.kbJwt, publicKey)).resolves.toBe(true);
  });

  it("rejects disclosure trees that try to selectively disclose checkout terms", async () => {
    const vault = await vaultWithUcpSigningKey();

    await expect(
      issueAp2CheckoutMandate({
        signer: vault,
        checkout: sampleCheckout(),
        issuer,
        audience,
        nonce: "nonce_3",
        disclosureTree: {
          ...AP2_CHECKOUT_MANDATE_DISCLOSURE_TREE,
          selectivelyDisclosed: [
            ...AP2_CHECKOUT_MANDATE_DISCLOSURE_TREE.selectivelyDisclosed,
            "$.ap2:checkout.line_items"
          ]
        },
        clock: () => now
      })
    ).rejects.toThrow(/line_items/);

    await expect(
      issueAp2CheckoutMandate({
        signer: vault,
        checkout: sampleCheckout(),
        issuer,
        audience,
        nonce: "nonce_missing_tree_path",
        disclosureTree: {
          ...AP2_CHECKOUT_MANDATE_DISCLOSURE_TREE,
          alwaysDisclosed: AP2_CHECKOUT_MANDATE_DISCLOSURE_TREE.alwaysDisclosed.filter(
            (path) => path !== "$.ap2:checkout.totals"
          )
        },
        clock: () => now
      })
    ).rejects.toThrow(/totals/);
  });

  it("requires merchant authorization and the vault UCP holder key", async () => {
    const unsignedVault = await BuyerVault.init({
      path: "/tmp/ap2-no-key.box",
      profile: { name: "Jane Doe" },
      keystore: memoryKeystore(),
      boxStore: memoryBoxStore()
    });
    await expect(
      issueAp2CheckoutMandate({
        signer: unsignedVault,
        checkout: sampleCheckout(),
        issuer,
        audience,
        nonce: "nonce_4",
        clock: () => now
      })
    ).rejects.toThrow(/UCP signing key is not configured/);

    const vault = await vaultWithUcpSigningKey();
    await expect(
      issueAp2CheckoutMandate({
        signer: vault,
        checkout: { ...sampleCheckout(), ap2: {} },
        issuer,
        audience,
        nonce: "nonce_5",
        clock: () => now
      })
    ).rejects.toThrow(/merchant_authorization/);
  });

  it("requires AP2 payment mandate transaction binding and valid payment details", async () => {
    const vault = await vaultWithUcpSigningKey();
    const payment = {
      amount: 500,
      currency: "USD",
      checkout_id: "checkout_123",
      expires_at: new Date(now.getTime() + 15 * 60_000).toISOString()
    };

    expect(() => ucpAp2PaymentTransactionId({ ...sampleCheckout(), ap2: {} })).toThrow(/merchant_authorization/);
    await expect(
      issueAp2PaymentMandate({
        signer: vault,
        checkout: sampleCheckout(),
        issuer,
        audience,
        nonce: "payment_nonce_bad_amount",
        payment: { ...payment, amount: 1.5 },
        payee: { id: "merchant_1", name: "Demo Merchant" },
        paymentInstrument: { id: "card_1", type: "card" },
        clock: () => now
      })
    ).rejects.toThrow(/amount/);
    await expect(
      issueAp2PaymentMandate({
        signer: vault,
        checkout: sampleCheckout(),
        issuer,
        audience,
        nonce: "payment_nonce_bad_currency",
        payment: { ...payment, currency: "usd" },
        payee: { id: "merchant_1", name: "Demo Merchant" },
        paymentInstrument: { id: "card_1", type: "card" },
        clock: () => now
      })
    ).rejects.toThrow(/currency/);
    await expect(
      issueAp2PaymentMandate({
        signer: vault,
        checkout: sampleCheckout(),
        issuer,
        audience,
        nonce: "payment_nonce_bad_expiry",
        payment: { ...payment, expires_at: "not-a-date" },
        payee: { id: "merchant_1", name: "Demo Merchant" },
        paymentInstrument: { id: "card_1", type: "card" },
        clock: () => now
      })
    ).rejects.toThrow(/expires_at/);
  });

  it("rejects invalid expiry, unsupported holder keys, and malformed presentations", async () => {
    const vault = await vaultWithUcpSigningKey();
    await expect(
      issueAp2CheckoutMandate({
        signer: vault,
        checkout: sampleCheckout(),
        issuer,
        audience,
        nonce: "nonce_bad_expiry",
        clock: () => now,
        expiresInSeconds: 0
      })
    ).rejects.toThrow(/expiresInSeconds/);

    await expect(
      issueAp2CheckoutMandate({
        signer: signerWithPublicKey({
          kid: "unsupported",
          kty: "EC",
          crv: "P-521",
          x: "x",
          y: "y",
          alg: "ES512"
        } as unknown as EcJwk),
        checkout: sampleCheckout(),
        issuer,
        audience,
        nonce: "nonce_bad_key",
        clock: () => now
      })
    ).rejects.toThrow(/unsupported AP2 holder key algorithm/);

    expect(() => parseAp2CheckoutMandate("issuer-only")).toThrow(/must contain/);
    expect(() => parseAp2CheckoutMandate("not-a-jws~not-a-kb-jws")).toThrow(/compact JWS/);
    expect(() => parseAp2CheckoutMandate("a.b.c~not-a-kb-jws")).toThrow(/invalid JSON/);
    expect(() => parseAp2CheckoutMandate("~a.b.c")).toThrow(/SD-JWT segment/);
  });
});

async function vaultWithUcpSigningKey(algorithm: "ES256" | "ES384" = "ES256"): Promise<BuyerVault> {
  const vault = await BuyerVault.init({
    path: "/tmp/ap2-vault.box",
    profile: { name: "Jane Doe", email: "jane@example.com" },
    keystore: memoryKeystore(),
    boxStore: memoryBoxStore()
  });
  await vault.createUcpSigningKey({ algorithm });
  return vault;
}

function sampleCheckout(): Checkout {
  return {
    ucp: { version: "2026-04-17", status: "success", payment_handlers: {} },
    id: "checkout_123",
    status: "ready_for_complete",
    line_items: [{ id: "line_1", item: { id: "latte", title: "Latte", price: 500 }, quantity: 1 }],
    totals: [{ type: "total", display_text: "Total", amount: 500 }],
    currency: "USD",
    links: [],
    ap2: { merchant_authorization: "eyJhbGciOiJFUzI1NiIsImtpZCI6Im0ifQ..c2ln" }
  };
}

async function verifyCompactJws(jws: string, key: EcJwk): Promise<boolean> {
  const [encodedHeader, encodedPayload, encodedSignature] = jws.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) return false;
  return await ecdsaVerifyRaw({
    algorithm: key.alg === "ES384" ? "ES384" : "ES256",
    publicKeyJwk: key,
    data: Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
    signature: Buffer.from(encodedSignature, "base64url")
  });
}

function decodeDisclosure(value: string): unknown[] {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown[];
}

function saltSequence(): () => string {
  let index = 0;
  return () => `salt-${index++}`;
}

function signerWithPublicKey(publicKey: EcJwk) {
  return {
    async exportUcpSigningPublicKey() {
      return publicKey;
    },
    async signWithUcpKey() {
      throw new Error("signWithUcpKey should not be called");
    }
  };
}
