// Power-user example: this calls the raw ACP checkout driver directly.
// It deliberately skips the wallet policy engine and reservation ledger.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpDriver } from "steelyard/buyer/client/acp";
import { BuyerVault, passwordKeystore } from "steelyard/buyer/vault";
import type { PurchaseIntent, WalletDriverPort } from "steelyard/core";
import {
  startCoffeeShopCheckoutServer,
  startMockDelegatePaymentServer
} from "./checkout-server.js";

const clock = () => new Date("2026-06-14T12:00:00.000Z");
const delegate = await startMockDelegatePaymentServer({ clock });
const shop = await startCoffeeShopCheckoutServer({ clock });
const root = await mkdtemp(join(tmpdir(), "steelyard-primitives-v03-"));

try {
  const vault = await BuyerVault.init({
    path: join(root, ".steelyard", "vault.box"),
    profile: { name: "Example Buyer", email: "buyer@example.com" },
    keystore: passwordKeystore({ password: "example-password" })
  });
  try {
    await vault.addCard({
      name_on_card: "Example Buyer",
      pan: "4242424242424242",
      exp: "12/30",
      tags: ["default"]
    });
    await vault.addAddress({ line1: "1 Market St", city: "San Francisco", postal_code: "94105", country: "US" });
    await vault.createMandateKey();

    const receipt = await acpDriver.purchase(exampleIntent(shop.baseUrl), {
      merchantUrl: `${shop.baseUrl}/acp`,
      merchantId: "coffee.example",
      delegatePaymentUrl: delegate.delegatePaymentUrl,
      port: await driverPort(vault),
      idempotencyKey: "coffee_primitives_v03_cappuccino",
      clock
    });
    console.log(JSON.stringify({
      protocol: receipt.protocol,
      order_id: receipt.order_id,
      status: receipt.status,
      charged_amount: receipt.charged_amount,
      charged_currency: receipt.charged_currency,
      reference: receipt.reference
    }, null, 2));
  } finally {
    await vault.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await Promise.all([shop.close(), delegate.close()]);
}

async function driverPort(vault: BuyerVault): Promise<WalletDriverPort> {
  const card = await vault.pickCard({ merchant: "coffee.example" });
  if (!card) throw new Error("no card for coffee.example");
  return {
    billing: await vault.billing(),
    async withRawCard(fn) {
      const raw = await vault.revealCard(card.id);
      const released = { ...raw };
      try {
        return await fn(released);
      } finally {
        released.pan = "0".repeat(raw.pan.length);
        released.name_on_card = "";
        released.exp = "00/00";
      }
    },
    signMandate: (payload) => vault.signMandate(payload),
    pairwiseSubject: (audience) => vault.pairwiseSubject(audience),
    mandatePublicKey: () => vault.mandatePublicKey()
  };
}

function exampleIntent(baseUrl: string): PurchaseIntent {
  return {
    merchant: { domain: "coffee.example", transport_url: `${baseUrl}/acp`, protocol: "acp" },
    offer: { id: "cappuccino", title: "Cappuccino", categories: [] },
    amount: 500,
    currency: "USD",
    intent_id: "coffee_primitives_v03_cappuccino"
  };
}
