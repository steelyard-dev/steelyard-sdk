import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "@steelyard/buyer";
import type { Merchant } from "@steelyard/buyer/client";
import type { Offer, Price, PurchaseIntent, Receipt } from "@steelyard/core";
import { stripePsp, type PspAdapter, type PspCaptureResult } from "@steelyard/merchant/psp";
import { createStripeSptIssuer } from "@steelyard/stripe/buyer";
import {
  startCoffeeShopCheckoutServer,
  type RunningCoffeeShopCheckout
} from "../src/checkout-server.js";

export const stripeSmokeIssuer = "did:example:coffee-dpc-issuer";
export const stripeSmokeAcpBearerToken = "coffee-shop-acp-stripe-smoke";

export interface StripeSmokeConfig {
  apiKey: string;
  mockStripe: boolean;
}

export interface StripeSmokeHarness {
  wallet: Wallet;
  shop: RunningCoffeeShopCheckout;
  signingKid: string;
  captures: PspCaptureResult[];
  cleanup(): Promise<void>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export function stripeSmokeConfigOrSkip(): StripeSmokeConfig | undefined {
  const apiKey = process.env.STRIPE_TEST_SECRET_KEY;
  if (process.env.STEELYARD_MOCK_STRIPE === "1") {
    return { apiKey: apiKey ?? "sk_test_mock", mockStripe: true };
  }
  if (apiKey) return { apiKey, mockStripe: false };
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "STRIPE_TEST_SECRET_KEY is not set"
  }, null, 2));
  return undefined;
}

export async function startStripeSmokeHarness(
  config: StripeSmokeConfig,
  opts: { acpBearerToken?: string } = {}
): Promise<StripeSmokeHarness> {
  const root = await mkdtemp(join(tmpdir(), "steelyard-stripe-smoke-"));
  const cwd = process.cwd();
  process.chdir(root);

  const stripeFetch = config.mockStripe ? mockStripeFetch() : undefined;
  const captures: PspCaptureResult[] = [];
  let wallet: Wallet | undefined;
  let shop: RunningCoffeeShopCheckout | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    process.chdir(cwd);
    await Promise.allSettled([wallet?.close(), shop?.close()]);
    await rm(root, { recursive: true, force: true });
  };

  try {
    wallet = await Wallet.create({
      project: true,
      password: "example-password",
      card: { number: "4242424242424242", exp: "12/30", name: "Example Buyer" },
      billing: {
        email: "buyer@example.com",
        address: { line1: "1 Market St", city: "San Francisco", postal_code: "94105", country: "US" }
      },
      limits: { daily: { USD: 100 } },
      allowedMerchants: ["coffee.example"],
      paymentIssuer: createStripeSptIssuer({
        apiKey: config.apiKey,
        ...(stripeFetch ? { fetch: stripeFetch } : {})
      })
    });
    const signing = await wallet.createUcpSigningKey({ algorithm: "ES256" });
    const buyerPublicKey = await wallet.exportUcpSigningPublicKey();
    shop = await startCoffeeShopCheckoutServer({
      ap2: true,
      ap2Issuer: stripeSmokeIssuer,
      steelyardMandate: false,
      buyerSigningKeys: [buyerPublicKey],
      psp: recordingPsp(stripePsp({
        apiKey: config.apiKey,
        acceptSharedPaymentTokens: true,
        ...(stripeFetch ? { fetch: stripeFetch } : {})
      }), captures),
      paymentHandlers: ["stripe"],
      ...(opts.acpBearerToken ? { acpBearerToken: opts.acpBearerToken } : {})
    });
    return { wallet, shop, signingKid: signing.kid, captures, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function intentFromOffer(offer: Offer, transportUrl: string, protocol: "acp" | "ucp"): PurchaseIntent {
  const price = offer.pricing.find((item): item is Extract<Price, { kind: "one_time" }> => item.kind === "one_time");
  if (!price) throw new Error(`offer ${offer.id} has no one-time price`);
  return {
    merchant: { domain: "coffee.example", transport_url: transportUrl, protocol },
    offer: { id: offer.id, title: offer.title, categories: offer.categories },
    amount: price.amount,
    currency: price.currency,
    intent_id: `coffee_stripe_${protocol}_${offer.id}_${Date.now().toString(36)}`
  };
}

export function assertStripeReceipt(
  receipt: Receipt,
  protocol: "acp" | "ucp",
  capture?: PspCaptureResult
): void {
  const expectedStatuses = protocol === "acp" ? new Set(["captured", "completed"]) : new Set(["completed"]);
  if (receipt.protocol !== protocol || !expectedStatuses.has(receipt.status)) {
    throw new Error(`${protocol.toUpperCase()} Stripe smoke did not complete: ${JSON.stringify(receipt)}`);
  }
  const reference = protocol === "ucp" ? receipt.reference.ucp : receipt.reference.acp;
  if (!reference) throw new Error(`${protocol.toUpperCase()} receipt missing protocol reference`);
  if (!/^spt_[A-Za-z0-9]+$/.test(reference.vault_token_id)) {
    throw new Error(`receipt did not record an SPT id: ${JSON.stringify(reference)}`);
  }
  if (capture && !capture.ok) throw new Error(`Stripe PSP capture failed: ${JSON.stringify(capture)}`);
  const pspPaymentId = reference.psp_payment_id ?? (capture?.ok ? capture.psp_payment_id : undefined);
  const pspChargeStatus = reference.psp_charge_status ?? (capture?.ok ? capture.psp_charge_status : undefined);
  if (!/^pi_[A-Za-z0-9]+$/.test(pspPaymentId ?? "")) {
    throw new Error(`receipt did not record a Stripe PaymentIntent id: ${JSON.stringify(reference)}`);
  }
  if (pspChargeStatus !== "succeeded") {
    throw new Error(`Stripe charge did not succeed: ${JSON.stringify(reference)}`);
  }
}

export function assertUcpStripeHandler(discovery: Record<string, unknown>): void {
  const handlers = record(record(discovery.ucp).payment_handlers)["net.steelyard"];
  const values = Array.isArray(handlers) ? handlers.map(record) : [];
  const stripe = values.find((handler) => handler.id === "stripe");
  if (!stripe) throw new Error("UCP discovery did not advertise net.steelyard/stripe");
  const instruments = Array.isArray(stripe.available_instruments)
    ? stripe.available_instruments.map(record)
    : [];
  if (!instruments.some((instrument) => instrument.type === "shared_payment_token")) {
    throw new Error("UCP stripe handler did not advertise shared_payment_token");
  }
}

export function installFetchRecorder(origin: string): { requests: RecordedRequest[]; restore(): void } {
  const original = globalThis.fetch.bind(globalThis);
  const requests: RecordedRequest[] = [];
  const expectedOrigin = new URL(origin).origin;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = fetchUrl(input);
    const parsed = new URL(url);
    if (parsed.origin === expectedOrigin) {
      requests.push({
        method: fetchMethod(input, init),
        path: parsed.pathname,
        url,
        headers: headersRecord(init?.headers),
        body: requestBody(init?.body)
      });
    }
    return await original(input, init);
  }) as typeof fetch;
  return {
    requests,
    restore() {
      globalThis.fetch = original as typeof fetch;
    }
  };
}

export async function json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

export function isMerchant(value: unknown): value is Merchant {
  return !!value && typeof value === "object" && "purchase" in value;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mockStripeFetch(): typeof fetch {
  return async (input, init) => {
    const url = new URL(fetchUrl(input));
    if (url.origin !== "https://api.stripe.com") return await fetch(input, init);
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    const suffix = Date.now().toString(36);
    if (url.pathname === "/v1/shared_payment/issued_tokens") {
      return jsonResponse({
        id: `spt_${suffix}`,
        expires_at: Number(body.get("usage_limits[expires_at]") ?? Math.floor(Date.now() / 1000) + 900),
        max_amount: Number(body.get("usage_limits[max_amount]") ?? 0),
        currency: String(body.get("usage_limits[currency]") ?? "usd")
      });
    }
    if (url.pathname === "/v1/payment_intents" && (init?.method ?? "GET").toUpperCase() === "POST") {
      return jsonResponse({
        id: `pi_${suffix}`,
        status: "succeeded",
        latest_charge: { id: `ch_${suffix}`, status: "succeeded" }
      });
    }
    return jsonResponse({ error: { code: "mock_not_found", message: "mock Stripe endpoint not found" } }, 404);
  };
}

function recordingPsp(psp: PspAdapter, captures: PspCaptureResult[]): PspAdapter {
  return {
    ...psp,
    async capture(args) {
      const result = await psp.capture(args);
      captures.push(result);
      return result;
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function fetchMethod(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] | undefined): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input !== "string" && !(input instanceof URL) && input.method) return input.method.toUpperCase();
  return "GET";
}

function requestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  return undefined;
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new Headers(headers).entries()) out[key.toLowerCase()] = value;
  return out;
}
