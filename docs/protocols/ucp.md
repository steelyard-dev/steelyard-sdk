# UCP

Steelyard's UCP adapter (`@steelyard/ucp`) emits a real
[Universal Commerce Protocol](https://ucp.dev/) discovery document
**plus** a runtime-validated shopping-service catalog API:

- **UCP version:** `2026-04-08`
- **Discovery schema:** `protocols/ucp/source/schemas/ucp.json` + `service.json` + `capability.json` + `profile.json`
- **Catalog schemas:** `protocols/ucp/source/schemas/shopping/catalog_search.json` and `catalog_lookup.json`
- **Validator:** AJV2020 with JSON Schema 2020-12

Both the discovery doc **and** every catalog response are AJV-validated at
emit time. A bug that produced a non-conformant body throws before it
leaves the server.

## Endpoints

```text
GET  /.well-known/ucp              → UCP discovery document
POST /api/catalog/search           → catalog search_response
POST /api/catalog/lookup           → catalog lookup_response
POST /api/catalog/product          → get_product_response
```

The discovery doc advertises the shopping service at
`dev.ucp.shopping` with read-side capabilities
`dev.ucp.shopping.catalog.search` and `dev.ucp.shopping.catalog.lookup`.

## Discovery document

```json
{
  "ucp": {
    "version": "2026-04-08",
    "services": {
      "dev.ucp.shopping": [
        { "version": "2026-04-08", "endpoint": "https://acme.example/api", "transport": "rest" },
        { "version": "2026-04-08", "endpoint": "https://acme.example/mcp",  "transport": "mcp"  }
      ]
    },
    "capabilities": {
      "dev.ucp.shopping.catalog.search": [{ "version": "2026-04-08" }],
      "dev.ucp.shopping.catalog.lookup": [{ "version": "2026-04-08" }]
    }
  },
  "merchant": { "name": "Acme Coffee", "domain": "acme.example" },
  "links": { "commerce_manifest": "https://acme.example/commerce/manifest" }
}
```

The shape conforms to `ucp.json#/$defs/business_schema`. A buyer SDK can
walk the `services` map by reverse-domain name to find what the merchant
supports.

## Catalog APIs

Every catalog response carries a `ucp` envelope alongside the protocol
payload, and is AJV-validated at emit time:

```typescript
import {
  searchCatalog, lookupCatalog, getProduct,
  validateSearchResponse, validateLookupResponse, validateGetProductResponse,
  assertValidSearchResponse, assertValidLookupResponse, assertValidGetProductResponse
} from "@steelyard/ucp";

const result = searchCatalog(manifest, { query: "espresso" });
// result.products is a list of UCP Product[]
// AJV-validated against shopping/catalog_search.json#/$defs/search_response
```

### Lookup correlation

Per the UCP spec, lookup responses MUST correlate each returned variant to
the request id that resolved it. Steelyard handles this automatically:

```json
{
  "products": [{
    "id": "double",
    "variants": [{
      "id": "double",
      "inputs": [{ "id": "double", "match": "exact" }]
    }]
  }]
}
```

The `inputs` array is required (`lookup_variant#/required` per the spec) and
is populated by the emit path. A test that strips `inputs` triggers a real
spec violation:

```
UCP catalog lookup response failed spec validation:
  data/products/0/variants/0 must have required property 'inputs'
```

## What's not in v1

- **Checkout, cart, order, refund** — UCP defines these but they live in v2.
- **A2A / AP2 transports** — v1 advertises REST + MCP transports for the
  shopping service. Other transports are reachable through the discovery
  service registry as they ship.

## Verification

[`packages/ucp/src/ucp.test.ts`](https://github.com/interfacelabs/steelyard-sdk/blob/main/packages/ucp/src/ucp.test.ts)
runs 14 cases including spec-conformance for discovery + search + lookup +
get_product, plus adversarial tests that tamper each response and assert AJV
throws.

## What's next

- :material-package-variant-closed: [`@steelyard/ucp` package API](../packages/ucp.md).
- :material-shopping-search: [`@steelyard/client`](../packages/client.md) — the
  unified buyer SDK that auto-detects this UCP surface.
