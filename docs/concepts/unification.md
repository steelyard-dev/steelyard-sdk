# The unification thesis

ACP, UCP, and MCP are all open-source. They are all live. They are all
**incompatible**. Steelyard is the abstraction that makes you not have to
pick.

## The protocol war (June 2026)

| Protocol | Backers | Shipped | What it is |
|----------|---------|---------|------------|
| **ACP** | OpenAI, Stripe, Meta | 2025-09-29 → 2026-04-17 (6 specs in 6 months) | A feed + cart + delegated-payment protocol |
| **UCP** | Google, Shopify | 2026-04-17 vendored snapshot | A discovery + service-bound capability protocol |
| **MCP** | Anthropic | `@modelcontextprotocol/sdk` ≥ 1.29 | The agent runtime substrate; ACP and UCP both bind to it |

Each protocol assumes its own commerce vocabulary, its own product shape, its
own way of advertising capability. A merchant that wants to be reachable by
all three agent runtimes has to maintain three implementations and keep them
synchronized.

## The bet

Protocol wars rarely converge cleanly. Railroad gauges, USB-C vs Lightning,
REST vs GraphQL — fragmentation persists for years. Steelyard's value grows
the longer the war drags on.

If two of the three protocols *did* merge, the abstraction layer would get
thinner — but not disappear. Steelyard is sized to be useful in either
universe.

## How Steelyard breaks the tie

You write `defineCommerce({...})` **once**:

```mermaid
graph LR
  A[defineCommerce config] --> B[Manifest]
  B --> C[commerce.json]
  B --> D[/commerce HTTP API]
  B --> E[Steelyard.mcp]
  B --> F[Steelyard.acp]
  B --> G[Steelyard.ucp]
  E --> H[MCP server<br/>list_offers + resources]
  F --> I[ACP feed<br/>ProductsResponse]
  G --> J[UCP discovery<br/>+ shopping service]
```

Each adapter takes the same `Manifest` and emits a protocol-conformant
surface. The shapes differ because the specs differ — that is the whole point.
What does not differ is the source of truth.

## What this buys you

- **One config to update** when you add a product, change a price, or revise a
  policy. Static JSON, HTTP, and all three protocol surfaces reflect the same
  source of truth.
- **Real spec compliance.** Steelyard validates ACP feeds against the
  vendored `schema.feed.json` with AJV at emit time. UCP catalog responses
  are AJV-validated against the official `catalog_search.json` and
  `catalog_lookup.json` schemas. The v0.4 commerce manifest and HTTP API are
  validated against authored Steelyard JSON Schemas. MCP uses the official SDK.
- **A unified buyer SDK.** `@steelyard/buyer/client` connects to a merchant, sniffs
  which protocol it speaks, and returns the **same** `Merchant` handle
  regardless. Methods like `search()` and `getOffer()` return identical
  results across all three, and ACP/UCP merchants can also expose checkout.

## Current limits

- **MCP checkout is not implemented.** MCP remains read-side in v0.4.
- **No hosted merchant backend.** Steelyard is a library, not a backend. The
  merchant runs `defineCommerce()` in its own process; Steelyard doesn't
  proxy or cache for you.
- **Buyer detection is tuned for Steelyard emit conventions.** Hardening it to
  read every arbitrary ACP/UCP/MCP commerce server in the wild is future work.

## What's next

- :material-script-text: [`defineCommerce`](define-commerce.md) — the
  shape of the config.
- :material-protocol: [Protocols](../protocols/commerce-manifest.md) — what each
  surface looks like on the wire.
- :material-shopping-search: [`@steelyard/buyer/client`](../packages/client.md) —
  the buyer SDK that consumes any of the three.
