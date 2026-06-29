# `steelyard/buyer/client`

The unified buyer SDK. Connect to any Steelyard merchant — MCP, ACP, or UCP —
through a single API.

```bash
npm install steelyard
```

## The shape

```typescript
import { Steelyard, type Merchant } from "steelyard/buyer/client";

const result = await Steelyard.connect("https://acme.example/mcp");

if ("error" in result) {
  // version_mismatch, protocol_mismatch, network_error, internal_error
  throw new Error(result.error_detail ?? result.error);
}

const merchant: Merchant = result;
const offers   = await merchant.search("espresso");
const offer    = await merchant.getOffer("double");
const manifest = await merchant.getManifest();
const policies = await merchant.getPolicies();

if (merchant.supports("checkout")) {
  const receipt = await merchant.purchase(intent, { port, idempotencyKey: "purchase_123" });
}
```

## How it works

`Steelyard.connect(url)` probes the URL in order:

1. **MCP** — opens a streamable HTTP connection, calls `initialize`, and sniffs
   `capabilities.extensions["steelyard/commerce"]`.
2. **ACP** — fetches the supplied feed URL and looks for ACP `products`.
3. **UCP** — fetches `/.well-known/ucp` when the supplied URL is not already
   the well-known path, then checks the discovery shape.

The **first match wins**. The returned `Merchant` carries the protocol it
detected (`merchant.protocol = "mcp" | "acp" | "ucp"`) plus the
identical-shape methods regardless of source.

## Methods

| Method | Returns | Notes |
|--------|---------|-------|
| `search(query)` | `Offer[]` | Empty string returns all offers. |
| `getOffer(id)` | `Offer \| { error: "not_found" }` | |
| `getManifest()` | `Manifest` | The full identity + offers + policies snapshot. |
| `getPolicies()` | `Policy[]` | |
| `supports(capability)` | `boolean` | `read`, `checkout`, `checkout:steelyard`, or `discounts`. |
| `purchase(intent, opts)` | `Receipt` | ACP/UCP only. MCP throws `MerchantNoCheckout`. |
| `close?()` | `Promise<void>` | Releases any open transport. Always call when done with MCP merchants. |
| `protocol` | `"mcp" \| "acp" \| "ucp"` | Which protocol the SDK detected. |

`Steelyard.connect(url, { delegatePaymentUrl })` passes the delegate-payment
endpoint to ACP and UCP drivers when the merchant advertises handlers that
require direct vault-token delegation.

`Steelyard.connect(url, { ucpAuth })` configures UCP checkout auth. HMS signing
requires a wallet UCP signing key plus a buyer profile URL; bearer auth requires
a token:

```ts
const merchant = await Steelyard.connect("https://coffee.example/.well-known/ucp", {
  ucpAuth: {
    preferred: "hms",
    signing: {
      kid: "wallet_2026",
      algorithm: "ES256",
      profileUrl: "https://wallet.example/.well-known/ucp"
    },
    bearerToken: process.env.UCP_BEARER
  }
});
```

See [Configuring UCP auth](../guides/configuring-ucp-auth.md).

## Version handshake

`connect()` enforces the [pre-1.0 minor-match rule](../concepts/versioning.md):

```typescript
import { isCompatibleReadVersion } from "steelyard/buyer/client";

isCompatibleReadVersion("0.1");    // true
isCompatibleReadVersion("0.1.9");  // true (patch)
isCompatibleReadVersion("0.2.0");  // false (minor bump may break at pre-1.0)
isCompatibleReadVersion("1.0.0");  // false (major)
```

Servers advertising an incompatible version return
`{ error: "version_mismatch", error_detail: "..." }` from `connect()`.

## Error handling

See the [error taxonomy](../concepts/errors.md). All `Merchant` methods may
return an `ErrorPayload` instead of their happy-path value. TypeScript will
narrow this automatically with `"error" in result` checks.

## Verification

`packages/buyer/src/client/client.test.ts` runs the buyer SDK against the
coffee-shop example and asserts identical results across all three
protocols. Coverage: ≥ 95% line, 100% on `connect()` paths.

## What's next

- :material-rocket: [Quickstart](../getting-started.md) — see the full demo.
- :material-account-tie: [`steelyard/agent`](agent.md) — the LLM-driven CLI
  that wraps this SDK.
