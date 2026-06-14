# Buyer Purchase API

`Wallet.pay(intent, { merchant })` is the v0.3 purchase surface. It composes:

- buyer policy evaluation
- encrypted vault card release inside a callback
- spend reservation and settlement
- ACP or UCP checkout driver
- delegate-payment vault-token exchange
- receipt persistence

```ts
import { Wallet } from "@steelyard/buyer";
import { Steelyard } from "@steelyard/buyer/client";

const wallet = await Wallet.open({ password: process.env.STEELYARD_PASSWORD });
const merchant = await Steelyard.connect("https://coffee.example/acp/feed", {
  delegatePaymentUrl: "https://psp.example/agentic_commerce/delegate_payment"
});
if ("error" in merchant) throw new Error(merchant.error_detail ?? merchant.error);

const receipt = await wallet.pay(intent, {
  merchant,
  idempotencyKey: "order_123"
});
```

## What `pay()` guarantees

`pay()` re-runs policy before spending. If denied, it throws
`WalletNotAllowed`. If approval is required and no approval or resume token is
provided, it throws `WalletApprovalRequired`.

Before calling the merchant it writes a reservation to the encrypted ledger.
If merchant checkout fails, the reservation is released. If the merchant
charges but receipt persistence fails, `ReceiptPersistenceFailed` includes the
receipt and reservation id for reconciliation.

## Receipts

Receipts are stored in the vault ledger and can be queried later:

```ts
const receipts = await wallet.listReceipts();
const usage = await wallet.spendInWindow("daily", "USD");
```

ACP receipts include `reference.acp.checkout_session_id`. UCP receipts include
`reference.ucp.checkout_id` and a Steelyard mandate id.

## Legacy `pay()`

`wallet.pay(intent)` without a `merchant` option keeps the v0.2 compatibility
behavior: it returns a `Payment` object that can reveal raw card data inside
`withRawCard()`. New purchase flows should pass `{ merchant }`.
