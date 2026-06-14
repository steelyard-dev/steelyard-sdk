# `@steelyard/merchant/checkout`

Merchant-side checkout assembly for v0.3. It mounts ACP and UCP checkout
routes over the same `defineCommerce()` manifest, using a session store,
idempotency store, PSP adapter, and optional merchant policy.

```ts
import { createMerchantCheckout, memoryCheckoutSessionStore, memoryIdempotencyStore } from "@steelyard/merchant/checkout";
import { mockPsp } from "@steelyard/merchant/psp";
import { mockMandateVerifier } from "@steelyard/merchant/mandate";

const checkout = createMerchantCheckout(manifest, {
  protocols: ["acp", "ucp"],
  store: memoryCheckoutSessionStore(),
  idempotency: memoryIdempotencyStore(),
  psp: mockPsp({ allowInProduction: true }),
  mandateVerifier: mockMandateVerifier({ allowInProduction: true }),
  baseUrl: "https://coffee.example",
  merchantAudience: "https://coffee.example/.well-known/ucp"
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

UCP checkout routes are served under `/ucp/api`:

- `POST /ucp/api/checkout`
- `GET /ucp/api/checkout/:id`
- `PATCH /ucp/api/checkout/:id`
- `POST /ucp/api/checkout/:id/complete`
- `POST /ucp/api/checkout/:id/cancel`

If your UCP discovery document advertises `/api`, route or rewrite
`/api/checkout*` to `/ucp/api/checkout*` before handing the request to
`checkout.handler`.

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

UCP checkout requires a `MandateVerifier`. For development use
`mockMandateVerifier()` with the same explicit guard pattern as `mockPsp()`.
For real Steelyard mandates use `steelyardJwsVerifier({ trustedKeys, mode:
"enabled" })`.

## Status mapping

ACP completed sessions with confirmed or created orders map to the buyer
receipt state `captured`. UCP completed checkouts map to `completed`.
Both are terminal successful states; they reflect the source protocol's order
vocabulary.
