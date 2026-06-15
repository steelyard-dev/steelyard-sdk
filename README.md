# Steelyard

Steelyard is a TypeScript SDK for defining a commerce catalog once, serving it
as static `commerce.json`, plain HTTP, MCP, ACP, and UCP, and letting buyers
gate purchases through a local encrypted Wallet.

The current surface is read-side across `commerce.json`, `/commerce`, MCP, ACP,
and UCP, plus checkout for ACP and UCP. UCP checkout can use RFC 9421 HTTP
Message Signatures or bearer auth. MCP checkout remains out of scope for this
release.

## Install

```sh
npm install @steelyard/core @steelyard/protocol @steelyard/buyer @steelyard/merchant @steelyard/cli
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

## Signed UCP Checkout

v0.4.2 adds UCP HTTP Message Signatures for checkout traffic. Buyers can sign
requests with a vault-backed ES256 or ES384 UCP signing key, advertise their
public key through a UCP profile, and verify signed merchant completion
responses. Merchants can accept HMS, bearer tokens, or both.

See `docs/guides/configuring-ucp-auth.md` for operator configuration.

## v0.4 Read-Side Surfaces

Serve the well-known commerce manifest and plain HTTP read API from the same
manifest:

```ts
import { createServer } from "node:http";
import { createCommerceManifestHandler } from "@steelyard/protocol/commerce-manifest";
import { createHttpApiHandler } from "@steelyard/protocol/http";

const wellKnown = createCommerceManifestHandler(manifest, {
  peers: {
    acp: { url: "https://coffee.example/acp/feed", protocol_version: "2026-04-17" },
    ucp: { url: "https://coffee.example/.well-known/ucp", protocol_version: "2026-04-17" },
    mcp: { url: "https://coffee.example/mcp", protocol_version: "0.1" },
    http: { url: "https://coffee.example/commerce", protocol_version: "0.1" }
  }
});
const httpApi = createHttpApiHandler(manifest);

createServer((req, res) => {
  if (req.url?.startsWith("/.well-known/commerce.json")) return wellKnown(req, res);
  if (req.url?.startsWith("/commerce")) return httpApi(req, res);
  res.writeHead(404).end();
});
```

Validate a running server:

```sh
steelyard validate https://coffee.example/.well-known/commerce.json
pnpm --filter @steelyard/example-coffee-shop smoke:well-known
```

Generate static `commerce.json` for a CDN:

```sh
pnpm --filter @steelyard/example-coffee-shop build
steelyard manifest ./examples/coffee-shop/dist/catalog.js \
  --module \
  --export coffeeShopManifest \
  --peer acp=https://coffee.example/acp/feed \
  --protocol-version acp=2026-04-17 \
  --peer ucp=https://coffee.example/.well-known/ucp \
  --protocol-version ucp=2026-04-17 \
  --peer mcp=https://coffee.example/mcp \
  --protocol-version mcp=0.1 \
  --peer http=https://coffee.example/commerce \
  --protocol-version http=0.1 \
  --generated-at 2026-06-14T00:00:00.000Z \
  --pretty \
  > public/commerce.json
```

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

STEELYARD_ALLOW_MOCK_PSP=1 \
pnpm --filter @steelyard/example-coffee-shop smoke:bearer
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
