# Steelyard

Steelyard is a TypeScript SDK for defining a commerce catalog once, serving it
over MCP, ACP, and UCP, and letting buyers gate purchases through a local
encrypted Wallet.

The current surface is read-side across MCP, ACP, and UCP, plus v0.3 checkout
for ACP and UCP. MCP checkout remains out of scope for this release.

## Install

```sh
npm install @steelyard/core @steelyard/protocol @steelyard/buyer @steelyard/merchant
```

For local development:

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r test
```

## Define Once

```ts
import { defineCommerce } from "@steelyard/core";

export const manifest = defineCommerce({
  identity: { name: "Steelyard Coffee", domain: "coffee.example", currencies: ["USD"] },
  offers: [
    {
      id: "single",
      title: "Single Espresso",
      availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 300, currency: "USD" }]
    }
  ]
});
```

Pass that manifest to `@steelyard/protocol/mcp`, `@steelyard/protocol/acp`, and `@steelyard/protocol/ucp` to expose one catalog through all three protocols.
Pass the same manifest to `@steelyard/merchant/checkout` to mount ACP and UCP
checkout routes.

## Demo

Demo video placeholder: https://www.loom.com/share/STEELYARD_V1_DEMO_PLACEHOLDER

```sh
pnpm --filter @steelyard/example-coffee-shop build
PORT=3000 pnpm --filter @steelyard/example-coffee-shop start
```

In another terminal:

```sh
steelyard-agent --merchant http://127.0.0.1:3000/mcp "what does this shop sell"
```

Transcript with `ANTHROPIC_API_KEY` unset:

```text
(running without LLM; export ANTHROPIC_API_KEY for natural-language prompts)
[
  {
    "id": "cappuccino",
    "title": "Cappuccino",
    "description": "Espresso with steamed milk and foam.",
    "images": [],
    "url": "https://coffee.example/cappuccino",
    "kind": "product",
    "categories": [],
    "attributes": {},
    "availability": "in_stock",
    "pricing": [
      {
        "kind": "one_time",
        "amount": 500,
        "currency": "USD"
      }
    ]
  },
  {
    "id": "double",
    "title": "Double Espresso",
    "description": "Two espresso shots served short.",
    "images": [],
    "url": "https://coffee.example/double",
    "kind": "product",
    "categories": [],
    "attributes": {},
    "availability": "in_stock",
    "pricing": [
      {
        "kind": "one_time",
        "amount": 450,
        "currency": "USD"
      }
    ]
  },
  {
    "id": "single",
    "title": "Single Espresso",
    "description": "A focused single shot of espresso.",
    "images": [],
    "url": "https://coffee.example/single",
    "kind": "product",
    "categories": [],
    "attributes": {},
    "availability": "in_stock",
    "pricing": [
      {
        "kind": "one_time",
        "amount": 300,
        "currency": "USD"
      }
    ]
  }
]
```

The full coffee-shop example contains Single Espresso, Double Espresso, and
Cappuccino. The integration test boots the merchant and proves MCP
`list_offers`, ACP `/acp/feed`, and UCP `/api/catalog/search` return the same
canonical offer list.

Run an end-to-end mock purchase:

```sh
STEELYARD_ALLOW_MOCK_PSP=1 \
STEELYARD_ALLOW_MOCK_MANDATE=1 \
pnpm --filter @steelyard/example-coffee-shop buy:real -- --protocol acp

STEELYARD_ALLOW_MOCK_PSP=1 \
STEELYARD_ALLOW_MOCK_MANDATE=1 \
pnpm --filter @steelyard/example-coffee-shop buy:real -- --protocol ucp
```

## Wallet

```ts
import type { PurchaseIntent } from "@steelyard/core";
import { Wallet } from "@steelyard/buyer";
import { Steelyard } from "@steelyard/buyer/client";

const wallet = await Wallet.open();
const intent: PurchaseIntent = {
  merchant: {
    domain: "coffee.example",
    transport_url: "https://coffee.example/acp/feed",
    protocol: "acp"
  },
  offer: { id: "cappuccino", title: "Cappuccino", categories: ["coffee"] },
  amount: 500,
  currency: "USD"
};

const merchant = await Steelyard.connect("https://coffee.example/acp/feed", {
  delegatePaymentUrl: "https://psp.example/agentic_commerce/delegate_payment"
});
if ("error" in merchant) throw new Error(merchant.error_detail ?? merchant.error);

const receipt = await wallet.pay(intent, { merchant, idempotencyKey: "purchase_123" });
```

`PurchaseIntent.amount` is the maximum amount authorized for merchant checkout;
reconcile the final captured amount from the returned receipt.

Power users can still import `Steelyard` from `@steelyard/buyer/client`,
`BuyerPolicy` from `@steelyard/buyer/policy`, and `BuyerVault` from
`@steelyard/buyer/vault`.

## Port Note

Steelyard is a clean spin-off from `../mercato/`. The public repo keeps the
manifest, validation, protocol adapter, wallet, and checkout SDK surfaces, and
drops ingestion, platform connectors, and hosted cloud UI.
