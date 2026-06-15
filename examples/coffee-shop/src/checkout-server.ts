import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createUcpBuyerProfileHandler } from "@steelyard/buyer/client";
import type { EcJwk } from "@steelyard/core";
import { buildAcpFeed } from "@steelyard/protocol/acp";
import { buildUcpDiscovery } from "@steelyard/protocol/ucp";
import {
  createMerchantCheckout,
  memoryCheckoutSessionStore,
  memoryIdempotencyStore,
  type MerchantCheckoutOpts
} from "@steelyard/merchant/checkout";
import type { MandateVerifier } from "@steelyard/merchant/mandate";
import { mockMandateVerifier } from "@steelyard/merchant/mandate";
import { mockPsp, mockVaultToken } from "@steelyard/merchant/psp";
import { coffeeShopManifest } from "./catalog.js";
import {
  buyerDemoUcpPublicKey,
  coffeeShopBearerToken,
  merchantDemoUcpPrivateKey
} from "./demo-ucp-keys.js";
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

export type CoffeeShopUcpAuthMode = "hms-and-bearer" | "hms" | "bearer" | "none";

export async function startCoffeeShopCheckoutServer(opts: {
  clock?: () => Date;
  mandateVerifier?: MandateVerifier;
  steelyardMandate?: boolean;
  buyerSigningKeys?: readonly EcJwk[];
  bearerToken?: string;
  ucpAuthMode?: CoffeeShopUcpAuthMode;
} = {}): Promise<RunningCoffeeShopCheckout> {
  let baseUrl = "";
  let checkout: ReturnType<typeof createMerchantCheckout> | undefined;
  const steelyardMandate = opts.steelyardMandate ?? true;
  const ucpAuthMode = opts.ucpAuthMode ?? "hms-and-bearer";
  const buyerProfile = createUcpBuyerProfileHandler({
    signingKeys: opts.buyerSigningKeys ?? [buyerDemoUcpPublicKey]
  });
  const read = createCoffeeShopHandler();
  const server = createServer((req, res) => {
    const path = requestPath(req);
    if (path === "/acp/feed") {
      sendJson(res, 200, checkoutAcpFeed());
      return;
    }
    if (path === "/buyer/.well-known/ucp") {
      buyerProfile(req, res);
      return;
    }
    if (path === "/.well-known/ucp") {
      sendJson(res, 200, buildUcpDiscovery(coffeeShopManifest, {
        baseUrl,
        checkout: true,
        steelyardMandate,
        ucp: discoveryUcpConfig(ucpAuthMode)
      }));
      return;
    }
    if (!checkout) {
      sendJson(res, 503, { error: "checkout_not_ready" });
      return;
    }
    if (path === "/api/checkout" || path.startsWith("/api/checkout/")) {
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
    merchantAudience: `${baseUrl}/.well-known/ucp`,
    ucp: checkoutUcpConfig(ucpAuthMode, opts.bearerToken ?? coffeeShopBearerToken)
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

function discoveryUcpConfig(mode: CoffeeShopUcpAuthMode) {
  if (mode !== "hms" && mode !== "hms-and-bearer") return undefined;
  return {
    auth: {
      hms: {
        enabled: true,
        signingKeys: [merchantDemoUcpPrivateKey]
      }
    }
  };
}

function checkoutUcpConfig(
  mode: CoffeeShopUcpAuthMode,
  bearerToken: string
): MerchantCheckoutOpts["ucp"] | undefined {
  if (mode === "none") return undefined;
  const hmsEnabled = mode === "hms" || mode === "hms-and-bearer";
  const bearerEnabled = mode === "bearer" || mode === "hms-and-bearer";
  return {
    allowPrivateNetwork: true,
    responseSigningPolicy: "high-value-only",
    auth: {
      ...(hmsEnabled
        ? {
            hms: {
              enabled: true,
              signingKeys: [
                {
                  kid: merchantDemoUcpPrivateKey.kid,
                  privateKeyJwk: merchantDemoUcpPrivateKey,
                  algorithm: "ES256" as const
                }
              ],
              activeKid: merchantDemoUcpPrivateKey.kid
            }
          }
        : {}),
      ...(bearerEnabled
        ? {
            bearer: {
              enabled: true,
              verify: (token: string) =>
                token === bearerToken
                  ? { ok: true as const, subject: "buyer_example" }
                  : { ok: false as const, reason: "invalid bearer token" }
            }
          }
        : {})
    }
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
