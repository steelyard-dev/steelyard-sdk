# Configuring UCP Auth

This guide wires signed UCP checkout with bearer fallback. The same pieces work
for HMS-only and bearer-only deployments.

## Merchant

Configure HMS keys for outgoing response signing and incoming signature
verification. The merchant's private JWK stays in server-side configuration;
the public part is published through `buildUcpDiscovery()` as top-level
`signing_keys[]`.

```ts
import { createCheckoutServer } from "steelyard/merchant/checkout";

const checkout = createCheckoutServer(manifest, {
  protocols: ["ucp"],
  store,
  idempotency,
  psp,
  baseUrl: "https://coffee.example",
  ucp: {
    allowPrivateNetwork: false,
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
        verify: async (token) => verifyPartnerToken(token)
      }
    },
    responseSigningPolicy: "high-value-only"
  }
});
```

`responseSigningPolicy: "high-value-only"` signs successful UCP completion
responses. Set `"all"` for stricter response signing or `"off"` to disable
response signatures while still verifying incoming requests.

The checkout handler accepts both UCP route prefixes:

```text
POST  /api/checkout
GET   /api/checkout/:id
PATCH /api/checkout/:id
POST  /api/checkout/:id/complete
POST  /api/checkout/:id/cancel

POST  /ucp/api/checkout
GET   /ucp/api/checkout/:id
PATCH /ucp/api/checkout/:id
POST  /ucp/api/checkout/:id/complete
POST  /ucp/api/checkout/:id/cancel
```

Use `/api` when matching the discovery document. The `/ucp/api` prefix remains
available for deployments that keep UCP checkout behind a local namespace.

## Buyer HMS

Create a UCP signing key in the encrypted wallet vault, host a public buyer
profile, then pass the profile URL into `Steelyard.connect()`.

```ts
import { Wallet } from "steelyard/buyer";
import { Steelyard } from "steelyard/buyer/client";

const wallet = await Wallet.open();
const key = await wallet.createUcpSigningKey({ algorithm: "ES256" });

const merchant = await Steelyard.connect("https://coffee.example/.well-known/ucp", {
  ucpAuth: {
    preferred: "hms",
    signing: {
      kid: key.kid,
      algorithm: "ES256",
      profileUrl: "https://wallet.example/.well-known/ucp"
    }
  }
});
```

The buyer profile must contain the public key returned by
`wallet.exportUcpSigningPublicKey()`. See [Buyer HMS profile](buyer-hms-profile.md)
for hosting options.

## Buyer Bearer

For bearer-only partners, select bearer and provide the token:

```ts
const merchant = await Steelyard.connect("https://coffee.example/.well-known/ucp", {
  ucpAuth: {
    preferred: "bearer",
    bearerToken: process.env.UCP_BEARER
  }
});
```

If `preferred: "bearer"` is set but no token is present, the driver falls back
to HMS when signing config and a vault key are available.

## Local Loopback

Public profiles must use HTTPS. Local examples may use loopback HTTP only with
the explicit private-network opt-in:

```ts
await Steelyard.connect("http://127.0.0.1:3000/.well-known/ucp", {
  allowPrivateNetwork: true,
  ucpAuth: {
    preferred: "hms",
    signing: {
      kid: key.kid,
      algorithm: "ES256",
      profileUrl: "http://127.0.0.1:3000/buyer/.well-known/ucp"
    }
  }
});
```

Redirects are rejected even for loopback profiles.
