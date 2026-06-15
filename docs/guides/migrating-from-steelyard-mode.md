# Migrating From Steelyard Mode

Steelyard-mode mandates (`net.steelyard.checkout_mandate.v0_1`) remain available
for pre-AP2 UCP partners in v0.5. They are not used when both buyer and merchant
advertise AP2.

## What Changes

Legacy Steelyard mode sends one buyer-signed mandate under the
`steelyard.checkout_mandate` namespace.

AP2 sends three signed artifacts:

- `ap2.merchant_authorization`
- `ap2.checkout_mandate`
- the payment mandate in `payment.instruments[*].credential.token`

When `dev.ucp.shopping.ap2_mandate` is present in both profiles, the session is
AP2-locked. The merchant rejects completion without `ap2.checkout_mandate`, and
the buyer refuses to fall back to Steelyard mode.

## Merchant Steps

Keep Steelyard mode enabled only for partners that have not moved to AP2:

```ts
const ap2NonceStore = fileNonceStore({ dir: "/var/lib/steelyard/ap2-nonces" });

const checkout = createMerchantCheckout(manifest, {
  protocols: ["ucp"],
  store,
  idempotency,
  psp,
  steelyardMandate: true,
  mandateVerifier: steelyardJwsVerifier({ trustedKeys, mode: "enabled" }),
  ucp: {
    auth: {
      hms: {
        enabled: true,
        signingKeys,
        activeKid: "merchant_2026"
      }
    },
    ap2: {
      enabled: true,
      nonceStore: ap2NonceStore,
      merchantAuthorizationSigner: ap2MerchantAuthorizationSigner({
        signingKeys,
        activeKid: "merchant_2026"
      }),
      mandateVerifier: sdJwtKbVerifier({
        trustModel,
        expectedAudience: () => "https://coffee.example/.well-known/ucp",
        merchantSigningKeys: merchantPublicKeys,
        nonceStore: ap2NonceStore
      })
    }
  }
});
```

Advertise both capabilities during the migration window:

```ts
buildUcpDiscovery(manifest, {
  baseUrl: "https://coffee.example",
  checkout: true,
  steelyardMandate: true,
  ucp: {
    auth: { hms: { enabled: true, signingKeys: merchantPublicKeys } },
    ap2: { enabled: true }
  }
});
```

## Buyer Steps

Create or export the UCP signing key and host a buyer profile that advertises
AP2:

```ts
await wallet.createUcpSigningKey({ algorithm: "ES256" });

const profile = createUcpBuyerProfile({
  signingKeys: [await wallet.exportUcpSigningPublicKey()],
  ap2: { enabled: true }
});
```

Connect with HMS auth and AP2 issuance options:

```ts
const merchant = await Steelyard.connect("https://coffee.example/.well-known/ucp", {
  ucpAuth: {
    preferred: "hms",
    signing: {
      kid: "wallet_2026",
      algorithm: "ES256",
      profileUrl: "https://wallet.example/.well-known/ucp"
    }
  },
  ap2: {
    enabled: true,
    issuer: "did:example:dpc-issuer"
  }
});
```

`merchant.supports("checkout:ap2")` is true only when the merchant profile, the
buyer profile, and the wallet key are all AP2-ready.

## Verify

Run the AP2 smoke flow:

```sh
pnpm --filter @steelyard/example-coffee-shop tsx scripts/smoke-ap2.ts
```

The smoke verifies merchant authorization, checkout mandate verification,
payment mandate verification, and AP2 nonce consumption.
