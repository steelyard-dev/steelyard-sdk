# Wallet (junior surface)

`@steelyard/buyer` is the simple buyer surface. It composes the policy engine
and encrypted vault so application code does not handle policy YAML or raw PANs.

```ts
import { Wallet } from "@steelyard/buyer";
import { Steelyard } from "@steelyard/buyer/client";

const wallet = await Wallet.open();
const merchant = await Steelyard.connect("https://coffee.example/acp/feed", {
  delegatePaymentUrl: "https://psp.example/agentic_commerce/delegate_payment"
});

if ("error" in merchant) throw new Error(merchant.error_detail ?? merchant.error);

const receipt = await wallet.pay(intent, { merchant });
```

## First setup

```ts
import { Wallet } from "@steelyard/buyer";

const wallet = await Wallet.create({
  card: { number: "4242 4242 4242 4242", exp: "12/29", name: "Jane Doe" },
  billing: {
    email: "jane@example.com",
    address: { line1: "1 Main St", city: "SF", postal_code: "94110", country: "US" }
  },
  limits: {
    daily: { USD: 100 },
    weekly: { USD: 500 },
    monthly: { USD: 2000 }
  },
  allowedMerchants: ["coffee.example", "github.com", "*.github.com"],
  approvalAbove: { USD: 25 },
  recovery: { path: "~/.steelyard/recovery.enc", password: process.env.STEELYARD_RECOVERY_PASSWORD! },
  password: process.env.STEELYARD_PASSWORD
});
```

Omit `password` on desktops to use the OS keychain. Pass `password` for
headless Linux, Docker, SSH-only sessions, Alpine, or any environment without a
working Secret Service/keychain.

## Decisions

Use `isAllowed(intent)` when a boolean is enough. Use `decide(intent)` when you
need the discriminated union:

```ts
const decision = await wallet.decide(intent);
switch (decision.status) {
  case "allowed":
    break;
  case "approval_required":
    break;
  case "denied":
    console.error(decision.reason);
    break;
}
```

## Purchase

`pay()` calls `decide()` again as a safety check. Denied intents throw. Approval
thresholds require an `approval` proof.

```ts
const receipt = await wallet.pay(intent, {
  merchant,
  idempotencyKey: "purchase_123",
  approval: { kind: "manual", token: "approval_123" }
});

console.log(receipt.order_id);
```

When a `merchant` option is supplied, the wallet reserves spend in the encrypted
ledger, calls ACP or UCP checkout, settles the reservation with the receipt, and
persists that receipt.

Calling `wallet.pay(intent)` without a `merchant` option keeps the v0.2
compatibility behavior: it returns a `Payment` object that can reveal raw card
details inside `withRawCard()`.

## Maintenance

| Method | Effect |
| --- | --- |
| `addCard(card)` | Adds a card. Use `merchants` for routing and `default` for fallback. |
| `removeCard(id)` | Removes a card and re-encrypts the vault. |
| `listCards()` | Returns metadata only; no PAN. |
| `setDefaultCard(id)` | Promotes a card to fallback. |
| `setLimits(limits)` | Rewrites the wallet-owned limits block. |
| `setAllowedMerchants(merchants)` | Rewrites the wallet-owned allow rule. |
| `setApprovalAbove(threshold)` | Rewrites the wallet-owned approval threshold. |
| `updateBilling(partial)` | Updates the default billing address. |
| `listSpend(opts)` | Reads the per-vault spend ledger. |
| `listReceipts(opts)` | Reads persisted v0.3 merchant checkout receipts. |
| `pendingReservations()` | Lists reservations that have not settled or released. |
| `spendInWindow(window, currency)` | Sums daily, weekly, or monthly spend. |
| `createMandateKey()` | Creates the UCP checkout signing key if missing. |
| `exportMandatePublicKey()` | Exports the public key for merchant trust configuration. |
| `exportRecovery({ path, password })` | Writes a password-wrapped recovery file. |
| `rotatePassword({ oldPassword, newPassword })` | Rotates password-mode vaults. |
