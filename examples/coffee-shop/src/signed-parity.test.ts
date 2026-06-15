import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Wallet } from "@steelyard/buyer";
import { Steelyard, type Merchant } from "@steelyard/buyer/client";
import type { Offer, Price, PurchaseIntent, Receipt } from "@steelyard/core";
import {
  startCoffeeShopCheckoutServer,
  startMockDelegatePaymentServer,
  type RunningCoffeeShopCheckout,
  type RunningDelegatePayment
} from "./checkout-server.js";
import { coffeeShopBearerToken } from "./demo-ucp-keys.js";

const clock = () => new Date("2026-06-14T12:00:00.000Z");
let shop: RunningCoffeeShopCheckout | undefined;
let delegate: RunningDelegatePayment | undefined;
let root: string | undefined;
let cwd: string | undefined;

afterEach(async () => {
  if (cwd) process.chdir(cwd);
  await Promise.all([shop?.close(), delegate?.close()]);
  if (root) await rm(root, { recursive: true, force: true });
  shop = undefined;
  delegate = undefined;
  root = undefined;
  cwd = undefined;
});

describe("coffee-shop signed UCP parity", () => {
  it("matches bearer UCP receipts when requests are HMS-signed", async () => {
    cwd = process.cwd();
    root = await mkdtemp(join(tmpdir(), "steelyard-signed-parity-"));
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
      const ucpSigning = await wallet.createUcpSigningKey({ algorithm: "ES256" });
      const buyerPublicKey = await wallet.exportUcpSigningPublicKey();
      delegate = await startMockDelegatePaymentServer({ clock });
      shop = await startCoffeeShopCheckoutServer({ clock, buyerSigningKeys: [buyerPublicKey] });

      const signed = await buy(wallet, {
        preferred: "hms",
        idempotencyKey: "coffee_hms_cappuccino",
        signingKid: ucpSigning.kid
      });
      const bearer = await buy(wallet, {
        preferred: "bearer",
        idempotencyKey: "coffee_bearer_cappuccino"
      });

      expect(normalizedReceipt(signed)).toEqual(normalizedReceipt(bearer));
    } finally {
      await wallet.close();
    }
  });
});

async function buy(
  wallet: Wallet,
  opts: { preferred: "hms" | "bearer"; idempotencyKey: string; signingKid?: string }
): Promise<Receipt> {
  if (!shop || !delegate) throw new Error("test servers not started");
  const merchant = await Steelyard.connect(`${shop.baseUrl}/.well-known/ucp`, {
    allowPrivateNetwork: true,
    delegatePaymentUrl: delegate.delegatePaymentUrl,
    ucpAuth: opts.preferred === "hms"
      ? {
          preferred: "hms",
          signing: {
            kid: opts.signingKid ?? "",
            algorithm: "ES256",
            profileUrl: `${shop.baseUrl}/buyer/.well-known/ucp`
          }
        }
      : {
          preferred: "bearer",
          bearerToken: coffeeShopBearerToken
        }
  });
  if (!isMerchant(merchant)) throw new Error(`UCP connect failed: ${JSON.stringify(merchant)}`);

  const offer = await merchant.getOffer("cappuccino");
  if ("error" in offer) throw new Error(offer.error_detail ?? offer.error);
  return wallet.pay(intentFromOffer(offer, merchant.url), {
    merchant,
    idempotencyKey: opts.idempotencyKey,
    clock
  });
}

function intentFromOffer(offer: Offer, transportUrl: string): PurchaseIntent {
  const price = offer.pricing.find((item): item is Extract<Price, { kind: "one_time" }> => item.kind === "one_time");
  if (!price) throw new Error(`offer ${offer.id} has no one-time price`);
  return {
    merchant: { domain: "coffee.example", transport_url: transportUrl, protocol: "ucp" },
    offer: { id: offer.id, title: offer.title, categories: offer.categories },
    amount: price.amount,
    currency: price.currency,
    intent_id: `coffee_ucp_${offer.id}`
  };
}

function normalizedReceipt(receipt: Receipt): Record<string, unknown> {
  return {
    protocol: receipt.protocol,
    status: receipt.status,
    charged_amount: receipt.charged_amount,
    charged_currency: receipt.charged_currency,
    has_fulfillment: typeof receipt.fulfillment?.permalink_url === "string"
  };
}

function isMerchant(value: unknown): value is Merchant {
  return !!value && typeof value === "object" && "purchase" in value;
}
