# `steelyard/buyer/policy`

YAML-driven authorization for agent purchases. This is the engine behind the
root `Wallet` facade and is exported for power users who need custom policy
loading.

```ts
import { WalletRules } from "steelyard/buyer/policy";

const policy = await WalletRules.load();
const decision = await policy.evaluate(intent, { vault });
```

## YAML shape

```yaml
version: "0.1"
default: deny
rules:
  - name: coffee
    can: buy
    where:
      merchant_domain: ["coffee.example", "*.coffee.example"]
      currency: USD
      amount: { lte: 1500 }
      offer_category: coffee
    requires_approval_above: { amount: 2500, currency: USD }
limits:
  daily: { USD: 10000 }
  weekly: { USD: 50000 }
  monthly: { USD: 200000 }
```

Parsing is strict: duplicate keys, anchors, aliases, tags, unsupported
versions, `can` plus `cannot`, and files larger than 1 MB are rejected. A rule
with `where.amount` must also specify `where.currency`.

## Evaluation

Rules are deterministic:

1. All `cannot` rules from project and global files run first.
2. Project `can` rules run next.
3. Global `can` rules follow.
4. The file default is the fallback.

Spending limits query the vault ledger. If a policy has non-zero limits and no
vault is supplied, evaluation denies with `spend_limits_require_vault` instead
of silently skipping caps.

Wallet-owned rules use the reserved `steelyard.wallet.*` namespace. Wallet
maintenance setters only modify those rules and preserve user-edited rules.
