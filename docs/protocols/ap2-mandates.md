# UCP AP2 Mandates

Steelyard v0.5 implements the UCP AP2 Mandates extension for UCP checkout.
AP2 is active only when the merchant profile and buyer profile both advertise
`dev.ucp.shopping.ap2_mandate`.

Once AP2 is active, the checkout session is locked into the AP2 flow:

- checkout responses include `ap2.merchant_authorization`
- completion requests include `ap2.checkout_mandate`
- the selected UCP `credential.token` field carries the AP2 payment mandate
- legacy Steelyard mandate fallback is disabled for that session

## Discovery

Merchants advertise AP2 by enabling the UCP AP2 discovery config:

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

Buyers advertise AP2 from their HMS profile:

```ts
const profile = createUcpBuyerProfile({
  signingKeys: [await wallet.exportUcpSigningPublicKey()],
  ap2: { enabled: true }
});
```

`signing_keys[]` remains top-level in the profile. AP2 does not introduce a
second key-discovery format.

## Flow

1. The buyer sends its profile URL in `UCP-Agent` as part of UCP HMS auth.
2. The merchant fetches that profile and computes the capability intersection.
3. If both sides advertise `dev.ucp.shopping.ap2_mandate`, the merchant stores
   the checkout as AP2-locked and issues checkout/payment nonces.
4. The merchant returns the checkout with `ap2.merchant_authorization`, plus
   `ap2.checkout_nonce` and `ap2.payment_nonce`.
5. The buyer verifies `ap2.merchant_authorization` before user consent.
6. The buyer completes checkout with `ap2.checkout_mandate` and a payment
   mandate at `payment.instruments[*].credential.token`.
7. The merchant verifies the checkout mandate, consumes the nonce, verifies the
   embedded merchant authorization, and passes the payment mandate to the PSP
   adapter for payment-level verification.

## Merchant Authorization

`ap2.merchant_authorization` is a detached JWS:

```text
<base64url-header>..<base64url-signature>
```

The payload is the JCS-canonicalized checkout with the entire `ap2` field
removed. The JWS header contains `alg` and `kid`; `kid` resolves against the
merchant profile's top-level `signing_keys[]`.

The merchant signer reuses the same HMS signing key configuration used for UCP
HTTP Message Signatures:

```ts
ap2MerchantAuthorizationSigner({
  signingKeys,
  activeKid: "merchant_2026"
});
```

## Checkout Mandate

`ap2.checkout_mandate` is an SD-JWT+KB presentation. It includes the full
checkout, including `ap2.merchant_authorization`, so the buyer-signed mandate is
bound to the merchant-signed checkout terms.

The buyer always discloses the checkout terms required for verification:
checkout id, currency, line items, totals, and merchant authorization. Buyer
identity fields such as email, name, and address can be selectively disclosed.

## Envelope Validation

The vendored UCP AP2 schema includes a restrictive pattern for
`checkout_mandate` that does not accept the KB-JWT segment's dots. Steelyard
therefore validates the AP2 envelope shape with AJV and validates the actual
SD-JWT+KB presentation with the mandate parser and verifier.

Empty or missing mandate strings fail at the envelope layer. Malformed,
tampered, expired, wrong-audience, wrong-nonce, or wrong-checkout mandates fail
at the verifier.

## Error Codes

AP2 failures map to the UCP AP2 error enum:

- `mandate_required`
- `agent_missing_key`
- `mandate_invalid_signature`
- `mandate_expired`
- `mandate_scope_mismatch`
- `merchant_authorization_invalid`
- `merchant_authorization_missing`

## Interop Fixtures

As of 2026-06-15, no non-Steelyard AP2 implementation fixture is checked into
the repository. The documented gap is tracked in
`packages/merchant/spec-fixtures/ap2/README.md`; the v0.5 verify harness uses
generated Steelyard fixtures and focused AP2 tests until an external fixture is
available.
