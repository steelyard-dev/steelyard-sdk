# `@steelyard/acp`

Emit a spec-validated ACP feed/catalog endpoint from a Steelyard manifest.

```bash
npm install @steelyard/acp @steelyard/core
```

The published `ProductsResponse` is validated against
`protocols/acp/spec/2026-04-17/json-schema/schema.feed.json` at emit time.

## Exports

```typescript
import {
  buildAcpFeed,
  createAcpFeedHandler,
  validateAcpFeed,
  assertValidAcpFeed,
  type AcpFeed,
  type AcpProduct,
  type AcpVariant,
  type AcpPrice,
  type AcpAvailability,
  type AcpDescription,
  type AcpMedia,
  type AcpValidationResult
} from "@steelyard/acp";
```

### `buildAcpFeed(manifest)` → `AcpFeed`

Maps a Steelyard `Manifest` into the ACP `ProductsResponse` shape. Throws
on a manifest that would produce a non-conformant feed.

### `createAcpFeedHandler(manifest)` → `RequestListener`

A Node HTTP handler that responds `application/feed+acp-products+json` with
the built feed. Validates on every request.

### `validateAcpFeed(feed)` → `AcpValidationResult`

Non-throwing validation. Returns `{ valid: boolean, errors: AjvError[] | null }`.

### `assertValidAcpFeed(feed)`

Throws with a spec-aware error message if the feed doesn't conform.

## Verification

`packages/acp/src/feed.test.ts` runs adversarial cases (tampered feed must
throw the specific spec violation). Coverage: ≥ 95% lines.

## What's next

- :material-protocol: [ACP protocol reference](../protocols/acp.md).
- :material-shopping-search: [`@steelyard/client`](client.md) — the unified buyer SDK.
