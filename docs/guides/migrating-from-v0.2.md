# Migrating From v0.2

v0.2 wallet payment released card details to application code:

```ts
const session = await wallet.createBrowserManualSession(intent);
await session.revealCard(async (card) => {
  // app-owned checkout
});
await session.complete({ status: "completed" });
```

v0.3 adds merchant checkout:

```ts
const merchant = await Steelyard.connect(url, { delegatePaymentUrl });
if ("error" in merchant) throw new Error(merchant.error_detail ?? merchant.error);

const receipt = await wallet.purchase(intent, {
  merchant,
  idempotencyKey: "purchase_123"
});
```

## What changes

- Use `wallet.purchase(intent, { merchant })` for real ACP/UCP checkout.
- Configure `delegatePaymentUrl` when connecting to merchants that require
  direct delegate payment.
- Use `wallet.createBrowserManualSession(intent)` only for integrations that
  still own the browser checkout call.
- Read receipts with `wallet.listReceipts()` instead of only legacy
  `listSpend()`.
- Create mandate keys for wallets that predate v0.3 and need UCP checkout:
  `await wallet.createMandateKey()`.

`PurchaseIntent.amount` is the maximum amount the wallet is authorizing for the
merchant checkout, not proof that the merchant captured that exact value. Use
captured receipts to reconcile spend, and use `spendInWindow()` for limit checks
instead of rebuilding totals from `listSpend()`.

## Ledger migration

When a v0.3 wallet opens a v0.2 plaintext `spend-ledger.jsonl`, completed rows
are migrated into the encrypted ledger and the plaintext file is renamed with a
`.migrated-*` suffix. Failed rows are ignored for captured spend.
