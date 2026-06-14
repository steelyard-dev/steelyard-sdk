# `@steelyard/protocol/ucp`

Emit a UCP discovery document and a spec-validated shopping catalog API
from a Steelyard manifest.

```bash
npm install @steelyard/protocol @steelyard/core
```

The discovery doc and every catalog response (`search`, `lookup`, `get_product`)
are AJV-validated against the vendored UCP schemas at emit time.

## Exports

```typescript
import {
  // discovery
  buildUcpDiscovery,
  createUcpHandler,
  validateUcpDiscovery,
  assertValidUcpDiscovery,
  // catalog
  searchCatalog,
  lookupCatalog,
  getProduct,
  validateSearchResponse,
  validateLookupResponse,
  validateGetProductResponse,
  assertValidSearchResponse,
  assertValidLookupResponse,
  assertValidGetProductResponse,
  // constants
  UCP_VERSION,
  UCP_WELL_KNOWN_PATH,
  UCP_API_PATH,
  UCP_SHOPPING_SERVICE,
  UCP_CATALOG_SEARCH_CAPABILITY,
  UCP_CATALOG_LOOKUP_CAPABILITY,
  // types
  type UcpDiscoveryDoc,
  type UcpEntity,
  type UcpCatalogResponse,
  type UcpLookupResponse,
  type UcpProduct,
  type UcpLookupProduct,
  type UcpVariant,
  type UcpLookupVariant,
  type UcpPrice,
  type UcpProductResponse,
  type UcpHandlerOptions,
  type UcpValidationResult
} from "@steelyard/protocol/ucp";
```

Checkout validators are exported from `@steelyard/protocol/ucp/checkout`:

```ts
import {
  applyUcpCreate,
  applyUcpUpdate,
  applyUcpComplete,
  assertValidUcpCheckout
} from "@steelyard/protocol/ucp/checkout";
```

### Discovery

- `buildUcpDiscovery(manifest, { baseUrl })` — produces the discovery doc.
- `createUcpHandler(manifest, opts?)` — Node HTTP handler that serves
  discovery + the three catalog endpoints (`POST /api/catalog/{search,lookup,product}`).
- `validateUcpDiscovery(doc)` / `assertValidUcpDiscovery(doc)` —
  spec-validates against the vendored business-profile schema.

The discovery `links.commerce_manifest` field points at
`${baseUrl}/.well-known/commerce.json`.

### Catalog

- `searchCatalog(manifest, body)` → `UcpCatalogResponse` — validated against
  `shopping/catalog_search.json#/$defs/search_response`.
- `lookupCatalog(manifest, body)` → `UcpLookupResponse` — validated against
  `shopping/catalog_lookup.json#/$defs/lookup_response`. Each variant carries
  the required `inputs` correlation array.
- `getProduct(manifest, body)` → `UcpProduct | undefined` — internally
  validated against `#/$defs/get_product_response`.

Plus matching `validate*` / `assertValid*` helpers for each response type.

## Verification

`packages/protocol/src/ucp/ucp.test.ts` runs 15 cases including adversarial spec
tampering (drop `inputs` from a lookup variant — must throw). Coverage:
≥ 95% lines.

## What's next

- :material-protocol: [UCP protocol reference](../protocols/ucp.md).
- :material-cart: [UCP checkout](../protocols/ucp-checkout.md).
- :material-shopping-search: [`@steelyard/buyer/client`](client.md) — the unified buyer SDK.
