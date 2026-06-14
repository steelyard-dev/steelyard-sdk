# Wallet (junior surface)

`@steelyard/buyer` is the simple buyer surface. It composes the policy engine
and encrypted vault so application code does not handle policy YAML or raw PANs.

```ts
import { Wallet } from "@steelyard/buyer";

const wallet = await Wallet.open();

if (await wallet.isAllowed(intent)) {
  const payment = await wallet.pay(intent);
  await payment.cancel(); // v0.2 releases card details; v0.3 will charge.
}
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

## Payment

`pay()` calls `decide()` again as a safety check. Denied intents throw. Approval
thresholds require an `approval` proof.

```ts
const payment = await wallet.pay(intent, {
  approval: { source: "user", ts: new Date().toISOString() }
});

console.log(payment.metadata); // brand, last4, exp, name; no PAN
console.log(payment.billing);  // email and billing address

await payment.withRawCard(async (card) => {
  // card.number is available only inside this callback.
});

await payment.complete({ status: "completed", ref: "merchant_ref" });
```

v0.2 does not charge merchants. It releases card and billing details to the
caller. v0.3 will add an enforced purchase flow.

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
| `spendInWindow(window, currency)` | Sums daily, weekly, or monthly spend. |
| `exportRecovery({ path, password })` | Writes a password-wrapped recovery file. |
| `rotatePassword({ oldPassword, newPassword })` | Rotates password-mode vaults. |
