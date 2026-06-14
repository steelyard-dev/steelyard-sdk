# `@steelyard/buyer/policy` (scaffolded; not yet shipped)

YAML-driven authorization for autonomous agent buying. CanCanCan-shaped: rules
declare what the agent **can** or **cannot** buy, with merchant, currency, and
amount predicates plus per-period spending limits.

```yaml
# ~/.steelyard/policy.yml
version: "0.1"
default: deny

rules:
  - name: "coffee under $15"
    can: buy
    where:
      merchant_domain: "*.coffee.example"
      currency: USD
      amount: { lte: 1500 }   # cents

  - name: "blocked"
    cannot: buy
    where:
      merchant_domain: ["*.adult.example", "casino-*.com"]

limits:
  daily:   { USD: 10000 }
  weekly:  { USD: 50000 }
  monthly: { USD: 200000 }
```

API (planned):

```typescript
import { BuyerPolicy } from "@steelyard/buyer/policy";

const policy = await BuyerPolicy.load();           // ~/.steelyard/policy.yml
const decision = policy.evaluate(intent);
// → { allowed: true }
// → { allowed: false, reason: "no matching rule (deny-by-default)" }
// → { requires_approval: true, threshold: 2500, matched_rule: "..." }
```

This subpath is **not yet in `package.json#exports`** — it ships when the
implementation is complete (no-stubs rule).
