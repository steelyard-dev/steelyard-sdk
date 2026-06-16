import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "@steelyard/buyer";
import { Steelyard } from "@steelyard/buyer/client";
import type { Offer, Price, PurchaseIntent } from "@steelyard/core";
import {
  startCoffeeShopCheckoutServer,
  startMockDelegatePaymentServer
} from "./checkout-server.js";

type CheckoutProtocol = "acp" | "ucp";

const protocol = parseProtocol(process.argv.slice(2));
const clock = () => new Date("2026-06-14T12:00:00.000Z");
const delegate = await startMockDelegatePaymentServer({ clock });
const root = await mkdtemp(join(tmpdir(), "steelyard-buy-real-"));
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
    let ucpSigningKid: string | undefined;
    if (protocol === "ucp") {
      ucpSigningKid = (await wallet.createUcpSigningKey({ algorithm: "ES256" })).kid;
    }
    shop = await startCoffeeShopCheckoutServer({
      clock,
      ...(protocol === "ucp"
        ? {
            buyerSigningKeys: [await wallet.exportUcpSigningPublicKey()],
            paymentHandlers: ["stripe"]
          }
        : {})
    });

    const merchant = await Steelyard.connect(discoveryUrl(shop.baseUrl, protocol), {
      allowPrivateNetwork: true,
      delegatePaymentUrl: delegate.delegatePaymentUrl,
      ...(protocol === "ucp" && ucpSigningKid
        ? {
            ucpAuth: {
              preferred: "hms" as const,
              signing: {
                kid: ucpSigningKid,
                algorithm: "ES256" as const,
                profileUrl: `${shop.baseUrl}/buyer/.well-known/ucp`
              }
            }
          }
        : {})
    });
    if ("error" in merchant) throw new Error(merchant.error_detail ?? merchant.error);
    if (!merchant.supports("checkout")) throw new Error(`${protocol} merchant did not advertise checkout`);

    const offer = await merchant.getOffer("cappuccino");
    if ("error" in offer) throw new Error(offer.error_detail ?? offer.error);
    const receipt = await wallet.pay(intentFromOffer(offer, protocol, merchant.url), {
      merchant,
      idempotencyKey: `coffee_${protocol}_cappuccino`,
      clock
    });
    const receipts = await wallet.listReceipts();
    console.log(JSON.stringify({
      protocol,
      order_id: receipt.order_id,
      status: receipt.status,
      charged_amount: receipt.charged_amount,
      charged_currency: receipt.charged_currency,
      receipt_count: receipts.length,
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

function discoveryUrl(baseUrl: string, protocol: CheckoutProtocol): string {
  return protocol === "acp" ? `${baseUrl}/acp/feed` : `${baseUrl}/.well-known/ucp`;
}

function intentFromOffer(offer: Offer, protocol: CheckoutProtocol, transportUrl: string): PurchaseIntent {
  const price = offer.pricing.find((item): item is Extract<Price, { kind: "one_time" }> => item.kind === "one_time");
  if (!price) throw new Error(`offer ${offer.id} has no one-time price`);
  return {
    merchant: { domain: "coffee.example", transport_url: transportUrl, protocol },
    offer: { id: offer.id, title: offer.title, categories: offer.categories },
    amount: price.amount,
    currency: price.currency,
    intent_id: `coffee_${protocol}_${offer.id}`
  };
}

function parseProtocol(args: string[]): CheckoutProtocol {
  const index = args.indexOf("--protocol");
  const value = index === -1 ? "acp" : args[index + 1];
  if (value === "acp" || value === "ucp") return value;
  throw new Error("usage: pnpm buy:real -- --protocol acp|ucp");
}
