# Error taxonomy

`@steelyard/buyer/client` surfaces failures as a closed v1 error set. The shape:

```typescript
type ErrorPayload = {
  error: ErrorCode;
  error_detail?: string;        // human-readable specifics
};
```

## The closed set

Exported from `@steelyard/core` as `ERROR_CODES`:

| Code | When it fires |
|------|---------------|
| `not_found` | `getOffer(id)` returned no offer. Manifest or policies resource absent. |
| `version_mismatch` | Server's `commerce.read.version` doesn't match the client per the [pre-1.0 minor-match rule](versioning.md). |
| `protocol_mismatch` | `connect(url)` couldn't detect any of MCP/ACP/UCP. The URL didn't speak any read surface Steelyard recognizes. |
| `network_error` | Connection failure to the merchant. DNS, TCP, TLS, or HTTP-level failure. |
| `internal_error` | Unexpected adapter-side failure. Logged on the server. Should never appear on the happy path. |

These five are the entirety of v1. Adapters MAY include an `error_detail`
string for human-readable specifics, but consumers branch on the
`error` code.

## What this buys you

- **Exhaustive `switch`** in the buyer SDK consumer. TypeScript will tell you
  about new error codes the day they appear.
- **No vendor leakage.** Stripe error codes, ACP error envelopes, and UCP's
  rich `messages` array are mapped down to one of these five. The buyer SDK
  is protocol-agnostic; downstream consumers don't have to learn three
  vocabularies.
- **A versioned contract.** Adding a new code in v1 is a breaking change
  (minor bump under the [pre-1.0 rule](versioning.md)). Removing one or
  changing the meaning is a major bump.

## Usage

```typescript
import { Steelyard, type Merchant } from "@steelyard/buyer/client";

const result = await Steelyard.connect("https://merchant.example/protocol/mcp");

if ("error" in result) {
  switch (result.error) {
    case "protocol_mismatch":
      // Not a Steelyard-compatible merchant
      break;
    case "version_mismatch":
      // Their commerce.read version doesn't match ours; check result.error_detail
      break;
    case "network_error":
      // Retry with backoff
      break;
    case "internal_error":
      // Treat as unknown; report
      break;
    case "not_found":
      // Shouldn't happen on connect(); included for exhaustiveness
      break;
  }
  return;
}

const merchant: Merchant = result;
// ... use merchant.search() etc.
```

## What's next

- :material-tag: [Versioning](versioning.md) — how `version_mismatch` is
  resolved.
- :material-package-variant-closed: [`@steelyard/buyer/client`](../packages/client.md) —
  the full buyer SDK reference.
