// Copyright (c) Steelyard contributors. MIT License.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { defineCommerce, type PurchaseIntent, type WalletDriverPort } from "@steelyard/core";
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
import { afterEach, describe, expect, it } from "vitest";
import { acpDriver } from "./acp.js";
import { ucpDriver } from "./ucp.js";

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

  it("refuses UCP Steelyard mandates when the merchant mode is absent", async () => {
    const merchant = await startUcpMerchant();
    await expect(
      ucpDriver.purchase({ ...intent, merchant: { ...intent.merchant, protocol: "ucp" } }, {
        merchantUrl: merchant.baseUrl,
        merchantId: "https://coffee.example/.well-known/ucp",
        delegatePaymentUrl: `${merchant.baseUrl}/delegate`,
        supportsSteelyardMode: false,
        port: testPort(),
        idempotencyKey: "purchase_ucp_blocked",
        clock: () => now
      })
    ).rejects.toThrow(/does not advertise Steelyard/);
    expect(merchant.requests.map((request) => request.idempotencyKey)).toEqual(["purchase_ucp_blocked:create"]);
  });
});

interface CapturedRequest {
  path: string;
  idempotencyKey?: string;
  body: Record<string, unknown>;
}

async function startAcpMerchant(opts: { delegateStatus?: number } = {}): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  let session: CheckoutSession | undefined;
  const server = createServer(async (req, res) => {
    const body = await readJson(req);
    requests.push({ path: req.url ?? "/", idempotencyKey: idempotencyKey(req), body });
    if (req.method === "POST" && req.url === "/checkout_sessions") {
      session = withAcpHandler(applyCreateRequest(body, { manifest, now, sessionId: "cs_1" }).next) as CheckoutSession;
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

async function startUcpMerchant(): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  let checkout: UcpCheckout | undefined;
  const server = createServer(async (req, res) => {
    const body = await readJson(req);
    requests.push({ path: req.url ?? "/", idempotencyKey: idempotencyKey(req), body });
    if (req.method === "POST" && req.url === "/checkout") {
      checkout = withUcpHandler(applyUcpCreate(body, { now, checkoutId: "checkout_1", currency: "USD", links: [] }).next);
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function idempotencyKey(req: IncomingMessage): string | undefined {
  const value = req.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}
