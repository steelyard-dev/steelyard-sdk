// Copyright (c) Steelyard contributors. MIT License.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { defineCommerce, ecdsaSignRaw, type EcJwk, type PurchaseIntent, type WalletDriverPort } from "@steelyard/core";
import {
  applyCompleteRequest,
  applyCreateRequest,
  type CheckoutSession
} from "@steelyard/protocol/acp/checkout";
import {
  applyUcpComplete,
  applyUcpCreate,
  applyUcpUpdate,
  type Checkout as UcpCheckout
} from "@steelyard/protocol/ucp/checkout";
import { verifyUcpRequest } from "@steelyard/protocol/ucp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpCanceled,
  AcpExpired,
  AcpNoPspEndpoint,
  AcpProtocolViolation,
  acpDriver
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
  UcpCanceled,
  UcpAuthMissing,
  UcpNoCompatibleHandler,
  ucpDriver
} from "./ucp.js";

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

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("ACP checkout driver", () => {
  it("purchases through direct delegate_payment and builds an ACP receipt", async () => {
    const merchant = await startAcpMerchant();
    const totals: Array<{ amount: number; currency: string }> = [];
    const receipt = await acpDriver.purchase(intent, {
      merchantUrl: merchant.baseUrl,
      merchantId: "coffee.example",
      delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
      port: testPort(),
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
      reference: { acp: { checkout_session_id: "cs_1", vault_token_id: "vt_1" } }
    });
    expect(totals).toEqual([{ amount: 500, currency: "USD" }]);
    expect(merchant.requests.map((request) => request.idempotencyKey)).toEqual([
      "purchase_1:create",
      "purchase_1:delegate",
      "purchase_1:complete"
    ]);
    expect(merchant.requests[1]!.body).toMatchObject({
      allowance: { merchant_id: "coffee.example", max_amount: 500, currency: "usd", checkout_session_id: "cs_1" },
      payment_method: {
        type: "card",
        number: "4242424242424242",
        display_last4: "4242",
        metadata: { source: "steelyard" }
      },
      risk_signals: []
    });
    expect(merchant.requests[2]!.body).toMatchObject({
      payment_data: {
        handler_id: "stripe",
        instrument: { credential: { token: "vt_1" } }
      }
    });
  });

  it("redacts PAN and CVC from delegate_payment failures", async () => {
    const merchant = await startAcpMerchant({ delegateStatus: 500 });

    await expect(
      acpDriver.purchase(intent, {
        merchantUrl: merchant.baseUrl,
        merchantId: "coffee.example",
        delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
        port: testPort(),
        idempotencyKey: "purchase_2",
        clock: () => now
      })
    ).rejects.toThrow(/\[REDACTED_PAN\]/);
    await expect(
      acpDriver.purchase(intent, {
        merchantUrl: merchant.baseUrl,
        merchantId: "coffee.example",
        delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
        port: testPort(),
        idempotencyKey: "purchase_3",
        clock: () => now
      })
    ).rejects.not.toThrow(/4242424242424242|123/);
  });

  it("maps non-payable ACP statuses to terminal driver errors", async () => {
    await expect(
      acpDriver.purchase(intent, {
        merchantUrl: (await startAcpMerchant({ createStatus: "canceled" })).baseUrl,
        merchantId: "coffee.example",
        delegatePaymentUrl: "https://psp.example/delegate",
        port: testPort(),
        idempotencyKey: "purchase_canceled",
        clock: () => now
      })
    ).rejects.toBeInstanceOf(AcpCanceled);

    await expect(
      acpDriver.purchase(intent, {
        merchantUrl: (await startAcpMerchant({ createStatus: "expired" })).baseUrl,
        merchantId: "coffee.example",
        delegatePaymentUrl: "https://psp.example/delegate",
        port: testPort(),
        idempotencyKey: "purchase_expired",
        clock: () => now
      })
    ).rejects.toBeInstanceOf(AcpExpired);

    await expect(
      acpDriver.purchase(intent, {
        merchantUrl: (await startAcpMerchant({ createStatus: "pending_approval" })).baseUrl,
        merchantId: "coffee.example",
        delegatePaymentUrl: "https://psp.example/delegate",
        port: testPort(),
        idempotencyKey: "purchase_pending",
        clock: () => now
      })
    ).rejects.toBeInstanceOf(AcpProtocolViolation);
  });

  it("fails when ACP checkout does not advertise a PSP endpoint", async () => {
    const merchant = await startAcpMerchant({ handlerConfig: false });

    await expect(
      acpDriver.purchase(intent, {
        merchantUrl: merchant.baseUrl,
        merchantId: "coffee.example",
        port: testPort(),
        idempotencyKey: "purchase_no_psp",
        clock: () => now
      })
    ).rejects.toBeInstanceOf(AcpNoPspEndpoint);
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
  delegateStatus?: number;
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
                  name: "dev.steelyard.vault_token",
                  display_name: "Vault token",
                  version: "2026-04-17",
                  spec: "https://steelyard.dev/specs/payment/vault-token",
                  requires_delegate_payment: true,
                  requires_pci_compliance: false,
                  psp: "stripe",
                  config_schema: "https://steelyard.dev/schemas/payment-handler-config.json",
                  instrument_schemas: ["https://steelyard.dev/schemas/vault-token-instrument.json"],
                  config: {}
                }
              ]
            }
          }
        } as CheckoutSession;
      }
      sendJson(res, 200, session);
      return;
    }
    if (req.method === "POST" && req.url === "/delegate") {
      if (opts.delegateStatus) {
        sendJson(res, opts.delegateStatus, { error: "bad card 4242424242424242 cvc=123" });
        return;
      }
      sendJson(res, 200, { id: "vt_1", created: now.toISOString(), metadata: {} });
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
    sendJson(res, 404, { error: "not_found" });
  });
  return { baseUrl: await listen(server), requests };
}

async function startUcpMerchant(
  opts: { createStatus?: string; handlerCatalog?: boolean; requireMandate?: boolean } = {}
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
      checkout = withUcpHandler(applyUcpCreate(body, { now, checkoutId: "checkout_1", currency: "USD", links: [] }).next);
      if (opts.createStatus) checkout = { ...checkout, status: opts.createStatus as UcpCheckout["status"] };
      if (opts.handlerCatalog === false) checkout = { ...checkout, ucp: { ...(checkout.ucp as Record<string, unknown>), payment_handlers: {} } };
      sendJson(res, 200, checkout);
      return;
    }
    if (req.method === "PATCH" && req.url === "/checkout/checkout_1" && checkout) {
      checkout = applyUcpUpdate(checkout, body, { now }).next;
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
      sendJson(res, 200, completed);
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
            name: "dev.steelyard.vault_token",
            display_name: "Vault token",
            version: "2026-04-17",
            spec: "https://steelyard.dev/specs/payment/vault-token",
            requires_delegate_payment: true,
            requires_pci_compliance: false,
            psp: "stripe",
            config_schema: "https://steelyard.dev/schemas/payment-handler-config.json",
            instrument_schemas: ["https://steelyard.dev/schemas/vault-token-instrument.json"],
            config: {}
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
