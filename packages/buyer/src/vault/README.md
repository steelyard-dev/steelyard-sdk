# `@steelyard/buyer/vault` (scaffolded; not yet shipped)

Local-first encrypted vault for billing identity, addresses, and payment cards.
Password-manager-shaped: stores raw PANs + billing info on disk (AES-256-GCM),
master key in the OS keychain (macOS Keychain / Linux Secret Service / Windows
Credential Vault) via `keytar`.

Layout:

```
~/.steelyard/
└── vault.enc                   # AES-256-GCM blob; master key in OS keychain
```

Decrypted contents:

```yaml
profile:
  name: "Riccardo"
  email: "riccardo@example.com"
addresses:
  default: { line1, city, postal_code, country }
cards:
  - id: "personal"
    name_on_card: "Riccardo X"
    pan: "4242424242424242"
    exp: "12/27"
    brand: "visa"
    last4: "4242"
    tags: ["default"]
  - id: "biz"
    tags: ["github.com", "linear.app"]
```

CVV is intentionally **not** stored — most card-on-file checkout flows accept
the card without it. If a merchant requires CVV, prompt at purchase time.

API (planned):

```typescript
import { BuyerVault } from "@steelyard/buyer/vault";

const vault = await BuyerVault.openGlobal();    // ~/.steelyard/vault.enc
// or:
const vault = await BuyerVault.openProject();   // ./.steelyard/vault.enc

await vault.addCard({ id: "personal", pan, exp, brand, last4 });
const card    = await vault.pickCard({ merchant: "github.com" });
const billing = await vault.billing();
```

This subpath is **not yet in `package.json#exports`** — it ships when the
implementation is complete (no-stubs rule).
