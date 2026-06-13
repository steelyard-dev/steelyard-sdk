# @steelyard/core Keep/Drop Audit

This is the first `@steelyard/core` artifact. It documents what is lifted from
Mercato before any Steelyard core source code lands.

Mercato reference:

- Repo: `../mercato`
- Commit: `ae8b89331c19ca6e1d6ff278dc5d6326a62c1750`
- Files read:
  - `packages/core/src/define.ts`
  - `packages/core/src/manifest.ts`
  - `packages/core/src/validate.ts`
  - `packages/core/src/surface.ts`
  - `packages/core/src/errors.ts`
  - `packages/core/src/schemas.ts`
  - `packages/core/src/types.ts`
  - `packages/core/src/snapshot.ts`
  - package-local tests for the files above

## Port Rule

Steelyard v1 is read-side only: manifest, policies, offer listing, and offer
lookup. Anything whose only purpose is ingestion, scraping confidence,
checkout, cart mutation, payment execution, or broad MCP surface generation is
dropped.

The public v1 surface required by `GOAL.md` is:

- `defineCommerce(config) -> Manifest`
- `validate(config)`
- types `Offer`, `Manifest`, `Policies`, `ErrorCode`
- runtime dependency on `zod`
- no imports from `stripe`, `ai`, `@ai-sdk/*`, or `@anthropic-ai/sdk`

## File-Level Decision

| Mercato file | Decision | Rationale |
| --- | --- | --- |
| `define.ts` | Port with rewrite | Keep config normalization and validation flow, but Steelyard returns a concrete `Manifest` instead of Mercato's resolver-backed `CommerceDefinition`. Rename the private marker from `__mercato` out of the public model. |
| `manifest.ts` | Port concept only | Keep public manifest projection only if needed by adapters. Drop Mercato's provenance/metadata stripping because Steelyard v1 does not include those fields. |
| `validate.ts` | Port with rewrite | Keep structured validation result and duplicate offer-id checks. Validate Steelyard config/manifest directly. |
| `schemas.ts` | Port with pruning | Keep Zod schemas for merchant identity, offer, price, policy, and manifest. Drop ingestion/surface/content-only schemas. |
| `types.ts` | Port with rewrite | Keep typed config inputs and exported domain types. Drop resolver-specific and Mercato marker types unless they are needed by v1. |
| `surface.ts` | Drop | Mercato generates a broad MCP-oriented surface descriptor, including content Q&A and buy-link tools. Steelyard v1 adapters expose fixed read-side MCP/ACP/UCP capabilities, so this would be duplicate surface area. |
| `errors.ts` | Port with rewrite | Keep the idea of structured errors, but replace Mercato's open classes with the closed v1 `ErrorCode` set from A7. Drop Mercato's unimplemented-code-path error entirely. |
| `snapshot.ts` | Drop for v1 core | Stable hashing is useful for hosted or cached manifests, but v1 acceptance does not require snapshots or persistence. Reintroduce later only if a real adapter needs it. |

## Field-Level Decision

| Field/type | Decision | Rationale |
| --- | --- | --- |
| `schemaVersion` | Keep as Steelyard read version metadata | Needed for manifest/version introspection. Use Steelyard's v0.1 read-side version, not Mercato's `0.2` schema version. |
| `identity.name` | Keep | Required merchant display data for manifest and agent answers. |
| `identity.domain` | Keep | Useful for discovery documents and non-sensitive merchant identity. |
| `identity.description` | Keep | Read-side manifest and agent summarization value. |
| `identity.logoUrl` | Keep | Read-side presentation metadata. Keep Mercato's http(s)-only URL sanitation. |
| `identity.locale` | Keep | Harmless read-side display metadata. |
| `identity.currencies` | Keep | Helps protocol adapters advertise and normalize catalog currencies. |
| `catalog.offers` | Keep | Core v1 invariant: all protocols expose identical offer lists. |
| `Offer.id` | Keep | Required for lookup, parity, ACP product/variant ids, and UCP lookup. |
| `Offer.title` | Keep | Required for all offer-listing surfaces and agent answers. |
| `Offer.description` | Keep | Read-side product metadata used by ACP/UCP/client search. |
| `Offer.images` | Keep | ACP feed media and read-side client metadata. Keep http(s)-only filtering. |
| `Offer.url` | Keep | Merchant informational/product URL. This is not checkout execution. |
| `Offer.buyUrl` | Drop | Purchase handoff is not part of the Steelyard v1 acceptance surface. Avoid implying checkout or buy-link tooling. |
| `Offer.kind` | Keep | Useful read-side categorization and compatible with Mercato's existing tests. |
| `Offer.categories` | Keep | ACP category mapping and buyer filtering/search context. |
| `Offer.attributes` | Keep | Read-side arbitrary product facts; no ingestion dependency. |
| `Offer.availability` | Keep | ACP/UCP shopping surfaces expose availability-like state. |
| `Offer.pricing` | Keep | Required by protocol mapping and parity tests; amounts are minor units, currencies normalize to ISO 4217 uppercase. |
| `Price.kind` | Keep pruned read-side variants | One-time, recurring, usage-based, and contact-sales are catalog descriptions, not payment execution. |
| `content.pages` | Drop | Content Q&A is outside A2/A4/A5. It was used by Mercato's broader MCP `ask_about` surface. |
| `Policy.type` | Keep | A2 requires policies. |
| `Policy.url` | Keep | Read-side policy link, sanitized to http(s). |
| `Policy.summary` | Keep | Read-side policy text for client and agent answers. |
| `Policy.sourcePassage` | Drop | Scrape/source-attribution field; ingestion-only. |
| `profile.siteType` | Drop | Mercato inference metadata, not required by v1 adapters. |
| `surface.instructions` | Drop | Mercato-specific generated MCP descriptor; Steelyard adapters advertise fixed capabilities. |
| `surface.tools` | Drop | Same as above; A2 MCP tools are `list_offers` and `get_offer` only. |
| `surface.facets` | Drop | Search facets are not part of A2/A4/A5. |
| `provenance.source` | Drop | Ingestion/scrape lineage. Steelyard v1 configs are manual SDK input. |
| `provenance.createdAt` | Drop | Same provenance concern; no persistence/snapshot contract in v1. |
| `metadata` | Drop | Open-ended internals create protocol drift and are not required by v1. |

## Error Decision

Steelyard v1 exports the closed A7 `ErrorCode` set:

- `not_found`
- `version_mismatch`
- `protocol_mismatch`
- `network_error`
- `internal_error`

Mercato's unimplemented-code-path error is explicitly not ported because the
Steelyard v1 principle forbids reachable stubs. Mercato's `ValidationError` and
`DiscoveryError` concepts are covered by structured validation results and the
closed client error taxonomy.

## Attribution Plan

Any TypeScript file copied or substantially derived from the Mercato files above
will carry both:

- `Copyright (c) Mercato contributors. MIT License.`
- `Copyright (c) Steelyard contributors. MIT License.`

Files that are clean rewrites will carry only the Steelyard header.
