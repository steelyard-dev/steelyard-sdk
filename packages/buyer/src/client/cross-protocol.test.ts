// Copyright (c) Steelyard contributors. MIT License.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommerce, type Manifest, type PurchaseIntent, type PaymentMandateIssuer } from "@steelyard/core";
import { buildAcpFeed } from "@steelyard/protocol/acp";
import { buildUcpDiscovery } from "@steelyard/protocol/ucp";
import {
  createCheckoutServer,
  memoryCheckoutSessionStore,
  memoryIdempotencyStore
} from "@steelyard/merchant/checkout";
import { mockMandateVerifier, type MandateVerifier } from "@steelyard/merchant/mandate";
import { mockPsp, mockVaultToken } from "@steelyard/merchant/psp";
import { afterEach, describe, expect, it } from "vitest";
import { Wallet } from "../wallet/index.js";
import { Steelyard } from "./index.js";

const manifest = defineCommerce({
  identity: { name: "Acme Coffee", domain: "coffee.example", currencies: ["USD"] },
  offers: [
    {
      id: "latte",
      title: "Latte",
      categories: ["coffee"],
      pricing: [{ kind: "one_time", amount: 500, currency: "USD" }]
    }
  ]
});

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("wallet checkout across ACP and UCP", () => {
  it("purchases the same intent through both protocols and records both receipts", async () => {
    const clock = () => new Date();
    const delegate = await startDelegatePaymentServer(clock);
    const merchant = await startMerchantCheckout(manifest, clock);
    const root = await mkdtemp(join(tmpdir(), "steelyard-cross-protocol-"));
    const cwd = process.cwd();

    try {
      process.chdir(root);
      const wallet = await Wallet.create({
        project: true,
        password: "example-password",
        card: { number: "4242424242424242", exp: "12/30", name: "Example Buyer" },
        billing: {
          email: "buyer@example.com",
          address: { line1: "1 Market St", city: "San Francisco", postal_code: "94105", country: "US" }
        },
        limits: { daily: { USD: 100 } },
        allowedMerchants: ["coffee.example"],
        paymentMandateIssuer: mockPaymentMandateIssuer()
      });

      try {
        const acpMerchant = await Steelyard.connect(`${merchant.baseUrl}/acp/feed`);
        if ("error" in acpMerchant) throw new Error(acpMerchant.error_detail ?? acpMerchant.error);
        const ucpMerchant = await Steelyard.connect(`${merchant.baseUrl}/.well-known/ucp`, {
          allowPrivateNetwork: true,
          delegatePaymentUrl: delegate.delegatePaymentUrl
        });
        if ("error" in ucpMerchant) throw new Error(ucpMerchant.error_detail ?? ucpMerchant.error);

        const acpReceipt = await wallet.purchase(intent("acp", acpMerchant.url), {
          merchant: acpMerchant,
          idempotencyKey: "cross_protocol_acp",
          clock
        });
        const ucpReceipt = await wallet.purchase(intent("ucp", ucpMerchant.url), {
          merchant: ucpMerchant,
          idempotencyKey: "cross_protocol_ucp",
          clock
        });

        expect({ amount: acpReceipt.charged_amount, currency: acpReceipt.charged_currency }).toEqual({
          amount: ucpReceipt.charged_amount,
          currency: ucpReceipt.charged_currency
        });
        expect(acpReceipt).toMatchObject({
          protocol: "acp",
          status: "captured",
          charged_amount: 500,
          charged_currency: "USD"
        });
        expect(ucpReceipt).toMatchObject({
          protocol: "ucp",
          status: "completed",
          charged_amount: 500,
          charged_currency: "USD"
        });
        expect(acpReceipt.reference.acp?.checkout_session_id).toMatch(/^cs_/);
        expect(acpReceipt.reference.ucp).toBeUndefined();
        expect(ucpReceipt.reference.ucp?.checkout_id).toMatch(/^checkout_/);
        expect(ucpReceipt.reference.acp).toBeUndefined();

        expect(await wallet.pendingReservations()).toEqual([]);
        expect((await wallet.listReceipts()).map((receipt) => receipt.order_id).sort()).toEqual(
          [acpReceipt.order_id, ucpReceipt.order_id].sort()
        );
        expect(await wallet.spendInWindow("daily", "USD")).toEqual({ pending: 0, captured: 1000 });
        expect(merchant.mandateLog).toEqual([{ audience: `${merchant.baseUrl}/.well-known/ucp` }]);
      } finally {
        await wallet.close();
      }
    } finally {
      process.chdir(cwd);
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

function intent(protocol: "acp" | "ucp", transportUrl: string): PurchaseIntent {
  return {
    merchant: { domain: "coffee.example", transport_url: transportUrl, protocol },
    offer: { id: "latte", title: "Latte", categories: ["coffee"] },
    amount: 500,
    currency: "USD",
    intent_id: `cross_protocol_${protocol}`
  };
}

async function startMerchantCheckout(
  commerce: Manifest,
  clock: () => Date
): Promise<{ baseUrl: string; mandateLog: Array<{ audience: string }> }> {
  const mandateLog: Array<{ audience: string }> = [];
  const baseVerifier = mockMandateVerifier({ alwaysOk: { subject_id: "buyer_1", key_id: "mk_test" } });
  const verifier: MandateVerifier = {
    async verify(envelope, checkout, audience) {
      mandateLog.push({ audience });
      return baseVerifier.verify(envelope, checkout, audience);
    }
  };
  let baseUrl = "";
  let checkout: ReturnType<typeof createCheckoutServer> | undefined;
  const server = createServer((req, res) => {
    const path = requestPath(req);
    if (path === "/acp/feed") {
      sendJson(res, 200, {
        ...buildAcpFeed(commerce),
        merchant: { id: "coffee.example", domain: "coffee.example" },
        capabilities: { services: ["read", "checkout"] }
      });
      return;
    }
    if (path === "/.well-known/ucp") {
      sendJson(res, 200, buildUcpDiscovery(commerce, {
        baseUrl,
        checkout: true,
        steelyardMandate: true
      }));
      return;
    }
    if (!checkout) {
      sendJson(res, 503, { error: "checkout_not_ready" });
      return;
    }
    if (path === "/api/checkout" || path.startsWith("/api/checkout/")) {
      req.url = `/ucp${req.url ?? ""}`;
      checkout.handler(req, res);
      return;
    }
    checkout.handler(req, res);
  });
  baseUrl = await listen(server);
  checkout = createCheckoutServer(commerce, {
    protocols: ["acp", "ucp"],
    store: memoryCheckoutSessionStore(),
    idempotency: memoryIdempotencyStore(),
    psp: { ...mockPsp({ handlerIds: ["stripe"] }), name: "stripe" },
    mandateVerifier: verifier,
    steelyardMandate: true,
    ucp: { paymentHandlers: ["stripe"] },
    clock,
    baseUrl,
    merchantAudience: `${baseUrl}/.well-known/ucp`
  });
  return { baseUrl, mandateLog };
}

function mockPaymentMandateIssuer(): PaymentMandateIssuer {
  return {
    instrumentType: "shared_payment_token",
    async issueMandate(mandate) {
      return {
        id: "spt_cross_protocol",
        expires_at: Math.floor(Date.parse(mandate.payment.expires_at) / 1000),
        max_amount: mandate.payment.amount,
        currency: mandate.payment.currency,
        scope_proof: {
          type: "stripe_spt_usage_limits",
          idempotency_key: `spt_${mandate.nonce.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`
        }
      };
    }
  };
}

async function startDelegatePaymentServer(clock: () => Date): Promise<{ delegatePaymentUrl: string }> {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || requestPath(req) !== "/agentic_commerce/delegate_payment") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const body = await readJson(req);
    const idempotencyKey = header(req, "idempotency-key") ?? `delegate_${clock().getTime()}`;
    const payment = record(body.payment_method);
    const credential = stringValue(payment.number, "mock-card");
    sendJson(res, 200, {
      id: mockVaultToken({ idempotencyKey, paymentMandate: credential }),
      created: clock().toISOString(),
      metadata: {}
    });
  });
  const baseUrl = await listen(server);
  return { delegatePaymentUrl: `${baseUrl}/agentic_commerce/delegate_payment` };
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}
