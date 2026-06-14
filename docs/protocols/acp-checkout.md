# ACP Checkout

Steelyard v0.3 supports ACP checkout through
`@steelyard/merchant/checkout` and `@steelyard/buyer/client/acp`.

The buyer flow is:

1. `Steelyard.connect()` reads an ACP feed with `capabilities.services`
   containing `checkout`.
2. The buyer creates `POST /acp/checkout_sessions` with line items and
   currency.
3. The merchant returns a ready-for-payment checkout session and advertises a
   vault-token payment handler.
4. The buyer calls the configured delegate-payment endpoint to exchange the
   raw card for a vault token.
5. The buyer completes `POST /acp/checkout_sessions/:id/complete`.
6. The merchant captures via the configured PSP adapter and returns a schema
   valid `CheckoutSessionWithOrder`.

## Discovery fields

Steelyard's strict ACP feed builder emits only the spec-validated product feed.
Checkout-capable deployments should extend the served feed with:

```json
{
  "merchant": { "domain": "coffee.example" },
  "capabilities": { "services": ["read", "checkout"] }
}
```

`Steelyard.connect()` uses `merchant.domain` as the merchant id and strips a
trailing `/feed` from the feed URL to find the checkout base.

## Idempotency

The ACP driver uses the caller's purchase key to derive:

- `<key>:create`
- `<key>:delegate`
- `<key>:complete`

The merchant checkout assembly requires an `idempotency-key` header on every
mutating route and returns a conflict if the same key is reused with a
different request body.

## Receipt state

ACP `completed` sessions with order status `confirmed`, `created`, or
`processing` become buyer receipts with status `captured`. Order status
`completed` or `shipped` becomes `completed`.
