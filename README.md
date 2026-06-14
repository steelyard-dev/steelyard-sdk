# Steelyard

Steelyard is a TypeScript SDK for defining a commerce catalog once, serving it over MCP, ACP, and UCP, and letting buyers gate purchases through a local Wallet.

v1 is intentionally read-side only: catalog discovery, offer listing, offer lookup, manifest, and policies. Carts, checkout, payment execution, receipts, and order mutation are out of scope.

## Install

```sh
npm install @steelyard/core @steelyard/protocol @steelyard/buyer
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
  identity: { name: "Steelyard Coffee" },
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

## Demo

Demo video placeholder: https://www.loom.com/share/STEELYARD_V1_DEMO_PLACEHOLDER

```sh
pnpm --filter @steelyard/example-coffee-shop build
PORT=3000 pnpm --filter @steelyard/example-coffee-shop start
```

In another terminal:

```sh
steelyard-agent --merchant http://127.0.0.1:3000/protocol/mcp "what does this shop sell"
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

The full coffee-shop example contains Single Espresso, Double Espresso, and Cappuccino. The integration test boots the merchant and proves MCP `list_offers`, ACP `/protocol/acp/feed`, and UCP `/api/catalog/search` return the same canonical offer list.

## Wallet

```ts
import { Wallet } from "@steelyard/buyer";

const wallet = await Wallet.open();

if (await wallet.isAllowed(intent)) {
  const payment = await wallet.pay(intent);
  await payment.cancel(); // v0.2 releases card details; v0.3 will charge.
}
```

Power users can still import `Steelyard` from `@steelyard/buyer/client`,
`BuyerPolicy` from `@steelyard/buyer/policy`, and `BuyerVault` from
`@steelyard/buyer/vault`.

## Port Note

Steelyard is a clean spin-off from `../mercato/`. The keep/drop audit is in [packages/core/PORT_AUDIT.md](packages/core/PORT_AUDIT.md): v1 keeps the read-side manifest, validation, and protocol adapter ideas, and drops ingestion, platform connectors, hosted cloud UI, carts, checkout, payment execution, and order mutation.
