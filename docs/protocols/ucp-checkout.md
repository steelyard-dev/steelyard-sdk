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
`createMerchantCheckout()` serves UCP checkout routes at `/ucp/api`. Deployments
that combine both helpers should route or rewrite `/api/checkout*` to
`/ucp/api/checkout*`.

Catalog routes stay at `/api/catalog/search`, `/api/catalog/lookup`, and
`/api/catalog/product`.

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
