# Idempotency

Checkout uses idempotency at three layers:

- Buyer purchase key: `Wallet.pay()` accepts `idempotencyKey`; otherwise it
  generates one.
- Driver subkeys: checkout create, delegate-payment, update, and complete use
  deterministic suffixes such as `<key>:create` and `<key>:complete`.
- Merchant stores: mutating checkout routes persist the response for a request
  body hash and reject conflicting replays.

This means a retry after a network drop can safely receive the same checkout or
receipt response, while an accidental reuse of the same key for a different
body returns an idempotency conflict.

## Merchant store contract

`memoryIdempotencyStore()` is for tests and examples. `fileIdempotencyStore()`
is useful for single-node local deployments. Production systems should provide
a database-backed implementation with the same semantics:

```ts
remember(key, bodyHash, async () => response)
```

The callback must run at most once for the same key/body pair.

## Key hygiene

Use one purchase key per intended purchase. Do not use timestamps rounded to a
second, cart ids shared across retries for different totals, or user ids as
idempotency keys.
