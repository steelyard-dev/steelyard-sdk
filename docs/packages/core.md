# `steelyard/core`

The schema, types, and constants every other package depends on.

```bash
npm install steelyard
```

## Exports

### Functions

- [`defineCommerce(config)`](../concepts/define-commerce.md) — parse, normalize, and return a `Manifest`. Throws `ZodError` on invalid input.
- `validate(input)` — non-throwing validation. Returns `{ valid: true, value: Manifest } | { valid: false, errors: ZodIssue[] }`.
- `commerceManifest(manifest, opts?)` — build a schema-valid v0.4 `commerce.json` document.
- `validateCommerceManifest(doc)` — validate schema conformance and `content_hash`.
- `canonicalCommerceManifestHash(doc)` — recompute the v0.4 manifest checksum.
- `newIdempotencyKey()` from `steelyard/core/idempotency` — creates a purchase-safe idempotency key.
- `mapAcpToOrderState()` and `mapUcpCheckoutStatus()` from `steelyard/core/order-state` — normalize protocol states into buyer receipt states.
- `totalAmount()` and `canonicalMerchantAudience()` from `steelyard/core/purchase` — shared checkout helpers.

### Types

- `CommerceConfig` — the user-facing input to `defineCommerce`.
- `Manifest` — the normalized output. What every adapter consumes.
- `CommerceManifestDoc`, `CommerceManifestPeer`, `PeerName` — generated from the authored commerce manifest schema.
- `MerchantIdentity`, `Offer`, `Price`, `Policy`, `Policies` — components of the manifest.
- `ErrorCode` — the closed union of error strings (see [Error taxonomy](../concepts/errors.md)).
- `ValidationResult` — the discriminated union returned by `validate()`.
- `PurchaseIntent`, `Receipt`, `WalletDriverPort`, `OrderState` — v0.3 purchase primitives.

### Constants

- `COMMERCE_READ_VERSION = "0.1"` — the capability version every adapter advertises. See [Versioning](../concepts/versioning.md).
- `COMMERCE_MANIFEST_PATH = "/.well-known/commerce.json"` — the v0.4 well-known path.
- `COMMERCE_MANIFEST_SCHEMA_VERSION = "0.1"` — the authored manifest schema version.
- `ERROR_CODES` — array of every valid `ErrorCode` value; useful for exhaustive switches.

## Runtime dependencies

Runtime dependencies stay protocol-agnostic: `zod` for the core manifest,
`ajv`/`ajv-formats` for authored JSON Schema validation, `canonicalize` for
RFC 8785 hashing, plus small utility dependencies. There is **no** runtime
dependency on Stripe, the Anthropic SDK, the AI SDK, or any payment-adapter
code. A CI lint rule enforces this — `steelyard/core` is protocol-agnostic by
construction.

## Subpaths

- `steelyard/core/policy-yaml`
- `steelyard/core/order-state`
- `steelyard/core/idempotency`
- `steelyard/core/purchase`

## What's next

- :material-package-variant-closed: [`steelyard/protocol/mcp`](mcp.md), [`steelyard/protocol/acp`](acp.md), [`steelyard/protocol/ucp`](ucp.md) — the protocol adapters that consume a `Manifest`.
