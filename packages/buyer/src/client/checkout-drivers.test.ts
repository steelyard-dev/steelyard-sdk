// Copyright (c) Steelyard contributors. MIT License.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  defineCommerce,
  ecdsaSignRaw,
  jcsCanonicalize,
  signDetachedJws,
  type EcJwk,
  type PaymentIssuerMandateDraft,
  type PurchaseIntent,
  type WalletDriverPort
} from "@steelyard/core";
import {
  applyCompleteRequest,
  applyCreateRequest,
  signAcpWebhook,
  type CheckoutSession
} from "@steelyard/protocol/acp/checkout";
import {
  applyUcpComplete,
  applyUcpCreate,
  applyUcpUpdate,
  type Checkout as UcpCheckout
} from "@steelyard/protocol/ucp/checkout";
import { signUcpResponse, verifyUcpRequest } from "@steelyard/protocol/ucp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpCanceled,
  AcpExpired,
  AcpNoCompatibleHandler,
  AcpPaymentIssuerMissing,
  AcpProtocolViolation,
  acpDriver,
  verifyAcpWebhook
} from "./acp.js";
import {
  asRecord,
  billingBuyer,
  checkoutTotals,
  delegatePaymentRequest,
  joinUrl,
  notifyTotals,
  patchJson,
  postJson,
  purchaseKey,
  selectedHandler,
  stringValue
} from "./driver-common.js";
import {
  Ap2MerchantAuthorizationInvalid,
  UcpCanceled,
  UcpAuthMissing,
  UcpNoCompatibleHandler,
  UcpResponseSignatureInvalid,
  ucpDriver
} from "./ucp.js";
import {
  parseAp2CheckoutMandate,
  parseAp2PaymentMandate,
  ucpAp2PaymentTransactionId
} from "../vault/mandate-ap2/index.js";

const now = new Date("2026-06-14T12:00:00.000Z");
const manifest = defineCommerce({
  identity: { name: "Acme Coffee", domain: "coffee.example", currencies: ["usd"] },
  offers: [{ id: "latte", title: "Latte", categories: ["coffee"], pricing: [{ kind: "one_time", amount: 500, currency: "usd" }] }]
});
const intent: PurchaseIntent = {
  merchant: { domain: "coffee.example", transport_url: "https://coffee.example", protocol: "acp" },
  offer: { id: "latte", title: "Latte", categories: ["coffee"] },
  amount: 500,
  currency: "USD",
  intent_id: "purchase_1"
};
const walletProfileUrl = "https://wallet.example/.well-known/ucp";

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

const walletP256PublicKey = {
  kid: "wallet-p256",
  kty: "EC",
  crv: "P-256",
  x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
  use: "sig",
  alg: "ES256"
} satisfies EcJwk;

const walletP256PrivateKey = {
  ...walletP256PublicKey,
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
} satisfies EcJwk;

const merchantP256PublicKey = {
  ...walletP256PublicKey,
  kid: "merchant-p256"
} satisfies EcJwk;

const merchantP256PrivateKey = {
  ...merchantP256PublicKey,
  d: walletP256PrivateKey.d
} satisfies EcJwk;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("ACP checkout driver", () => {
  it("purchases through direct Stripe SPT payment_data and builds an ACP receipt", async () => {
    const merchant = await startAcpMerchant();
    const totals: Array<{ amount: number; currency: string }> = [];
    const minted: unknown[] = [];
    const port = {
      ...testPort(),
      paymentIssuer: {
        instrumentType: "shared_payment_token" as const,
        async mintForMandate(mandate: PaymentIssuerMandateDraft) {
          minted.push(mandate);
          return {
            id: "spt_123",
            expires_at: Math.floor(Date.parse(mandate.payment.expires_at) / 1000),
            max_amount: mandate.payment.amount,
            currency: mandate.payment.currency,
            scope_proof: { type: "stripe_spt_usage_limits" as const, idempotency_key: "spt_idem_1" }
          };
        }
      }
    };
    const receipt = await acpDriver.purchase(intent, {
      merchantUrl: merchant.baseUrl,
      merchantId: "coffee.example",
      acpAuth: { bearerToken: "acp_token" },
      port,
      idempotencyKey: "purchase_1",
      clock: () => now,
      onTotalsKnown: (amount, currency) => {
        totals.push({ amount, currency });
      }
    });

    expect(receipt).toMatchObject({
      protocol: "acp",
      order_id: "order_cs_1",
      status: "captured",
      charged_amount: 500,
      charged_currency: "USD",
      reference: { acp: { checkout_session_id: "cs_1", vault_token_id: "spt_123" } }
    });
    expect(totals).toEqual([{ amount: 500, currency: "USD" }]);
    expect(merchant.requests.map((request) => request.idempotencyKey)).toEqual([
      "purchase_1:create",
      "purchase_1:complete"
    ]);
    expect(merchant.requests.map((request) => request.path)).toEqual([
      "/checkout_sessions",
      "/checkout_sessions/cs_1/complete"
    ]);
    expect(merchant.requests[0]!.headers).toMatchObject({
      "api-version": "2026-04-17",
      authorization: "Bearer acp_token"
    });
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      nonce: "acp:cs_1:purchase_1",
      payment: { amount: 500, currency: "USD", checkout_id: "cs_1" }
    });
    expect(merchant.requests[1]!.body).toMatchObject({
      payment_data: {
        handler_id: "stripe",
        instrument: {
          type: "card",
          credential: { type: "spt", token: "spt_123" }
        }
      }
    });
  });

  it("requires a wallet payment issuer for ACP direct SPT checkout", async () => {
    const merchant = await startAcpMerchant();

    await expect(
      acpDriver.purchase(intent, {
        merchantUrl: merchant.baseUrl,
        merchantId: "coffee.example",
        port: testPort(),
        idempotencyKey: "purchase_2",
        clock: () => now
      })
    ).rejects.toBeInstanceOf(AcpPaymentIssuerMissing);
  });

  it("maps non-payable ACP statuses to terminal driver errors", async () => {
    await expect(
      acpDriver.purchase(intent, {
        merchantUrl: (await startAcpMerchant({ createStatus: "canceled" })).baseUrl,
        merchantId: "coffee.example",
        port: testPort(),
        idempotencyKey: "purchase_canceled",
        clock: () => now
      })
    ).rejects.toBeInstanceOf(AcpCanceled);

    await expect(
      acpDriver.purchase(intent, {
        merchantUrl: (await startAcpMerchant({ createStatus: "expired" })).baseUrl,
        merchantId: "coffee.example",
        port: testPort(),
        idempotencyKey: "purchase_expired",
        clock: () => now
      })
    ).rejects.toBeInstanceOf(AcpExpired);

    await expect(
      acpDriver.purchase(intent, {
        merchantUrl: (await startAcpMerchant({ createStatus: "pending_approval" })).baseUrl,
        merchantId: "coffee.example",
        port: testPort(),
        idempotencyKey: "purchase_pending",
        clock: () => now
      })
    ).rejects.toBeInstanceOf(AcpProtocolViolation);
  });

  it("fails when ACP checkout does not advertise a compatible Stripe SPT handler", async () => {
    const merchant = await startAcpMerchant({ handlerConfig: false });

    await expect(
      acpDriver.purchase(intent, {
        merchantUrl: merchant.baseUrl,
        merchantId: "coffee.example",
        port: testPort(),
        idempotencyKey: "purchase_no_psp",
        clock: () => now
      })
    ).rejects.toBeInstanceOf(AcpNoCompatibleHandler);
  });

  it("cancels ACP sessions and verifies ACP webhooks through the buyer helper", async () => {
    const merchant = await startAcpMerchant();
    const canceled = await acpDriver.cancel("cs_1", {
      merchantUrl: merchant.baseUrl,
      acpAuth: { bearerToken: "acp_token" },
      idempotencyKey: "purchase_1:cancel"
    });
    const rawBody = JSON.stringify({ type: "checkout_session.completed" });
    const signature = await signAcpWebhook({ rawBody, secret: "whsec_test", timestamp: now });

    expect(canceled).toMatchObject({ status: "canceled" });
    expect(merchant.requests[0]!.path).toBe("/checkout_sessions/cs_1/cancel");
    expect(merchant.requests[0]!.headers).toMatchObject({
      "api-version": "2026-04-17",
      authorization: "Bearer acp_token"
    });
    await expect(
      verifyAcpWebhook({
        rawBody,
        secret: "whsec_test",
        headers: { "merchant-signature": signature },
        now
      })
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("UCP checkout driver", () => {
  it("updates payment hints, signs a Steelyard mandate, and builds a UCP receipt", async () => {
    const merchant = await startUcpMerchant();
    const port = testPort();
    const receipt = await ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
      merchantUrl: merchant.baseUrl,
      merchantId: "https://coffee.example/.well-known/ucp",
      delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
      supportsSteelyardMode: true,
      port,
      idempotencyKey: "purchase_ucp",
      clock: () => now
    });

    expect(receipt).toMatchObject({
      protocol: "ucp",
      order_id: "order_checkout_1",
      status: "completed",
      charged_amount: 0,
      charged_currency: "USD",
      reference: { ucp: { checkout_id: "checkout_1", vault_token_id: "vt_1" } }
    });
    expect(receipt.reference.ucp?.mandate_id).toHaveLength(16);
    expect(merchant.requests.map((request) => request.idempotencyKey)).toEqual([
      "purchase_ucp:create",
      "purchase_ucp:update",
      "purchase_ucp:delegate",
      "purchase_ucp:complete"
    ]);
    expect(merchant.requests[1]!.body).toMatchObject({
      payment: { instruments: [expect.objectContaining({ id: expect.stringMatching(/^instrument_/), handler_id: "stripe" })] }
    });
    expect(merchant.requests[3]!.body).toMatchObject({
      payment: { instruments: [expect.objectContaining({ credential: { type: "vault_token", token: "vt_1" } })] },
      "steelyard.checkout_mandate": "signed.jwt"
    });
    expect(port.signMandatePayloads[0]).toMatchObject({
      iss: "mk_test",
      aud: "https://coffee.example/.well-known/ucp",
      "steelyard:payment": { handler_id: "stripe", credential_id: "vt_1" }
    });
  });

  it("completes vanilla UCP when Steelyard mode is absent", async () => {
    const merchant = await startUcpMerchant();
    const port = testPort();
    const receipt = await ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
      merchantUrl: merchant.baseUrl,
      merchantId: "https://coffee.example/.well-known/ucp",
      delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
      supportsSteelyardMode: false,
      port,
      idempotencyKey: "purchase_ucp_vanilla",
      clock: () => now
    });

    expect(receipt.reference.ucp).toMatchObject({ checkout_id: "checkout_1", vault_token_id: "vt_1" });
    expect(receipt.reference.ucp?.mandate_id).toBeUndefined();
    expect(port.signMandatePayloads).toHaveLength(0);
    expect(merchant.requests.map((request) => request.idempotencyKey)).toEqual([
      "purchase_ucp_vanilla:create",
      "purchase_ucp_vanilla:update",
      "purchase_ucp_vanilla:delegate",
      "purchase_ucp_vanilla:complete"
    ]);
    expect(merchant.requests[3]!.body).not.toHaveProperty("steelyard.checkout_mandate");
  });

  it("signs outgoing UCP checkout requests when HMS auth is selected", async () => {
    const merchant = await startUcpMerchant();
    const port = withUcpSigningKey(testPort());
    await ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
      merchantUrl: merchant.baseUrl,
      merchantId: "https://coffee.example/.well-known/ucp",
      delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
      supportsSteelyardMode: false,
      port,
      idempotencyKey: "purchase_ucp_signed",
      ucpAuth: {
        preferred: "hms",
        signing: { kid: "wallet-p256", algorithm: "ES256", profileUrl: walletProfileUrl }
      },
      clock: () => now
    });

    const signedRequests = merchant.requests.filter((request) => request.path !== "/delegate");
    expect(signedRequests).toHaveLength(3);
    expect(port.ucpSignatureBases).toHaveLength(3);
    for (const request of signedRequests) {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["ucp-agent"]).toBe(`profile="${walletProfileUrl}"`);
      expect(request.headers["signature-input"]).toContain("keyid=\"wallet-p256\"");
      expect(request.headers.signature).toBeTruthy();
      await expect(verifyUcpRequest({
        method: request.method,
        url: new URL(`${merchant.baseUrl}${request.path}`),
        headers: request.headers,
        body: Buffer.from(request.rawBody, "utf8"),
        resolveKey: async (kid, signerProfileUrl) =>
          kid === "wallet-p256" && signerProfileUrl === walletProfileUrl ? walletP256PublicKey : null,
        now
      })).resolves.toMatchObject({ ok: true, kid: "wallet-p256", algorithm: "ES256" });
    }
  });

  it("verifies signed UCP complete responses against merchant profile keys", async () => {
    const merchant = await startUcpMerchant({ signCompleteResponse: true });
    const receipt = await ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
      merchantUrl: merchant.baseUrl,
      merchantId: "https://coffee.example/.well-known/ucp",
      merchantProfile: { ucp: {}, signing_keys: [merchantP256PublicKey] },
      delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
      supportsSteelyardMode: false,
      port: testPort(),
      idempotencyKey: "purchase_ucp_signed_response",
      clock: () => now
    });

    expect(receipt.reference.ucp).toMatchObject({ checkout_id: "checkout_1", vault_token_id: "vt_1" });
  });

  it("verifies AP2 merchant authorization before continuing the UCP checkout flow", async () => {
    const merchant = await startUcpMerchant({ merchantAuthorization: "valid" });
    const receipt = await ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
      merchantUrl: merchant.baseUrl,
      merchantId: "https://coffee.example/.well-known/ucp",
      merchantProfile: { ucp: {}, signing_keys: [merchantP256PublicKey] },
      delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
      supportsSteelyardMode: false,
      port: testPort(),
      idempotencyKey: "purchase_ucp_ap2",
      clock: () => now
    });

    expect(receipt.reference.ucp).toMatchObject({ checkout_id: "checkout_1", vault_token_id: "vt_1" });
    expect(merchant.requests.map((request) => request.path)).toEqual([
      "/checkout",
      "/checkout/checkout_1",
      "/delegate",
      "/checkout/checkout_1/complete"
    ]);
  });

  it("issues AP2 checkout and payment mandates in the UCP complete request (PM5-2)", async () => {
    const merchant = await startUcpMerchant({ merchantAuthorization: "valid" });
    const port = withUcpSigningKey(testPort());
    const receipt = await ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
      merchantUrl: merchant.baseUrl,
      merchantId: "https://coffee.example/.well-known/ucp",
      merchantProfile: { ucp: {}, signing_keys: [merchantP256PublicKey] },
      delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
      supportsSteelyardMode: true,
      port,
      idempotencyKey: "purchase_ucp_ap2_pm5",
      clock: () => now,
      ap2: {
        enabled: true,
        issuer: "did:example:bank-dpc-issuer",
        payee: {
          id: "merchant_1",
          name: "Acme Coffee",
          website: "https://coffee.example"
        },
        paymentInstrument: {
          id: "card_1",
          type: "card",
          description: "Visa 4242"
        }
      }
    });

    const complete = asRecord(merchant.requests[3]!.body);
    const selected = asRecord((asRecord(complete.payment).instruments as unknown[])[0]);
    const credential = asRecord(selected.credential);
    const checkoutMandate = stringValue(asRecord(complete.ap2).checkout_mandate);
    const paymentMandate = stringValue(credential.token);
    const parsedCheckout = parseAp2CheckoutMandate(checkoutMandate);
    const parsedPayment = parseAp2PaymentMandate(paymentMandate);
    const embeddedCheckout = parsedCheckout.issuerPayload["ap2:checkout"] as UcpCheckout;

    expect(receipt.reference.ucp?.mandate_id).toHaveLength(16);
    expect(complete).not.toHaveProperty("steelyard.checkout_mandate");
    expect(credential).toMatchObject({ type: "ap2_payment_mandate" });
    expect(parsedCheckout.kbPayload).toMatchObject({ nonce: "response_checkout_nonce_1" });
    expect(parsedPayment.kbPayload).toMatchObject({ nonce: "response_payment_nonce_1" });
    expect(parsedPayment.issuerPayload).toMatchObject({
      vct: "mandate.payment.1",
      payment_amount: { amount: 0, currency: "USD" },
      payee: { id: "merchant_1", name: "Acme Coffee" },
      payment_instrument: { id: "card_1", type: "card", description: "Visa 4242" }
    });
    expect(parsedPayment.issuerPayload.transaction_id).toBe(ucpAp2PaymentTransactionId(embeddedCheckout));
    expect(port.signMandatePayloads).toHaveLength(0);
  });

  it("embeds a Stripe SPT in the AP2 payment mandate without replacing credential.token (SI2, AP1)", async () => {
    const merchant = await startUcpMerchant({ merchantAuthorization: "valid" });
    const minted: unknown[] = [];
    const port = withUcpSigningKey({
      ...testPort(),
      paymentIssuer: {
        instrumentType: "shared_payment_token",
        async mintForMandate(mandate) {
          minted.push(mandate);
          return {
            id: "spt_123",
            expires_at: Math.floor(Date.parse(mandate.payment.expires_at) / 1000),
            max_amount: mandate.payment.amount,
            currency: mandate.payment.currency,
            scope_proof: {
              type: "stripe_spt_usage_limits",
              idempotency_key: "spt_idem_1"
            }
          };
        }
      }
    });
    const receipt = await ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
      merchantUrl: merchant.baseUrl,
      merchantId: "https://coffee.example/.well-known/ucp",
      merchantProfile: { ucp: {}, signing_keys: [merchantP256PublicKey] },
      supportsSteelyardMode: true,
      port,
      idempotencyKey: "purchase_ucp_ap2_spt",
      clock: () => now,
      ap2: {
        enabled: true,
        issuer: "did:example:bank-dpc-issuer",
        payee: {
          id: "merchant_1",
          name: "Acme Coffee",
          website: "https://coffee.example"
        }
      }
    });

    const complete = asRecord(merchant.requests[2]!.body);
    const selected = asRecord((asRecord(complete.payment).instruments as unknown[])[0]);
    const credential = asRecord(selected.credential);
    const parsedPayment = parseAp2PaymentMandate(stringValue(credential.token));

    expect(receipt.reference.ucp).toMatchObject({ checkout_id: "checkout_1", vault_token_id: "spt_123" });
    expect(merchant.requests.map((request) => request.path)).toEqual([
      "/checkout",
      "/checkout/checkout_1",
      "/checkout/checkout_1/complete"
    ]);
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      nonce: "response_payment_nonce_1",
      payment: { amount: 0, currency: "USD", checkout_id: "checkout_1" }
    });
    expect(credential).toMatchObject({ type: "ap2_payment_mandate" });
    expect(stringValue(credential.token)).toMatch(/~/);
    expect(parsedPayment.issuerPayload).toMatchObject({
      payment: { handler: "stripe" },
      payment_instrument: {
        id: "spt_123",
        type: "shared_payment_token",
        description: "Stripe Shared Payment Token (test mode)"
      }
    });
  });

  it("rejects a locked AP2 session when merchant authorization is missing", async () => {
    const merchant = await startUcpMerchant();
    const failedPurchase = ucpDriver.purchase(
      { ...intent, merchant: { ...intent.merchant, protocol: "ucp" } },
      {
        merchantUrl: merchant.baseUrl,
        merchantId: "https://coffee.example/.well-known/ucp",
        merchantProfile: { ucp: {}, signing_keys: [merchantP256PublicKey] },
        delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
        supportsSteelyardMode: true,
        ap2Locked: true,
        port: withUcpSigningKey(testPort()),
        idempotencyKey: "purchase_ucp_ap2_locked_missing_authz",
        clock: () => now,
        ap2: {
          enabled: true,
          issuer: "did:example:bank-dpc-issuer",
          checkoutNonce: "checkout_nonce_1",
          paymentNonce: "payment_nonce_1"
        }
      }
    );

    await expect(failedPurchase).rejects.toMatchObject({
      name: "Ap2SessionInconsistent",
      code: "merchant_authorization_missing"
    });
    expect(merchant.requests.map((request) => request.path)).toEqual(["/checkout"]);
  });

  it("does not fall back to Steelyard-mode when AP2 is session-locked", async () => {
    const merchant = await startUcpMerchant({ merchantAuthorization: "valid" });
    const port = withUcpSigningKey(testPort());
    const failedPurchase = ucpDriver.purchase(
      { ...intent, merchant: { ...intent.merchant, protocol: "ucp" } },
      {
        merchantUrl: merchant.baseUrl,
        merchantId: "https://coffee.example/.well-known/ucp",
        merchantProfile: { ucp: {}, signing_keys: [merchantP256PublicKey] },
        delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
        supportsSteelyardMode: true,
        ap2Locked: true,
        port,
        idempotencyKey: "purchase_ucp_ap2_locked_no_options",
        clock: () => now
      }
    );

    await expect(failedPurchase).rejects.toMatchObject({
      name: "Ap2SessionInconsistent",
      code: "agent_missing_key"
    });
    expect(port.signMandatePayloads).toHaveLength(0);
    expect(merchant.requests.map((request) => request.path)).toEqual([
      "/checkout",
      "/checkout/checkout_1",
      "/delegate"
    ]);
  });

  for (const [merchantAuthorization, reason] of [
    ["tampered_checkout", "signature_invalid"],
    ["unknown_kid", "unknown_kid"],
    ["substituted_alg", "signature_invalid"]
  ] as const) {
    it(`rejects AP2 merchant authorization before consent when it is ${merchantAuthorization}`, async () => {
      const merchant = await startUcpMerchant({ merchantAuthorization });
      const failedPurchase = ucpDriver.purchase(
        { ...intent, merchant: { ...intent.merchant, protocol: "ucp" } },
        {
          merchantUrl: merchant.baseUrl,
          merchantId: "https://coffee.example/.well-known/ucp",
          merchantProfile: { ucp: {}, signing_keys: [merchantP256PublicKey] },
          delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
          supportsSteelyardMode: false,
          port: testPort(),
          idempotencyKey: `purchase_ucp_ap2_${merchantAuthorization}`,
          clock: () => now
        }
      );
      await expect(failedPurchase).rejects.toBeInstanceOf(Ap2MerchantAuthorizationInvalid);
      await expect(failedPurchase).rejects.toMatchObject({
        name: "Ap2MerchantAuthorizationInvalid",
        code: "merchant_authorization_invalid",
        reason
      });
      expect(merchant.requests.map((request) => request.path)).toEqual(["/checkout"]);
    });
  }

  it("rejects tampered signed UCP complete responses", async () => {
    const merchant = await startUcpMerchant({ signCompleteResponse: true, tamperSignedCompleteResponse: true });
    await expect(
      ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
        merchantUrl: merchant.baseUrl,
        merchantId: "https://coffee.example/.well-known/ucp",
        merchantProfile: { ucp: {}, signing_keys: [merchantP256PublicKey] },
        delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
        supportsSteelyardMode: false,
        port: testPort(),
        idempotencyKey: "purchase_ucp_tampered_signed_response",
        clock: () => now
      })
    ).rejects.toBeInstanceOf(UcpResponseSignatureInvalid);
  });

  it("falls back to bearer auth when HMS is preferred but the port has no UCP key", async () => {
    const merchant = await startUcpMerchant();
    await ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
      merchantUrl: merchant.baseUrl,
      merchantId: "https://coffee.example/.well-known/ucp",
      delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
      supportsSteelyardMode: false,
      port: testPort(),
      idempotencyKey: "purchase_ucp_bearer",
      ucpAuth: {
        preferred: "hms",
        signing: { kid: "wallet-p256", algorithm: "ES256", profileUrl: walletProfileUrl },
        bearerToken: "bearer-token-1"
      },
      clock: () => now
    });

    const checkoutRequests = merchant.requests.filter((request) => request.path !== "/delegate");
    expect(checkoutRequests.map((request) => request.headers.authorization)).toEqual([
      "Bearer bearer-token-1",
      "Bearer bearer-token-1",
      "Bearer bearer-token-1"
    ]);
    expect(checkoutRequests.every((request) => request.headers.signature === undefined)).toBe(true);
  });

  it("throws before the first UCP request when selected HMS auth cannot sign", async () => {
    const merchant = await startUcpMerchant();
    await expect(
      ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
        merchantUrl: merchant.baseUrl,
        merchantId: "https://coffee.example/.well-known/ucp",
        delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
        supportsSteelyardMode: false,
        port: testPort(),
        idempotencyKey: "purchase_ucp_missing_auth",
        ucpAuth: {
          preferred: "hms",
          signing: { kid: "wallet-p256", algorithm: "ES256", profileUrl: walletProfileUrl }
        },
        clock: () => now
      })
    ).rejects.toBeInstanceOf(UcpAuthMissing);
    expect(merchant.requests).toHaveLength(0);
  });

  it("skips mandate signing when Steelyard mode is advertised but the port cannot sign", async () => {
    const merchant = await startUcpMerchant({ requireMandate: true });
    const port = withoutMandateKey(testPort());
    await expect(
      ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
        merchantUrl: merchant.baseUrl,
        merchantId: "https://coffee.example/.well-known/ucp",
        delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
        supportsSteelyardMode: true,
        port,
        idempotencyKey: "purchase_ucp_no_key",
        clock: () => now
      })
    ).rejects.toThrow(/mandate_required/);
    expect(port.signMandatePayloads).toHaveLength(0);
    expect(merchant.requests[3]!.body).not.toHaveProperty("steelyard.checkout_mandate");
  });

  it("completes vanilla UCP when Steelyard mode and mandate keys are both absent", async () => {
    const merchant = await startUcpMerchant();
    const port = withoutMandateKey(testPort());
    const receipt = await ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
      merchantUrl: merchant.baseUrl,
      merchantId: "https://coffee.example/.well-known/ucp",
      delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
      supportsSteelyardMode: false,
      port,
      idempotencyKey: "purchase_ucp_plain",
      clock: () => now
    });

    expect(receipt.reference.ucp).toEqual({
      checkout_id: "checkout_1",
      vault_token_id: "vt_1"
    });
    expect(port.signMandatePayloads).toHaveLength(0);
  });

  it("maps canceled and handlerless UCP checkouts to driver errors", async () => {
    await expect(
      ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
        merchantUrl: (await startUcpMerchant({ createStatus: "canceled" })).baseUrl,
        merchantId: "https://coffee.example/.well-known/ucp",
        supportsSteelyardMode: true,
        port: testPort(),
        idempotencyKey: "purchase_ucp_canceled",
        clock: () => now
      })
    ).rejects.toBeInstanceOf(UcpCanceled);

    await expect(
      ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
        merchantUrl: (await startUcpMerchant({ handlerCatalog: false })).baseUrl,
        merchantId: "https://coffee.example/.well-known/ucp",
        supportsSteelyardMode: true,
        port: testPort(),
        idempotencyKey: "purchase_ucp_no_handler",
        clock: () => now
      })
    ).rejects.toBeInstanceOf(UcpNoCompatibleHandler);
  });
});

describe("checkout driver helpers", () => {
  it("covers JSON, URL, totals, handler, and buyer fallbacks", async () => {
    expect(purchaseKey({}, intent)).toBe("purchase_1");
    expect(purchaseKey({ idempotencyKey: "explicit" }, intent)).toBe("explicit");
    expect(joinUrl("https://shop.example/base/", "checkout")).toBe("https://shop.example/base/checkout");
    expect(joinUrl(new URL("https://shop.example/base"), "/checkout")).toBe("https://shop.example/base/checkout");
    expect(asRecord(null)).toEqual({});
    expect(asRecord([])).toEqual({});
    expect(stringValue("", "fallback")).toBe("fallback");
    expect(() => checkoutTotals({ totals: "bad" })).toThrow(/expected exactly one total row/);
    await expect(notifyTotals({}, { totals: [{ type: "total", amount: 0 }], currency: "EUR" }))
      .resolves.toEqual({ amount: 0, currency: "EUR" });
    expect(billingBuyer({ name: "Ada", address: { line1: "1", city: "London", postal_code: "SW1A", country: "GB" } }))
      .toEqual({ name: "Ada", address: { line1: "1", city: "London", postal_code: "SW1A", country: "GB" } });

    expect(selectedHandler([], "https://psp.example/delegate")).toBeUndefined();
    expect(selectedHandler([{ id: "no-config", config: {} }])).toBeUndefined();
    expect(selectedHandler([{ id: "first" }], "https://psp.example/delegate")).toEqual({
      handler: { id: "first" },
      delegatePaymentUrl: "https://psp.example/delegate"
    });
    expect(selectedHandler([{ id: "configured", config: { delegate_payment_url: "https://psp.example/delegate" } }]))
      .toMatchObject({ handler: { id: "configured" }, delegatePaymentUrl: "https://psp.example/delegate" });

    const fetchEmpty = vi.fn(async () => response("", 204));
    await expect(postJson("https://shop.example/empty", {}, { idempotencyKey: "empty", fetch: fetchEmpty }))
      .resolves.toEqual({});
    const fetchPatchEmpty = vi.fn(async () => response("", 204));
    await expect(patchJson("https://shop.example/empty", {}, { idempotencyKey: "empty", fetch: fetchPatchEmpty }))
      .resolves.toEqual({});
    const fetchInvalid = vi.fn(async () => response("not json", 200));
    await expect(postJson("https://shop.example/bad", {}, { idempotencyKey: "bad", fetch: fetchInvalid }))
      .rejects.toThrow(/invalid JSON response/);
    const fetchPatchError = vi.fn(async () => response("card 4242424242424242 cvc=123", 500));
    await expect(patchJson("https://shop.example/fail", {}, { idempotencyKey: "fail", fetch: fetchPatchError }))
      .rejects.toThrow(/\[REDACTED_PAN\]/);

    expect(delegatePaymentRequest(
      { number: "5555555555554444", exp: "bad", name: "Ada" },
      {
        amount: 100,
        currency: "USD",
        checkoutId: "checkout_1",
        merchantId: "coffee.example",
        purchaseKey: "purchase",
        riskSignals: [{ type: "card_testing", score: 1, action: "authorized" }],
        clock: () => now
      }
    )).toMatchObject({
      payment_method: {
        exp_month: 1,
        exp_year: 2099,
        name: "Ada",
        display_brand: "other"
      },
      risk_signals: [{ type: "card_testing", score: 1, action: "authorized" }]
    });
  });
});

interface CapturedRequest {
  method: string;
  path: string;
  idempotencyKey?: string;
  headers: Record<string, string>;
  rawBody: string;
  body: Record<string, unknown>;
}

async function startAcpMerchant(opts: {
  createStatus?: string;
  handlerConfig?: boolean;
} = {}): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  let session: CheckoutSession | undefined;
  const server = createServer(async (req, res) => {
    const { body, rawBody } = await readJson(req);
    requests.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      idempotencyKey: idempotencyKey(req),
      headers: capturedHeaders(req),
      rawBody,
      body
    });
    if (req.method === "POST" && req.url === "/checkout_sessions") {
      session = withAcpHandler(applyCreateRequest(body, { manifest, now, sessionId: "cs_1" }).next) as CheckoutSession;
      if (opts.createStatus) session = { ...session, status: opts.createStatus as CheckoutSession["status"] };
      if (opts.handlerConfig === false) {
        session = {
          ...session,
          capabilities: {
            payment: {
              handlers: [
                {
                  id: "stripe",
                  name: "net.steelyard.stripe_spt",
                  display_name: "Stripe Shared Payment Token",
                  version: "2026-04-17",
                  spec: "https://steelyard.dev/specs/payment/stripe-spt",
                  requires_delegate_payment: true,
                  requires_pci_compliance: false,
                  psp: "stripe",
                  config_schema: "https://steelyard.dev/schemas/payment-handler-config.json",
                  instrument_schemas: ["https://steelyard.dev/schemas/stripe-spt-instrument.json"],
                  config: { instrument_type: "card", credential_type: "spt" }
                }
              ]
            }
          }
        } as CheckoutSession;
      }
      sendJson(res, 200, session);
      return;
    }
    if (req.method === "POST" && req.url === "/checkout_sessions/cs_1/complete" && session) {
      const completed = applyCompleteRequest(session, body, {
        now,
        pspResult: { ok: true, psp_payment_id: "pi_1", status: "captured" }
      }).next;
      sendJson(res, 200, completed);
      return;
    }
    if (req.method === "POST" && req.url === "/checkout_sessions/cs_1/cancel") {
      const current = session ?? withAcpHandler(applyCreateRequest({
        line_items: [{ id: intent.offer.id, name: intent.offer.title, unit_amount: intent.amount }],
        currency: intent.currency,
        capabilities: {}
      }, { manifest, now, sessionId: "cs_1" }).next) as CheckoutSession;
      sendJson(res, 200, { ...current, status: "canceled", updated_at: now.toISOString() });
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  });
  return { baseUrl: await listen(server), requests };
}

async function startUcpMerchant(
  opts: {
    createStatus?: string;
    handlerCatalog?: boolean;
    requireMandate?: boolean;
    signCompleteResponse?: boolean;
    tamperSignedCompleteResponse?: boolean;
    merchantAuthorization?: Ap2MerchantAuthorizationMode;
  } = {}
): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  let checkout: UcpCheckout | undefined;
  const server = createServer(async (req, res) => {
    const { body, rawBody } = await readJson(req);
    requests.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      idempotencyKey: idempotencyKey(req),
      headers: capturedHeaders(req),
      rawBody,
      body
    });
    if (req.method === "POST" && req.url === "/checkout") {
      checkout = await withAp2MerchantAuthorization(
        withUcpHandler(applyUcpCreate(body, { now, checkoutId: "checkout_1", currency: "USD", links: [] }).next),
        opts.merchantAuthorization
      );
      if (opts.createStatus) checkout = { ...checkout, status: opts.createStatus as UcpCheckout["status"] };
      if (opts.handlerCatalog === false) checkout = { ...checkout, ucp: { ...(checkout.ucp as Record<string, unknown>), payment_handlers: {} } };
      sendJson(res, 200, checkout);
      return;
    }
    if (req.method === "PATCH" && req.url === "/checkout/checkout_1" && checkout) {
      checkout = await withAp2MerchantAuthorization(
        applyUcpUpdate(checkout, body, { now }).next,
        opts.merchantAuthorization
      );
      sendJson(res, 200, checkout);
      return;
    }
    if (req.method === "POST" && req.url === "/delegate") {
      sendJson(res, 200, { id: "vt_1", created: now.toISOString(), metadata: {} });
      return;
    }
    if (req.method === "POST" && req.url === "/checkout/checkout_1/complete" && checkout) {
      if (opts.requireMandate && typeof body["steelyard.checkout_mandate"] !== "string") {
        sendJson(res, 400, {
          status: "canceled",
          messages: { errors: [{ code: "mandate_required", message: "Steelyard mandate required" }] }
        });
        return;
      }
      const completed = applyUcpComplete(checkout, body as { payment: { instruments: [] } }, {
        now,
        mandateOk: { subject_id: "subject_1", key_id: "mk_test" },
        pspResult: { ok: true, psp_payment_id: "pi_1", status: "captured" },
        orderId: "order_checkout_1",
        permalinkUrl: "https://coffee.example/orders/order_checkout_1"
      }).next;
      await sendMaybeSignedUcpComplete(res, completed, opts);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  });
  return { baseUrl: await listen(server), requests };
}

function testPort(): WalletDriverPort & { signMandatePayloads: Record<string, unknown>[] } {
  const signMandatePayloads: Record<string, unknown>[] = [];
  return {
    signMandatePayloads,
    billing: {
      name: "Ada Lovelace",
      email: "ada@example.com",
      address: { line1: "1 Coffee St", city: "London", postal_code: "SW1A", country: "GB" }
    },
    async withRawCard(fn) {
      return await fn({
        id: "card_1",
        pan: "4242424242424242",
        cvc: "123",
        exp: "12/30",
        name_on_card: "Ada Lovelace",
        brand: "visa",
        last4: "4242",
        tags: []
      });
    },
    async signMandate(payload) {
      signMandatePayloads.push(payload as Record<string, unknown>);
      return { jwt: "signed.jwt", key_id: "mk_test" };
    },
    async pairwiseSubject(audience) {
      return `sub:${audience}`;
    },
    async mandatePublicKey() {
      return { jwk: { kty: "OKP", crv: "Ed25519", x: "test" }, key_id: "mk_test" };
    }
  };
}

function withUcpSigningKey(
  port: WalletDriverPort & { signMandatePayloads: Record<string, unknown>[] }
): WalletDriverPort & { signMandatePayloads: Record<string, unknown>[]; ucpSignatureBases: Uint8Array[] } {
  const ucpSignatureBases: Uint8Array[] = [];
  return {
    ...port,
    ucpSignatureBases,
    async hasUcpSigningKey() {
      return true;
    },
    async exportUcpSigningPublicKey() {
      return walletP256PublicKey;
    },
    async signWithUcpKey(args) {
      ucpSignatureBases.push(args.data);
      return await ecdsaSignRaw({
        algorithm: args.algorithm,
        privateKeyJwk: walletP256PrivateKey,
        data: args.data
      });
    }
  };
}

function withoutMandateKey(
  port: WalletDriverPort & { signMandatePayloads: Record<string, unknown>[] }
): WalletDriverPort & { signMandatePayloads: Record<string, unknown>[] } {
  const plain: Partial<WalletDriverPort> & { signMandatePayloads: Record<string, unknown>[] } = { ...port };
  plain.signMandate = undefined;
  plain.pairwiseSubject = undefined;
  plain.mandatePublicKey = undefined;
  return plain as WalletDriverPort & { signMandatePayloads: Record<string, unknown>[] };
}

function withAcpHandler(session: Record<string, unknown>): Record<string, unknown> {
  return {
    ...session,
    capabilities: {
      payment: {
        handlers: [
          {
            id: "stripe",
            name: "net.steelyard.stripe_spt",
            display_name: "Stripe Shared Payment Token",
            version: "2026-04-17",
            spec: "https://steelyard.dev/specs/payment/stripe-spt",
            requires_delegate_payment: false,
            requires_pci_compliance: false,
            psp: "stripe",
            config_schema: "https://steelyard.dev/schemas/payment-handler-config.json",
            instrument_schemas: ["https://steelyard.dev/schemas/stripe-spt-instrument.json"],
            config: { instrument_type: "card", credential_type: "spt" }
          }
        ]
      }
    }
  };
}

function withUcpHandler(checkout: UcpCheckout): UcpCheckout {
  return {
    ...checkout,
    ucp: {
      ...(checkout.ucp as Record<string, unknown>),
      payment_handlers: {
        "net.steelyard": [
          {
            id: "stripe",
            version: "2026-04-17",
            spec: "https://steelyard.dev/specs/payment/vault-token",
            schema: "https://ucp.dev/schemas/payment_handler.json",
            config: { token_type: "vault_token" }
          }
        ]
      }
    }
  };
}

type Ap2MerchantAuthorizationMode = "valid" | "tampered_checkout" | "unknown_kid" | "substituted_alg";

async function withAp2MerchantAuthorization(
  checkout: UcpCheckout,
  mode: Ap2MerchantAuthorizationMode | undefined
): Promise<UcpCheckout> {
  if (!mode) return checkout;
  const jws = await ap2MerchantAuthorization(checkout, mode);
  const signed = {
    ...checkout,
    ap2: {
      checkout_nonce: "response_checkout_nonce_1",
      checkout_nonce_expires_at: "2026-06-14T12:15:00.000Z",
      payment_nonce: "response_payment_nonce_1",
      payment_nonce_expires_at: "2026-06-14T12:15:00.000Z",
      merchant_authorization: jws
    }
  };
  return mode === "tampered_checkout" ? { ...signed, currency: "EUR" } : signed;
}

async function ap2MerchantAuthorization(checkout: UcpCheckout, mode: Ap2MerchantAuthorizationMode): Promise<string> {
  const kid = mode === "unknown_kid" ? "merchant-missing" : "merchant-p256";
  const jws = await signDetachedJws({
    payload: jcsCanonicalize(checkoutWithoutAp2(checkout)),
    header: { alg: "ES256", kid },
    privateKey: merchantP256PrivateKey
  });
  return mode === "substituted_alg" ? replaceDetachedJwsHeader(jws, { alg: "ES384" }) : jws;
}

function checkoutWithoutAp2(checkout: UcpCheckout): UcpCheckout {
  const { ap2: _ap2, ...payload } = checkout;
  return payload;
}

function replaceDetachedJwsHeader(jws: string, patch: Record<string, unknown>): string {
  const [encodedHeader, empty, encodedSignature] = jws.split(".");
  if (!encodedHeader || empty !== "" || !encodedSignature) throw new Error("expected detached JWS");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<string, unknown>;
  const nextHeader = Buffer.from(JSON.stringify({ ...header, ...patch }), "utf8").toString("base64url");
  return `${nextHeader}..${encodedSignature}`;
}

async function readJson(req: IncomingMessage): Promise<{ body: Record<string, unknown>; rawBody: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return { body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, rawBody: raw };
}

function idempotencyKey(req: IncomingMessage): string | undefined {
  const value = req.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
}

function capturedHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
    else if (Array.isArray(value) && value.length) headers[name.toLowerCase()] = value.join(", ");
  }
  return headers;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function sendMaybeSignedUcpComplete(
  res: ServerResponse,
  body: UcpCheckout,
  opts: { signCompleteResponse?: boolean; tamperSignedCompleteResponse?: boolean }
): Promise<void> {
  if (!opts.signCompleteResponse) {
    sendJson(res, 200, body);
    return;
  }

  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const signed = await signUcpResponse({
    status: 200,
    headers: { "content-type": "application/json" },
    body: rawBody,
    signing: {
      kid: "merchant-p256",
      algorithm: "ES256",
      privateKey: merchantP256PrivateKey
    },
    now
  });
  const responseBody = opts.tamperSignedCompleteResponse ? { ...body, status: "canceled" } : body;
  res.writeHead(200, signed.headers);
  res.end(JSON.stringify(responseBody));
}

function response(text: string, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text
  } as Response;
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}
