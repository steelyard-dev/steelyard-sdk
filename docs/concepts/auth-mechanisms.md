# UCP Auth Mechanisms

Steelyard supports two auth mechanisms for UCP checkout:

- **HTTP Message Signatures (HMS)** for signed UCP requests and selected signed
  responses.
- **Bearer tokens** for partners that authenticate UCP calls with an
  application-defined token.

Both mechanisms can be enabled at the same merchant. If a request carries both
`Signature-Input` and `Authorization: Bearer ...`, Steelyard verifies the
signature and ignores the bearer token for dispatch.

## Merchant Selection

Adding `ucp.auth` to `createMerchantCheckout()` enables auth enforcement for
UCP checkout routes:

```ts
const checkout = createMerchantCheckout(manifest, {
  protocols: ["ucp"],
  store,
  idempotency,
  psp,
  baseUrl: "https://coffee.example",
  ucp: {
    auth: {
      hms: {
        enabled: true,
        signingKeys: [
          { kid: "merchant_2026", privateKeyJwk: merchantPrivateJwk, algorithm: "ES256" }
        ],
        activeKid: "merchant_2026"
      },
      bearer: {
        enabled: true,
        verify: async (token) => token === process.env.UCP_BEARER
          ? { ok: true, subject: "partner" }
          : { ok: false, reason: "unknown token" }
      }
    },
    responseSigningPolicy: "high-value-only"
  }
});
```

If `ucp.auth` is omitted, the checkout handler accepts unsigned UCP requests.
That mode is useful for local interop tests and vanilla demos, but production
merchants should enable HMS, bearer, or both.

## Buyer Selection

Buyers choose a preferred mechanism with `ucpAuth.preferred`:

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

When `preferred` is omitted, HMS is preferred. If the preferred mechanism is
not available, the buyer driver falls back to the other configured mechanism.
If neither can be produced, the driver throws `UcpAuthMissing` before sending a
request.

Buyers that sign with HMS must provide `ucpAuth.signing.profileUrl`.
`Steelyard.connect()` throws `BuyerHmsProfileMissing` when an HMS signing
config is present without that URL, because the merchant verifier needs the
profile to resolve the buyer public key.

## When To Use Which

Use HMS when the peer can host a UCP profile with public `signing_keys[]`.
HMS gives per-message integrity over method, authority, path, idempotency key,
and body digest.

Use bearer when integrating with a partner that already has a token issuer or
does not yet publish UCP signing profiles. Bearer token format is deliberately
application-defined; Steelyard only calls the merchant-provided `verify`
callback.

Use both during migrations. The merchant accepts either, and the buyer can
prefer HMS while retaining a bearer fallback.
