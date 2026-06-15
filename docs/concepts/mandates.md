# Mandates

A mandate is a signed buyer instruction that binds a vault token to a specific
merchant checkout. Steelyard mandate mode is an optional UCP checkout extension
for merchants that want a buyer-signed checkout snapshot before PSP capture.

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
verification, and set `steelyardMandate: true` on `createMerchantCheckout()`.
Use `mockMandateVerifier()` only for tests and demos; outside known test
environments it requires both an explicit option and
`STEELYARD_ALLOW_MOCK_MANDATE=1`.
