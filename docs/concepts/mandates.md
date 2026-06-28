# Mandates

A mandate is a signed buyer instruction that binds authorization to a specific
merchant checkout.

Steelyard now has two UCP mandate paths:

- AP2 mandates for `dev.ucp.shopping.ap2_mandate` sessions.
- Legacy Steelyard mandates for pre-AP2 partners that advertise
  `net.steelyard.checkout_mandate.v0_1`.

AP2 is preferred whenever both buyer and merchant advertise it. Legacy
Steelyard mode is never used inside an AP2-locked session.

## AP2 Mandates

AP2 uses three artifacts:

- `ap2.merchant_authorization`, signed by the merchant over checkout terms
- `ap2.checkout_mandate`, signed by the buyer as an SD-JWT+KB presentation
- a payment mandate at `payment.instruments[*].credential.token`

See [UCP AP2 Mandates](../protocols/ap2-mandates.md) and
[Payment Mandates](payment-mandates.md).

## Legacy Steelyard Mode

Legacy Steelyard mandate mode is an optional UCP checkout extension for
merchants that want a buyer-signed checkout snapshot before PSP capture without
AP2.

## What is signed

The buyer signs:

- issuer key id
- pairwise buyer subject for the merchant audience
- canonical merchant audience
- issued-at and expiry
- canonical checkout snapshot
- purchase key
- selected payment handler and vault token

The checkout snapshot includes the checkout id, line items, totals, and
currency. If any of those change, verification fails.

## Buyer keys

`Wallet.create()` creates a mandate key by default. Existing wallets can call:

```ts
await wallet.createMandateKey();
const publicKey = await wallet.exportMandatePublicKey();
```

The private key stays in the encrypted vault. The merchant needs the public key
through whatever trust channel your deployment chooses.

## Merchant verification

Use `steelyardJwsVerifier({ trustedKeys, mode: "enabled" })` for real
verification, and set `steelyardMandate: true` on `createCheckoutServer()`.
Use `mockMandateVerifier()` only for tests and demos; outside known test
environments it requires both an explicit option and
`STEELYARD_ALLOW_MOCK_MANDATE=1`.
