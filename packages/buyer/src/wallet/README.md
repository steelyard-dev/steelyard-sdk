# `@steelyard/buyer`

Root Wallet facade for the junior path.

```ts
import { Wallet } from "@steelyard/buyer";

const wallet = await Wallet.open();

if (await wallet.isAllowed(intent)) {
  const payment = await wallet.pay(intent);
  await payment.cancel();
}
```

`Wallet` composes `BuyerPolicy` and `BuyerVault` internally. It does not expose
`wallet.policy` or `wallet.vault`; power users import
`@steelyard/buyer/policy` and `@steelyard/buyer/vault` directly.

## Setup

`Wallet.create()` creates the vault, writes the wallet-owned policy section,
adds the first default card, stores billing, optionally exports recovery, and
returns an open wallet.

```ts
await Wallet.create({
  card: { number: "4242 4242 4242 4242", exp: "12/29", name: "Jane Doe" },
  billing: {
    email: "jane@example.com",
    address: { line1: "1 Main St", city: "SF", postal_code: "94110", country: "US" }
  },
  limits: { daily: { USD: 100 }, weekly: { USD: 500 }, monthly: { USD: 2000 } },
  allowedMerchants: ["coffee.example", "github.com", "*.github.com"],
  approvalAbove: { USD: 25 },
  recovery: { path: "~/.steelyard/recovery.enc", password: process.env.STEELYARD_RECOVERY_PASSWORD! }
});
```

Omit `password` to use the OS keychain. Pass `password` for password-derived
vaults on headless or portable environments.
