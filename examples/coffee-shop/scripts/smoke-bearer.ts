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
import { coffeeShopBearerToken } from "../src/demo-ucp-keys.js";

if (process.env.STEELYARD_ALLOW_MOCK_PSP !== "1") {
  throw new Error("STEELYARD_ALLOW_MOCK_PSP=1 is required to run the bearer UCP smoke");
}

const clock = () => new Date("2026-06-14T12:00:00.000Z");
const delegate = await startMockDelegatePaymentServer({ clock });
const shop = await startCoffeeShopCheckoutServer({
  clock,
  steelyardMandate: false,
  paymentHandlers: ["stripe"]
});
const root = await mkdtemp(join(tmpdir(), "steelyard-bearer-smoke-"));
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
    allowedMerchants: ["coffee.example"]
  });

  try {
    const merchant = await Steelyard.connect(`${shop.baseUrl}/.well-known/ucp`, {
      allowPrivateNetwork: true,
      delegatePaymentUrl: delegate.delegatePaymentUrl,
      ucpAuth: {
        preferred: "bearer",
        bearerToken: coffeeShopBearerToken
      }
    });
    if ("error" in merchant) throw new Error(merchant.error_detail ?? merchant.error);
    if (!merchant.supports("checkout")) throw new Error("UCP merchant did not advertise checkout");

    const offer = await merchant.getOffer("cappuccino");
    if ("error" in offer) throw new Error(offer.error_detail ?? offer.error);
    const receipt = await wallet.pay(intentFromOffer(offer, merchant.url), {
      merchant,
      idempotencyKey: "coffee_bearer_cappuccino",
      clock
    });
    console.log(JSON.stringify({
      ok: true,
      protocol: receipt.protocol,
      order_id: receipt.order_id,
      status: receipt.status,
      charged_amount: receipt.charged_amount,
      charged_currency: receipt.charged_currency,
      reference: receipt.reference
    }, null, 2));
  } finally {
    await wallet.close();
  }
} finally {
  process.chdir(cwd);
  await rm(root, { recursive: true, force: true });
  await Promise.all([shop.close(), delegate.close()]);
}

function intentFromOffer(offer: Offer, transportUrl: string): PurchaseIntent {
  const price = offer.pricing.find((item): item is Extract<Price, { kind: "one_time" }> => item.kind === "one_time");
  if (!price) throw new Error(`offer ${offer.id} has no one-time price`);
  return {
    merchant: { domain: "coffee.example", transport_url: transportUrl, protocol: "ucp" },
    offer: { id: offer.id, title: offer.title, categories: offer.categories },
    amount: price.amount,
    currency: price.currency,
    intent_id: `coffee_bearer_${offer.id}`
  };
}
