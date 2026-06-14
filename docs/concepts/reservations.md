# Reservations

Reservations are the wallet's local guardrail against double-spend and partial
failure. Before checkout, `Wallet.pay()` writes a pending reservation to the
encrypted ledger. After checkout:

- success settles the reservation with the merchant receipt
- failure releases it with an error summary
- resumable approval marks it as escalated with an expiry

```ts
const pending = await wallet.pendingReservations();
const usage = await wallet.spendInWindow("daily", "USD");
```

Reservations count toward daily, weekly, and monthly limits while pending.
Settled receipts count as captured spend. Released reservations stop counting.

## Reconciliation

If a merchant charge succeeds but receipt persistence fails, `wallet.pay()`
throws `ReceiptPersistenceFailed`. The error includes the receipt and
reservation id. Operators can later call:

```ts
await wallet.reconcile(reservationId, { decision: "complete", receipt });
```

or release an abandoned reservation:

```ts
await wallet.reconcile(reservationId, { decision: "release" });
```
