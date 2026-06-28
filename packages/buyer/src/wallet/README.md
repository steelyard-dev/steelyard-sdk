# `@steelyard/buyer`

Root `Wallet` facade for buyer-side payment instruments.

```ts
import { Wallet, vaultedCard } from "@steelyard/buyer";
import { stripeSpt } from "@steelyard/stripe/buyer";
import { x402Payments } from "@steelyard/x402";

const wallet = await Wallet.open();

await wallet.addInstrument(stripeSpt({ apiKey: process.env.STRIPE_SECRET_KEY! }));
await wallet.addInstrument(x402Payments({
  signer,
  networks: ["eip155:84532"],
  assets: ["USDC"],
  schemes: ["exact"]
}));
await wallet.addInstrument(vaultedCard({
  number: "4242 4242 4242 4242",
  exp: "12/29",
  name: "Jane Doe",
  merchants: ["legacy-shop.example"]
}));

const mandate = await wallet.prepareMandate(intent);
const session = await wallet.createBrowserManualSession(intent);
```

`Wallet` composes `WalletRules` and `BuyerVault` internally. It does not expose
`wallet.policy` or `wallet.vault`; power users import
`@steelyard/buyer/policy` and `@steelyard/buyer/vault` directly.

## Payment modes

- `agent-native`: `stripeSpt(...)`, `referenceMandate(...)`, `x402Payments(...)`,
  or another `PaymentMandateIssuer` issues a scoped `PaymentMandate` for
  agentic checkout or paid HTTP resources.
- `browser-manual`: `vaultedCard(...)` stores legacy cards locally and returns a
  `BrowserManualSession` for browser automation or manual checkout.

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
