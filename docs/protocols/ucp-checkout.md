# UCP Checkout

Steelyard supports UCP checkout through `steelyard/merchant/checkout` and
`steelyard/buyer/client/ucp`.

UCP checkout is advertised from the discovery document with the full capability
key `dev.ucp.shopping.checkout`. AP2 mandate support is advertised separately
as `dev.ucp.shopping.ap2_mandate`. Legacy Steelyard mandate mode remains
available as `net.steelyard.checkout_mandate.v0_1` for pre-AP2 partners.

```ts
const discovery = buildUcpDiscovery(manifest, {
  baseUrl: "https://coffee.example",
  checkout: true,
  steelyardMandate: true,
  ucp: {
    auth: { hms: { enabled: true, signingKeys: merchantPublicKeys } },
    ap2: { enabled: true }
  }
});
```

## Route shape

`buildUcpDiscovery()` advertises the REST shopping service at `/api`.
`createCheckoutServer()` accepts both the spec-facing `/api/checkout*` routes
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

AP2 mandates are negotiated through the UCP capability intersection. When both
profiles advertise `dev.ucp.shopping.ap2_mandate`, the session is AP2-locked:
checkout responses carry `ap2.merchant_authorization`, and completion requests
must carry `ap2.checkout_mandate` plus a payment mandate in the selected
credential token.

See [UCP AP2 Mandates](ap2-mandates.md) and
[Payment Mandates](../concepts/payment-mandates.md).

Legacy Steelyard mandates are still opt-in for pre-AP2 interop. Set
`steelyardMandate: true` on `createCheckoutServer()` and pass a
`mandateVerifier` when the merchant advertises
`net.steelyard.checkout_mandate.v0_1`. Without that switch, vanilla UCP
completion proceeds without a legacy mandate.

When mandate mode is negotiated, the buyer signs a Steelyard checkout mandate
with:

- `aud`: the canonical UCP discovery URL
- `steelyard:checkout`: the canonical checkout snapshot
- `steelyard:payment`: selected handler and vault token
- `steelyard:purchase_key`: the idempotency purchase key

The merchant verifies that mandate before PSP capture. This prevents a vault
token from being replayed against a different checkout, merchant audience, or
payment handler.

## AP2 And Steelyard Mode

Steelyard v0.5 is AP2-compliant for AP2-locked UCP sessions. Steelyard mode is
kept only for partners that do not advertise AP2. If AP2 appears in both
profiles, the buyer and merchant must not fall back to Steelyard mode.

## Receipt state

UCP `completed` checkouts become buyer receipts with status `completed`.
Escalation and cancellation map to `escalation_required` and `canceled`.
