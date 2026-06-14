# Migrating From v0.2

v0.2 wallet payment released card details to application code:

```ts
const payment = await wallet.pay(intent);
await payment.withRawCard(async (card) => {
  // app-owned checkout
});
await payment.complete({ status: "completed" });
```

v0.3 adds merchant checkout:

```ts
const merchant = await Steelyard.connect(url, { delegatePaymentUrl });
if ("error" in merchant) throw new Error(merchant.error_detail ?? merchant.error);

const receipt = await wallet.pay(intent, {
  merchant,
  idempotencyKey: "purchase_123"
});
```

## What changes

- Add a `merchant` option to `wallet.pay()` for real ACP/UCP checkout.
- Configure `delegatePaymentUrl` when connecting to merchants that require
  direct delegate payment.
- Keep `wallet.pay(intent)` only for legacy integrations that still own the
  checkout call.
- Read receipts with `wallet.listReceipts()` instead of only legacy
  `listSpend()`.
- Create mandate keys for wallets that predate v0.3 and need UCP checkout:
  `await wallet.createMandateKey()`.

## Ledger migration

When a v0.3 wallet opens a v0.2 plaintext `spend-ledger.jsonl`, completed rows
are migrated into the encrypted ledger and the plaintext file is renamed with a
`.migrated-*` suffix. Failed rows are ignored for captured spend.
