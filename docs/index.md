---
title: Steelyard
hide:
  - navigation
---

# Steelyard

**The open-source SDK for agentic commerce. Define commerce once. Expose it everywhere.**

Steelyard is a TypeScript SDK that lets a merchant define a product catalog
**once** — and serve it as a real MCP server, a real ACP feed, **and** a real
UCP discovery endpoint, from the same configuration. Agent runtimes can browse
through whichever protocol they speak, and v0.3 buyers can complete ACP or UCP
checkout through the local Wallet.

```typescript
import { defineCommerce } from "@steelyard/core";

export default defineCommerce({
  identity: { name: "Acme Coffee", domain: "acme.example", currencies: ["usd"] },
  offers: [
    {
      id: "double",
      title: "Double Espresso",
      pricing: [{ kind: "one_time", amount: 450, currency: "usd" }],
      availability: "in_stock"
    }
  ],
  policies: [{ type: "returns", summary: "Prepared drinks are final." }]
});
```

One config in. Three protocol surfaces out. Same offers, every time.

## Why

The agentic commerce protocol war is on:

- **ACP** (OpenAI + Stripe + Meta) ships a feed/catalog + a checkout primitive.
- **UCP** (Google + Shopify) ships a discovery doc + a shopping service.
- **MCP** (Anthropic) ships the agent runtime substrate that both of the above bind into.

They are all live. They are all open-source. They are **incompatible**.

Merchants face an N×M integration problem. Agent runtimes face the same. Steelyard
sits above all three — define commerce once in a single `defineCommerce({...})`
call, and Steelyard emits a complete, spec-validated surface for every protocol
you target.

## What v0.3 ships

- **Read-side across all three protocols.** Catalog discovery, offer listing,
  manifest, and policies work over MCP, ACP, and UCP.
- **ACP and UCP checkout.** Merchant checkout assembly, PSP adapters,
  delegate-payment, UCP mandates, buyer reservations, and persisted receipts.
- **MCP checkout is deferred.** MCP remains the read-side runtime substrate in
  this release.
- **No stubs.** Every package is end-to-end tested against the real protocol
  spec. AJV validation runs at emit time for ACP and UCP catalog responses.
  MCP uses the official `@modelcontextprotocol/sdk`.

## Get started

- :material-rocket-launch: **[Quickstart](getting-started.md)** — clone, install, watch the demo.
- :material-cart: **[Your first purchase](guides/your-first-purchase.md)** — run ACP and UCP mock checkout.
- :material-lightbulb-on: **[Unification thesis](concepts/unification.md)** — why one config and three protocols.
- :material-package-variant-closed: **[Buyer SDK](packages/client.md)** — `Steelyard.connect()` against any agentic merchant.

## Status

v0.3 WIP. MIT. Pinned to the published versions of each protocol spec (ACP
2026-04-17, UCP per the vendored snapshot, MCP per `@modelcontextprotocol/sdk`
>= 1.29).

[Get started →](getting-started.md){ .md-button .md-button--primary }
[View on GitHub :material-github:](https://github.com/interfacelabs/steelyard-sdk){ .md-button }
