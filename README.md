# Steelyard

Steelyard is a TypeScript SDK for defining a read-only commerce catalog once and serving it over MCP, ACP, and UCP. A buyer can connect to any of those protocols and get the same offers, manifest, and policies.

v1 is intentionally read-side only: catalog discovery, offer listing, offer lookup, manifest, and policies. Carts, checkout, payment execution, receipts, and order mutation are out of scope.

## Install

```sh
npm install @steelyard/core @steelyard/mcp @steelyard/acp @steelyard/ucp
npm install @steelyard/client
npm install --global @steelyard/agent
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

Pass that manifest to `@steelyard/mcp`, `@steelyard/acp`, and `@steelyard/ucp` to expose one catalog through all three protocols.

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

The full coffee-shop example contains Single Espresso, Double Espresso, and Cappuccino. The integration test boots the merchant and proves MCP `list_offers`, ACP `/acp/feed`, and UCP `/api/catalog/search` return the same canonical offer list.

## Buyer SDK

```ts
import { Steelyard } from "@steelyard/client";

const merchant = await Steelyard.connect("https://merchant.example/mcp");

if ("error" in merchant) {
  throw new Error(merchant.error_detail ?? merchant.error);
}

const offers = await merchant.search("");
```

`Steelyard.connect()` probes MCP first, then ACP, then UCP. Protocol mismatch, version mismatch, network errors, not-found cases, and unexpected adapter failures use the closed v1 error taxonomy documented in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Port Note

Steelyard is a clean spin-off from `../mercato/`. The keep/drop audit is in [packages/core/PORT_AUDIT.md](packages/core/PORT_AUDIT.md): v1 keeps the read-side manifest, validation, and protocol adapter ideas, and drops ingestion, platform connectors, hosted cloud UI, carts, checkout, payment execution, and order mutation.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Protocol contract](docs/PROTOCOL.md)
- [Protocol mapping](docs/PROTOCOLS.md)
