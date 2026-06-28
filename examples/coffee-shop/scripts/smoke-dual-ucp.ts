import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, referenceMandate } from "@steelyard/buyer";
import { Steelyard } from "@steelyard/buyer/client";
import type { Offer, Price, PurchaseIntent, Receipt } from "@steelyard/core";
import {
  REFERENCE_PAYMENT_HANDLER_ID,
  REFERENCE_PAYMENT_INSTRUMENT_TYPE,
  REFERENCE_PAYMENT_TOKEN_PREFIX,
  referencePsp,
  type PspAdapter,
  type PspCaptureResult
} from "@steelyard/merchant/psp";
import {
  startCoffeeShopCheckoutServer,
  type RunningCoffeeShopCheckout
} from "../src/checkout-server.js";
import {
  buyerDemoUcpPrivateKey,
  buyerDemoUcpPublicKey
} from "../src/demo-ucp-keys.js";
import {
  assertUcpStripeHandler,
  installFetchRecorder,
  isMerchant,
  json,
  record,
  startStripeSmokeHarness,
  stripeSmokeConfigOrSkip
} from "./stripe-smoke-common.js";

const now = new Date("2026-06-14T12:00:00.000Z");

if (process.env.STEELYARD_ALLOW_REFERENCE_PSP !== "1") {
  throw new Error("STEELYARD_ALLOW_REFERENCE_PSP=1 is required to run the dual UCP smoke");
}

const config = stripeSmokeConfigOrSkip();
if (!config) process.exit(0);

const stripeHarness = await startStripeSmokeHarness(config, {
  ap2: false,
  ucpAuthMode: "none"
});
let stripeReceipt: Receipt;
try {
  const discovery = await json(`${stripeHarness.shop.baseUrl}/.well-known/ucp`);
  assertUcpStripeHandler(discovery);
  stripeReceipt = await purchaseUcp(stripeHarness.wallet, stripeHarness.shop, "coffee_dual_ucp_stripe");
  assertStripeLikeUcpReceipt(stripeReceipt, stripeHarness.captures.at(-1));
} finally {
  await stripeHarness.cleanup();
}

const referenceHarness = await startReferenceSmokeHarness();
const recorder = installFetchRecorder(referenceHarness.shop.baseUrl);
try {
  const discovery = await json(`${referenceHarness.shop.baseUrl}/.well-known/ucp`);
  assertReferenceHandler(discovery);
  const referenceReceipt = await purchaseUcp(referenceHarness.wallet, referenceHarness.shop, "coffee_dual_ucp_reference");
  assertReferenceReceipt(referenceReceipt, referenceHarness.captures.at(-1), recorder.requests);
  assertSameReceiptShapeAndOutcome(stripeReceipt, referenceReceipt);

  console.log(JSON.stringify({
    ok: true,
    mock_stripe: config.mockStripe,
    stripe: summary(stripeReceipt),
    reference: summary(referenceReceipt)
  }, null, 2));
} finally {
  recorder.restore();
  await referenceHarness.cleanup();
}

interface ReferenceSmokeHarness {
  wallet: Wallet;
  shop: RunningCoffeeShopCheckout;
  captures: PspCaptureResult[];
  cleanup(): Promise<void>;
}

async function startReferenceSmokeHarness(): Promise<ReferenceSmokeHarness> {
  const root = await mkdtemp(join(tmpdir(), "steelyard-reference-smoke-"));
  const cwd = process.cwd();
  process.chdir(root);

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
      allowedMerchants: ["coffee.example"]
    });
    await wallet.addInstrument(referenceMandate({
      signingKey: buyerDemoUcpPrivateKey,
      allowInProduction: true,
      clock: () => now
    }));
    shop = await startCoffeeShopCheckoutServer({
      clock: () => now,
      steelyardMandate: false,
      ucpAuthMode: "none",
      psp: recordingPsp(referencePsp({
        signingKey: buyerDemoUcpPublicKey,
        allowInProduction: true,
        clock: () => now
      }), captures),
      paymentHandlers: [REFERENCE_PAYMENT_HANDLER_ID]
    });
    return { wallet, shop, captures, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function purchaseUcp(wallet: Wallet, shop: RunningCoffeeShopCheckout, idempotencyKey: string): Promise<Receipt> {
  const merchant = await Steelyard.connect(`${shop.baseUrl}/.well-known/ucp`, {
    allowPrivateNetwork: true
  });
  if (!isMerchant(merchant)) throw new Error(`UCP connect failed: ${JSON.stringify(merchant)}`);
  if (!merchant.supports("checkout")) throw new Error("UCP merchant did not advertise checkout");

  const offer = await merchant.getOffer("single");
  if ("error" in offer) throw new Error(offer.error_detail ?? offer.error);
  return await wallet.purchase(intentFromOffer(offer, merchant.url), { merchant, idempotencyKey });
}

function intentFromOffer(offer: Offer, transportUrl: string): PurchaseIntent {
  const price = offer.pricing.find((item): item is Extract<Price, { kind: "one_time" }> => item.kind === "one_time");
  if (!price) throw new Error(`offer ${offer.id} has no one-time price`);
  return {
    merchant: { domain: "coffee.example", transport_url: transportUrl, protocol: "ucp" },
    offer: { id: offer.id, title: offer.title, categories: offer.categories },
    amount: price.amount,
    currency: price.currency,
    intent_id: `coffee_dual_ucp_${offer.id}_${Date.now().toString(36)}`
  };
}

function assertReferenceHandler(discovery: Record<string, unknown>): void {
  const handlers = record(record(discovery.ucp).payment_handlers)["net.steelyard"];
  const values = Array.isArray(handlers) ? handlers.map(record) : [];
  const reference = values.find((handler) => handler.id === REFERENCE_PAYMENT_HANDLER_ID);
  if (!reference) throw new Error("UCP discovery did not advertise the reference payment handler");
  const instruments = Array.isArray(reference.available_instruments)
    ? reference.available_instruments.map(record)
    : [];
  if (!instruments.some((instrument) => instrument.type === REFERENCE_PAYMENT_INSTRUMENT_TYPE)) {
    throw new Error("UCP reference handler did not advertise delegated_payment_token");
  }
}

function assertStripeLikeUcpReceipt(receipt: Receipt, capture: PspCaptureResult | undefined): void {
  if (receipt.protocol !== "ucp" || receipt.status !== "completed") {
    throw new Error(`Stripe UCP smoke did not complete: ${JSON.stringify(receipt)}`);
  }
  if (!receipt.reference.ucp?.vault_token_id.startsWith("spt_")) {
    throw new Error(`Stripe UCP receipt did not record an SPT: ${JSON.stringify(receipt.reference.ucp)}`);
  }
  if (!capture?.ok) throw new Error(`Stripe UCP capture failed: ${JSON.stringify(capture)}`);
}

function assertReferenceReceipt(
  receipt: Receipt,
  capture: PspCaptureResult | undefined,
  requests: { method: string; path: string; body?: unknown }[]
): void {
  if (receipt.protocol !== "ucp" || receipt.status !== "completed") {
    throw new Error(`Reference UCP smoke did not complete: ${JSON.stringify(receipt)}`);
  }
  const reference = receipt.reference.ucp;
  if (!reference?.vault_token_id.startsWith(REFERENCE_PAYMENT_TOKEN_PREFIX)) {
    throw new Error(`Reference UCP receipt did not record a delegated token: ${JSON.stringify(reference)}`);
  }
  if (!capture?.ok || !capture.psp_payment_id.startsWith("psp_reference_")) {
    throw new Error(`Reference PSP capture failed: ${JSON.stringify(capture)}`);
  }
  if (requests.some((request) => request.path.includes("delegate_payment"))) {
    throw new Error("Reference UCP smoke unexpectedly called delegate_payment");
  }
  const complete = requests.find((request) =>
    request.method === "POST"
    && /^\/api\/checkout\/[^/]+\/complete$/.test(request.path)
  );
  if (!complete) throw new Error("Reference UCP smoke did not complete a checkout");
  const instruments = record(record(complete.body).payment).instruments;
  const selected = Array.isArray(instruments) ? record(instruments[0]) : {};
  const credential = record(selected.credential);
  if (
    selected.handler_id !== REFERENCE_PAYMENT_HANDLER_ID
    || selected.type !== REFERENCE_PAYMENT_INSTRUMENT_TYPE
    || !String(credential.token ?? "").startsWith(REFERENCE_PAYMENT_TOKEN_PREFIX)
  ) {
    throw new Error(`Reference UCP complete used the wrong payment instrument: ${JSON.stringify(selected)}`);
  }
}

function assertSameReceiptShapeAndOutcome(stripe: Receipt, reference: Receipt): void {
  const stripeShape = comparableReceipt(stripe);
  const referenceShape = comparableReceipt(reference);
  if (JSON.stringify(stripeShape) !== JSON.stringify(referenceShape)) {
    throw new Error(`UCP receipt shape/outcome mismatch: ${JSON.stringify({ stripeShape, referenceShape })}`);
  }
}

function comparableReceipt(receipt: Receipt): Record<string, unknown> {
  return {
    protocol: receipt.protocol,
    status: receipt.status,
    charged_amount: receipt.charged_amount,
    charged_currency: receipt.charged_currency,
    top_level_keys: Object.keys(receipt).sort(),
    ucp_reference_keys: Object.keys(receipt.reference.ucp ?? {}).sort()
  };
}

function summary(receipt: Receipt): Record<string, unknown> {
  return {
    protocol: receipt.protocol,
    order_id: receipt.order_id,
    status: receipt.status,
    charged_amount: receipt.charged_amount,
    charged_currency: receipt.charged_currency,
    reference: receipt.reference.ucp
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
