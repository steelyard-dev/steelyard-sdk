import type { Offer, Price, PurchaseIntent } from "@steelyard/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "@steelyard/buyer";
import { Steelyard } from "@steelyard/buyer/client";

const merchantUrl = process.env.MERCHANT_URL ?? "http://127.0.0.1:3000/protocol/mcp";

if (process.env.STEELYARD_EXAMPLE_DRY_RUN === "1") {
  await dryRun();
} else {
  const wallet = await Wallet.open({ password: process.env.STEELYARD_PASSWORD });
  const merchant = await Steelyard.connect(merchantUrl);
  if ("error" in merchant) throw new Error(merchant.error_detail ?? merchant.error);
  const offers = await merchant.search("");
  if ("error" in offers) throw new Error(offers.error_detail ?? offers.error);
  const [offer] = offers;
  if (!offer) throw new Error("coffee-shop example returned no offers");
  const intent = intentFromOffer(offer);

  if (!(await wallet.isAllowed(intent))) {
    const decision = await wallet.decide(intent);
    console.log("not allowed:", decision);
  } else {
    const payment = await wallet.createBrowserManualSession(intent);
    await payment.cancel();
  }
  await wallet.close();
}

async function dryRun(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "steelyard-wallet-example-"));
  const cwd = process.cwd();
  try {
    process.chdir(root);
    const wallet = await Wallet.create({
      project: true,
      password: "example-password",
      card: { number: "4111111111111111", exp: "12/99", name: "Example Buyer" },
      billing: {
        email: "buyer@example.com",
        address: { line1: "1 Main St", city: "SF", postal_code: "94110", country: "US" }
      },
      limits: { daily: { USD: 100 } },
      allowedMerchants: ["coffee.example"]
    });
    const payment = await wallet.createBrowserManualSession({
      merchant: {
        domain: "coffee.example",
        transport_url: merchantUrl,
        protocol: "mcp"
      },
      offer: { id: "single", title: "Single Espresso", categories: ["coffee"] },
      amount: 300,
      currency: "USD",
      intent_id: "example_wallet_single"
    });
    await payment.cancel();
    await wallet.close();
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
}

function intentFromOffer(offer: Offer): PurchaseIntent {
  const price = offer.pricing.find((item): item is Extract<Price, { kind: "one_time" }> => item.kind === "one_time");
  if (!price) throw new Error(`offer ${offer.id} has no one-time price`);
  return {
    merchant: { domain: "coffee.example", transport_url: merchantUrl, protocol: "mcp" },
    offer: { id: offer.id, title: offer.title, categories: offer.categories },
    amount: price.amount,
    currency: price.currency,
    intent_id: `coffee_${offer.id}`
  };
}
