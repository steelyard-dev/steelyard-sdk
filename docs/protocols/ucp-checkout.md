# UCP Checkout

Steelyard supports UCP checkout through `@steelyard/merchant/checkout` and
`@steelyard/buyer/client/ucp`.

UCP checkout is advertised from the discovery document with the full capability
key `dev.ucp.shopping.checkout`. Steelyard's mandate mode is advertised
separately as `net.steelyard.checkout_mandate.v0_1`.

```ts
const discovery = buildUcpDiscovery(manifest, {
  baseUrl: "https://coffee.example",
  checkout: true,
  steelyardMandate: true
});
```

## Route shape

`buildUcpDiscovery()` advertises the REST shopping service at `/api`.
`createMerchantCheckout()` accepts both the spec-facing `/api/checkout*` routes
and the namespaced `/ucp/api/checkout*` routes.

Catalog routes stay at `/api/catalog/search`, `/api/catalog/lookup`, and
`/api/catalog/product`.

## Auth

UCP checkout can run unsigned for local interop, with HTTP Message Signatures,
with bearer auth, or with both enabled. When auth is configured on the merchant,
UCP signing failures use the `{ code, content }` UCP REST error envelope.

Buyers configure `ucpAuth` on `Steelyard.connect()`. HMS buyers must provide a
`signing.profileUrl` that hosts public `signing_keys[]`; bearer buyers provide
`bearerToken`. See [Configuring UCP auth](../guides/configuring-ucp-auth.md).

High-value UCP completion responses are signed by default when the merchant has
HMS keys configured, and the buyer verifies signed completion responses before
returning a receipt.

## Mandates

Steelyard mandates are opt-in. Set `steelyardMandate: true` on
`createMerchantCheckout()` and pass a `mandateVerifier` when the merchant
advertises `net.steelyard.checkout_mandate.v0_1`. Without that switch, vanilla
UCP completion proceeds without a mandate.

When mandate mode is negotiated, the buyer signs a Steelyard checkout mandate
with:

- `aud`: the canonical UCP discovery URL
- `steelyard:checkout`: the canonical checkout snapshot
- `steelyard:payment`: selected handler and vault token
- `steelyard:purchase_key`: the idempotency purchase key

The merchant verifies that mandate before PSP capture. This prevents a vault
token from being replayed against a different checkout, merchant audience, or
payment handler.

## AP2 notice

Steelyard's UCP checkout mandate mode is **not AP2 compliant**. It uses the
`steelyard.checkout_mandate` namespace and intentionally rejects AP2-namespaced
mandates in the Steelyard verifier. AP2 support requires a separate
compatibility layer and is not claimed by this release.

## Receipt state

UCP `completed` checkouts become buyer receipts with status `completed`.
Escalation and cancellation map to `escalation_required` and `canceled`.
