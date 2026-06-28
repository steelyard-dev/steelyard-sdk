# steelyard

The Steelyard SDK front door. **Define commerce once, serve it everywhere, let buyers
buy.** One install, one import.

```sh
npm install steelyard
```

## Define once, serve everywhere

```ts
import { defineCommerce, serveCommerce } from "steelyard";

const manifest = defineCommerce({
  identity: { name: "My Shop", domain: "shop.example", currencies: ["USD"] },
  offers: [
    { id: "tee", title: "T-Shirt", availability: "in_stock",
      pricing: [{ kind: "one_time", amount: 2500, currency: "USD" }] }
  ]
});

serveCommerce(manifest).listen(3000);
// Live now from one manifest:
//   GET /.well-known/commerce.json   GET /commerce/products   POST /mcp
//   GET /acp/feed                    GET /.well-known/ucp + /api/catalog/*
```

```sh
curl localhost:3000/.well-known/commerce.json
```

`serveCommerce` is read-only by default (no PSP needed). It returns a Node `Server`
you can `.listen()`, or use `createCommerceReadHandler(manifest)` to mount the
surfaces inside your own server.

## What's re-exported

This package re-exports the symbols 90% of integrators need:

| Need | Symbols |
|------|---------|
| Define schemas | `defineCommerce`, types `Manifest` `Offer` `Price` `PurchaseIntent` |
| Serve | `serveCommerce`, `createCommerceReadHandler` |
| Per-protocol handlers | `createMcpServer` `createMcpHttpHandler` `createUcpHandler` `buildUcpDiscovery` `createAcpFeedHandler` `buildAcpFeed` `createCommerceManifestHandler` `createHttpApiHandler` |
| Checkout + PSP | `createCheckoutServer`, `stripePsp`, `referencePsp` |
| Payment instruments | `vaultedCard`, `stripeSpt`, `referenceMandate`, `x402Payments`, `x402Fetch` |
| Paid HTTP resources | `x402Paywall`, `exactUsdc` |
| Policy | `PolicyEngine`, `createPolicyEngine` |
| Buy | `Wallet`, `Steelyard` / `connect` |

## Power users

This is a curated front door, not the whole surface. For anything not above, import
the specific package directly — e.g. `@steelyard/protocol/ucp`,
`@steelyard/buyer/vault`, `@steelyard/merchant`, `@steelyard/x402`,
`@steelyard/core`. The umbrella never
hides them; it just gives you a shorter path to the common case.
