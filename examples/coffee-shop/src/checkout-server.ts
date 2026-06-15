import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { buildAcpFeed } from "@steelyard/protocol/acp";
import { buildUcpDiscovery } from "@steelyard/protocol/ucp";
import {
  createMerchantCheckout,
  memoryCheckoutSessionStore,
  memoryIdempotencyStore
} from "@steelyard/merchant/checkout";
import type { MandateVerifier } from "@steelyard/merchant/mandate";
import { mockMandateVerifier } from "@steelyard/merchant/mandate";
import { mockPsp, mockVaultToken } from "@steelyard/merchant/psp";
import { coffeeShopManifest } from "./catalog.js";
import { createCoffeeShopHandler } from "./server.js";

export interface RunningCoffeeShopCheckout {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

export interface RunningDelegatePayment {
  baseUrl: string;
  delegatePaymentUrl: string;
  server: Server;
  close(): Promise<void>;
}

export async function startCoffeeShopCheckoutServer(opts: {
  clock?: () => Date;
  mandateVerifier?: MandateVerifier;
  steelyardMandate?: boolean;
} = {}): Promise<RunningCoffeeShopCheckout> {
  let baseUrl = "";
  let checkout: ReturnType<typeof createMerchantCheckout> | undefined;
  const steelyardMandate = opts.steelyardMandate ?? true;
  const read = createCoffeeShopHandler();
  const server = createServer((req, res) => {
    const path = requestPath(req);
    if (path === "/acp/feed") {
      sendJson(res, 200, checkoutAcpFeed());
      return;
    }
    if (path === "/.well-known/ucp") {
      sendJson(res, 200, buildUcpDiscovery(coffeeShopManifest, {
        baseUrl,
        checkout: true,
        steelyardMandate
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
    if (path.startsWith("/acp/") || path.startsWith("/ucp/")) {
      checkout.handler(req, res);
      return;
    }
    read(req, res);
  });

  baseUrl = await listen(server);
  const mandateVerifier = steelyardMandate
    ? opts.mandateVerifier ?? mockMandateVerifier({
      allowInProduction: true,
      alwaysOk: { subject_id: "buyer_example", key_id: "mk_example" }
    })
    : opts.mandateVerifier;
  checkout = createMerchantCheckout(coffeeShopManifest, {
    protocols: ["acp", "ucp"],
    store: memoryCheckoutSessionStore(),
    idempotency: memoryIdempotencyStore(),
    psp: mockPsp({ allowInProduction: true }),
    ...(mandateVerifier ? { mandateVerifier } : {}),
    steelyardMandate,
    clock: opts.clock,
    baseUrl,
    merchantAudience: `${baseUrl}/.well-known/ucp`
  });

  return {
    baseUrl,
    server,
    close: () => closeServer(server)
  };
}

export async function startMockDelegatePaymentServer(opts: {
  clock?: () => Date;
} = {}): Promise<RunningDelegatePayment> {
  const clock = opts.clock ?? (() => new Date());
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || requestPath(req) !== "/agentic_commerce/delegate_payment") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const body = await readJson(req);
    const payment = record(body.payment_method);
    const idempotencyKey = header(req, "idempotency-key") ?? `delegate_${clock().getTime()}`;
    const credential = stringValue(payment.number, stringValue(payment.pan, "mock-card"));
    sendJson(res, 200, {
      id: mockVaultToken({ idempotencyKey, paymentCredential: credential }),
      created: clock().toISOString(),
      metadata: { source: "coffee-shop-example" }
    });
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    delegatePaymentUrl: `${baseUrl}/agentic_commerce/delegate_payment`,
    server,
    close: () => closeServer(server)
  };
}

function checkoutAcpFeed(): Record<string, unknown> {
  return {
    ...buildAcpFeed(coffeeShopManifest),
    merchant: { id: "coffee.example", domain: "coffee.example" },
    capabilities: { services: ["read", "checkout"] }
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
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
