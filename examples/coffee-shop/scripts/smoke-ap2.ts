import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "@steelyard/buyer";
import { Steelyard } from "@steelyard/buyer/client";
import type { Offer, Price, PurchaseIntent } from "@steelyard/core";
import {
  startCoffeeShopCheckoutServer,
  startMockDelegatePaymentServer
} from "../src/checkout-server.js";

process.env.STEELYARD_ALLOW_MOCK_PSP ??= "1";
process.env.STEELYARD_ALLOW_MOCK_MANDATE ??= "1";

const clock = () => new Date("2026-06-14T12:00:00.000Z");
const issuer = "did:example:coffee-dpc-issuer";
const delegate = await startMockDelegatePaymentServer({ clock });
const root = await mkdtemp(join(tmpdir(), "steelyard-ap2-smoke-"));
const cwd = process.cwd();
let shop: Awaited<ReturnType<typeof startCoffeeShopCheckoutServer>> | undefined;

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
    allowedMerchants: ["coffee.example"]
  });

  try {
    const signing = await wallet.createUcpSigningKey({ algorithm: "ES256" });
    const buyerPublicKey = await wallet.exportUcpSigningPublicKey();
    shop = await startCoffeeShopCheckoutServer({
      clock,
      ap2: true,
      ap2Issuer: issuer,
      steelyardMandate: true,
      buyerSigningKeys: [buyerPublicKey]
    });

    const discovery = await json(`${shop.baseUrl}/.well-known/ucp`);
    if (!hasCapability(discovery, "dev.ucp.shopping.ap2_mandate")) {
      throw new Error("coffee-shop AP2 smoke server did not advertise AP2");
    }
    if (!hasCapability(discovery, "net.steelyard.checkout_mandate.v0_1")) {
      throw new Error("coffee-shop AP2 smoke server did not advertise Steelyard-mode coexistence");
    }

    const merchant = await Steelyard.connect(`${shop.baseUrl}/.well-known/ucp`, {
      allowPrivateNetwork: true,
      delegatePaymentUrl: delegate.delegatePaymentUrl,
      ucpAuth: {
        preferred: "hms",
        signing: {
          kid: signing.kid,
          algorithm: "ES256",
          profileUrl: `${shop.baseUrl}/buyer/.well-known/ucp`
        }
      },
      ap2: {
        enabled: true,
        issuer,
        payee: {
          id: "coffee.example",
          name: "Coffee Shop",
          website: shop.baseUrl
        },
        paymentInstrument: {
          id: "card_1",
          type: "card",
          description: "Visa 4242"
        }
      }
    });
    if ("error" in merchant) throw new Error(merchant.error_detail ?? merchant.error);
    if (!merchant.supports("checkout:ap2")) throw new Error("UCP merchant did not AP2-lock the session");
    if (merchant.supports("checkout:steelyard")) throw new Error("AP2-locked session still advertised Steelyard-mode");

    const offer = await merchant.getOffer("cappuccino");
    if ("error" in offer) throw new Error(offer.error_detail ?? offer.error);
    const receipt = await wallet.pay(intentFromOffer(offer, merchant.url), {
      merchant,
      idempotencyKey: "coffee_ap2_cappuccino",
      clock
    });
    if (receipt.protocol !== "ucp" || receipt.status !== "completed") {
      throw new Error(`AP2 UCP purchase did not complete: ${JSON.stringify(receipt)}`);
    }
    const mandateId = receipt.reference.ucp?.mandate_id;
    if (typeof mandateId !== "string" || mandateId.length !== 16) {
      throw new Error(`AP2 receipt did not record a checkout mandate id: ${JSON.stringify(receipt.reference)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      protocol: receipt.protocol,
      ap2: true,
      order_id: receipt.order_id,
      status: receipt.status,
      charged_amount: receipt.charged_amount,
      charged_currency: receipt.charged_currency,
      mandate_id: mandateId,
      reference: receipt.reference
    }, null, 2));
  } finally {
    await wallet.close();
  }
} finally {
  process.chdir(cwd);
  await rm(root, { recursive: true, force: true });
  await Promise.all([shop?.close(), delegate.close()]);
}

async function json(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function hasCapability(value: Record<string, unknown>, capability: string): boolean {
  const capabilities = record(record(value.ucp).capabilities);
  return Array.isArray(capabilities[capability]);
}

function intentFromOffer(offer: Offer, transportUrl: string): PurchaseIntent {
  const price = offer.pricing.find((item): item is Extract<Price, { kind: "one_time" }> => item.kind === "one_time");
  if (!price) throw new Error(`offer ${offer.id} has no one-time price`);
  return {
    merchant: { domain: "coffee.example", transport_url: transportUrl, protocol: "ucp" },
    offer: { id: offer.id, title: offer.title, categories: offer.categories },
    amount: price.amount,
    currency: price.currency,
    intent_id: `coffee_ap2_${offer.id}`
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
