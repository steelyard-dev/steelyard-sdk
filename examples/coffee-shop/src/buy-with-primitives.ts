import type { PurchaseIntent } from "@steelyard/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuyerPolicy } from "@steelyard/buyer/policy";
import { BuyerVault, passwordKeystore } from "@steelyard/buyer/vault";

if (process.env.STEELYARD_EXAMPLE_DRY_RUN === "1") {
  await dryRun();
} else {
  const vault = await BuyerVault.open({
    path: process.env.STEELYARD_VAULT_PATH ?? join(process.env.HOME ?? ".", ".steelyard", "vault.box"),
    keystore: passwordKeystore({ password: process.env.STEELYARD_PASSWORD ?? "" })
  });
  const policy = await BuyerPolicy.load();
  const intent = exampleIntent();
  const decision = await policy.evaluate(intent, { vault });
  if (decision.status !== "allowed") {
    console.log("not allowed:", decision);
  } else {
    const card = await vault.pickCard({ merchant: intent.merchant.domain });
    if (!card) throw new Error("no card for merchant");
    const raw = await vault.revealCard(card.id);
    const billing = await vault.billing();
    console.log("ready for checkout:", { card: { brand: raw.brand, last4: raw.last4 }, billing });
  }
  await vault.close();
}

async function dryRun(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "steelyard-primitives-example-"));
  try {
    const steelyard = join(root, ".steelyard");
    await mkdir(steelyard, { recursive: true });
    const vault = await BuyerVault.init({
      path: join(steelyard, "vault.box"),
      profile: { name: "Example Buyer", email: "buyer@example.com" },
      keystore: passwordKeystore({ password: "example-password" })
    });
    await vault.addCard({
      name_on_card: "Example Buyer",
      pan: "4111111111111111",
      exp: "12/99",
      tags: ["default"]
    });
    await vault.addAddress({ line1: "1 Main St", city: "SF", postal_code: "94110", country: "US" });
    await writeFile(join(steelyard, "policy.yml"), `
version: "0.1"
default: deny
rules:
  - name: example coffee
    can: buy
    where: { merchant_domain: coffee.example, currency: USD, amount: { lte: 1000 } }
`);
    const policy = await BuyerPolicy.load({ paths: [join(steelyard, "policy.yml")] });
    const decision = await policy.evaluate(exampleIntent(), { vault });
    if (decision.status !== "allowed") throw new Error(`expected allowed decision, got ${decision.status}`);
    await vault.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function exampleIntent(): PurchaseIntent {
  return {
    merchant: { domain: "coffee.example", transport_url: "http://127.0.0.1:3000/protocol/mcp", protocol: "mcp" },
    offer: { id: "single", title: "Single Espresso", categories: ["coffee"] },
    amount: 300,
    currency: "USD",
    intent_id: "example_primitives_single"
  };
}
