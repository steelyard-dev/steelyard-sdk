# Payment Adapters

Steelyard v0.7 separates UCP payment negotiation from any single PSP. A merchant
PSP adapter declares capabilities:

```ts
{
  handlerId: "reference",
  instrumentType: "delegated_payment_token",
  idPrefix: "dpt_"
}
```

`@steelyard/merchant/checkout` turns those capabilities into UCP
`payment_handlers`, and the buyer wallet selects a handler only when its
`paymentIssuer.instrumentType` appears in the merchant's advertised
`available_instruments`. There is no implicit Stripe fallback when a UCP merchant
omits instrument advertisement.

## AP2 and HMS Crypto

AP2 mandate issuance and verification, AP2 envelope checks, merchant
authorization signing, AP2 payment-mandate verification, and UCP HTTP Message
Signature request/response operations live in `@steelyard/ucp-signing`.
Applications normally reach those functions through the existing buyer,
merchant, and protocol package exports, but the implementation has one home.

AP2 is still opt-in. A UCP session uses AP2 only when buyer and merchant profiles
negotiate the `dev.ucp.shopping.ap2_mandate` capability; otherwise Steelyard's
legacy `net.steelyard.checkout_mandate.v0_1` mandate mode remains available for
compatible partners. The buyer vault keeps UCP signing keys and exposes signing
through the `UcpSigner` interface, so the crypto package does not own key
storage.

## Stripe SPT

Stripe remains the production-oriented adapter in this release. `stripePsp()`
advertises `handlerId: "stripe"` with `instrumentType:
"shared_payment_token"` and `idPrefix: "spt_"`. The buyer-side
`createStripeSptIssuer()` mints Stripe SPTs, and the merchant captures them when
`acceptSharedPaymentTokens: true` is set.

Stripe SPT support is still Test-mode only in v0.7. Live keys are rejected, and
real SPT minting requires Stripe account access to the business-profile/SPT
preview.

## Reference PSP

The reference rail is for local interop, demos, and conformance tests:

- `createReferencePaymentIssuer()` mints `delegated_payment_token` handles with
  `dpt_` ids.
- `referencePsp()` verifies those signed handles before capture.
- Both helpers are default-deny outside known test environments. For demo or
  staging runs, pass `allowInProduction: true` and set
  `STEELYARD_ALLOW_REFERENCE_PSP=1`.

The reference token binds the merchant id, checkout id, transaction id, amount,
currency, handler id, instrument type, signature key, and expiry. It is not a
payment network, vault, PCI boundary, or production PSP replacement.

## ACP Boundary

ACP checkout is intentionally narrower in v0.7. The ACP driver accepts only a
`shared_payment_token` issuer and sends direct Stripe-style SPT `payment_data`.
Using the reference issuer, or any other non-SPT issuer, fails before minting.

UCP is the adapter-neutral checkout path. New PSP integrations should start with
a UCP capability declaration, a buyer issuer with a distinct `instrumentType`,
and a merchant adapter that verifies the handle before capture.
