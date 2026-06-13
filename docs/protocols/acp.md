# ACP

Steelyard's ACP adapter (`@steelyard/acp`) emits an
[Agentic Commerce Protocol](https://agentic-commerce-protocol.com/) feed
that conforms to the **pinned spec**:

- **Spec version:** `2026-04-17`
- **Schema:** `protocols/acp/spec/2026-04-17/json-schema/schema.feed.json`
- **Validator:** AJV2020 with JSON Schema 2020-12

Every feed is validated against `#/$defs/ProductsResponse` at emit time.
A merchant config that would produce a non-conformant feed throws before any
bytes leave the server — the emitter refuses to lie about the spec.

## Endpoint

The HTTP handler serves a GET endpoint that returns
`application/feed+acp-products+json`:

```bash
curl -s http://localhost:3000/acp/feed | jq '.products | length'
# 3
```

The response body is an `AcpFeed`:

```typescript
interface AcpFeed {
  products: AcpProduct[];
}
```

## Mapping from `Offer` to ACP

| Steelyard `Offer` field | ACP `Product` / `Variant` field |
|-------------------------|---------------------------------|
| `id` | Both `product.id` and `product.variants[0].id` (single-variant emit) |
| `title` | `product.title` + `variant.title` |
| `description` | `product.description.plain` |
| `images[]` | `product.media[].url` (each as `type: "image"`) |
| `url` | `product.url` |
| `categories[]` | `variant.categories[]` with `taxonomy: "merchant"` |
| `availability` | `variant.availability` (`{ available, status }`) |
| `pricing[]` (first priced entry) | `variant.price` (`{ amount, currency }` in minor units, uppercase) |

Identity is normalized so the feed always advertises the merchant's `name`
and (optionally) `links[]` from the manifest identity.

## Runtime validation API

```typescript
import { buildAcpFeed, validateAcpFeed, assertValidAcpFeed } from "@steelyard/acp";

const feed = buildAcpFeed(manifest);

const result = validateAcpFeed(feed);
if (!result.valid) {
  console.error(result.errors);   // AJV ErrorObject[]
}

// or throw on bad output
assertValidAcpFeed(feed);
```

Steelyard's own emit path calls `assertValidAcpFeed` before returning the
feed body. A bug that produced a non-conformant feed throws with the
specific spec violation:

```
ACP feed failed ProductsResponse validation:
  data/products/0 must have required property 'variants'
```

## What's not in v1

- **`create_cart` / checkout flows** — v2.
- **`payment_token_delegation`** — v2.
- **Multi-variant products with options** — single-variant emit only;
  multi-variant arrives when the conceptual model lands.

## Verification

[`packages/acp/src/feed.test.ts`](https://github.com/interfacelabs/steelyard-sdk/blob/main/packages/acp/src/feed.test.ts)
exercises the full `Manifest → AcpFeed` pipeline against the pinned spec
schema, including adversarial cases (a tampered feed must throw the spec
violation).

## What's next

- :material-protocol: [UCP](ucp.md) — the third protocol surface.
- :material-package-variant-closed: [`@steelyard/acp` package API](../packages/acp.md).
