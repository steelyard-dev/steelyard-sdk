# `@steelyard/merchant/checkout`

Merchant-side checkout assembly for ACP and UCP. It mounts checkout
routes over the same `defineCommerce()` manifest, using a session store,
idempotency store, PSP adapter, and optional merchant policy.

```ts
import { createMerchantCheckout, memoryCheckoutSessionStore, memoryIdempotencyStore } from "@steelyard/merchant/checkout";
import { mockPsp } from "@steelyard/merchant/psp";
import {
  ap2MerchantAuthorizationSigner,
  fileNonceStore,
  mockMandateVerifier,
  sdJwtKbVerifier
} from "@steelyard/merchant/mandate";

const ap2NonceStore = fileNonceStore({ dir: "/var/lib/steelyard/ap2-nonces" });

const checkout = createMerchantCheckout(manifest, {
  protocols: ["acp", "ucp"],
  store: memoryCheckoutSessionStore(),
  idempotency: memoryIdempotencyStore(),
  psp: mockPsp({ allowInProduction: true }),
  mandateVerifier: mockMandateVerifier({ allowInProduction: true }),
  steelyardMandate: true,
  baseUrl: "https://coffee.example",
  merchantAudience: "https://coffee.example/.well-known/ucp",
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
        verify: async (token) => verifyPartnerToken(token)
      }
    },
    responseSigningPolicy: "high-value-only",
    ap2: {
      enabled: true,
      nonceStore: ap2NonceStore,
      merchantAuthorizationSigner: ap2MerchantAuthorizationSigner({
        signingKeys: [
          { kid: "merchant_2026", privateKeyJwk: merchantPrivateJwk, algorithm: "ES256" }
        ],
        activeKid: "merchant_2026"
      }),
      mandateVerifier: sdJwtKbVerifier({
        trustModel: {
          kind: "digital_payment_credential",
          resolveIssuerKey: async ({ issuer, kid }) => trustedDpcKey({ issuer, kid })
        },
        expectedAudience: () => "https://coffee.example/.well-known/ucp",
        nonceStore: ap2NonceStore,
        merchantSigningKeys: [merchantPublicJwk]
      })
    }
  }
});

http.createServer(checkout.handler).listen(3000);
```

## Routes

ACP routes are served under `/acp`:

- `POST /acp/checkout_sessions`
- `GET /acp/checkout_sessions/:id`
- `PATCH /acp/checkout_sessions/:id`
- `POST /acp/checkout_sessions/:id/complete`
- `POST /acp/checkout_sessions/:id/cancel`
- `POST /acp/discounts`

UCP checkout routes are served under both `/api` and `/ucp/api`:

- `POST /api/checkout`
- `GET /api/checkout/:id`
- `PATCH /api/checkout/:id`
- `POST /api/checkout/:id/complete`
- `POST /api/checkout/:id/cancel`
- `POST /ucp/api/checkout`
- `GET /ucp/api/checkout/:id`
- `PATCH /ucp/api/checkout/:id`
- `POST /ucp/api/checkout/:id/complete`
- `POST /ucp/api/checkout/:id/cancel`

Use `/api` for spec-facing UCP deployments. The `/ucp/api` routes remain
available for hosts that keep checkout under a namespaced local prefix.

## UCP Auth

`ucp.auth.hms` enables HTTP Message Signature verification and response signing.
`signingKeys` are the merchant's own private keys for outgoing signatures and
published public discovery keys. Incoming signatures are verified against the
peer profile advertised in the request's `UCP-Agent` header.

`ucp.auth.bearer` enables bearer auth through a merchant-provided
`verify(token)` callback. If a request contains both HMS and bearer auth,
Steelyard prefers HMS.

`responseSigningPolicy` controls UCP response signatures:

- `"high-value-only"` signs UCP completion responses.
- `"all"` signs all UCP checkout responses that pass through the signed
  response writer.
- `"off"` disables response signatures.

## Stores

Use `memoryCheckoutSessionStore()` and `memoryIdempotencyStore()` for tests and
examples. Use the file-backed stores for local development or single-node
deployments. Both stores are deliberately small interfaces so production users
can provide database-backed implementations.

## PSPs

`@steelyard/merchant/psp` ships:

- `mockPsp()` for tests and demos. Outside known test environments it requires
  `allowInProduction: true` and `STEELYARD_ALLOW_MOCK_PSP=1`.
- `stripePsp({ apiKey })` for Stripe test or live mode.

Mock PSPs must not be silently enabled in production. The explicit env guard is
intentional.

## Mandates

Base UCP checkout does not require a mandate verifier. To enable Steelyard
mandate mode, set `steelyardMandate: true` and pass a `MandateVerifier`. For
development use `mockMandateVerifier()` with the same explicit guard pattern as
`mockPsp()`. For real Steelyard mandates use
`steelyardJwsVerifier({ trustedKeys, mode: "enabled" })`.

## AP2

Set `ucp.ap2.enabled: true` to participate in AP2-locked UCP sessions. AP2 also
requires UCP HMS signing keys, `ucp.ap2.merchantAuthorizationSigner`,
`ucp.ap2.mandateVerifier`, and `ucp.ap2.nonceStore`.

When the buyer profile also advertises `dev.ucp.shopping.ap2_mandate`, the
merchant stores the session as AP2-locked, returns
`ap2.merchant_authorization`, `ap2.checkout_nonce`, and `ap2.payment_nonce`,
and rejects completion requests that do not include `ap2.checkout_mandate`.

`sdJwtKbVerifier()` implements the Digital Payment Credential trust hook. Its
`resolveIssuerKey` callback is where production deployments connect their
issuer trust registry or OpenID4VP credential verification.

## Status mapping

ACP completed sessions with confirmed or created orders map to the buyer
receipt state `captured`. UCP completed checkouts map to `completed`.
Both are terminal successful states; they reflect the source protocol's order
vocabulary.
