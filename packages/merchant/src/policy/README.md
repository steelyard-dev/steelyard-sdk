# `@steelyard/merchant/policy` (scaffolded; not yet shipped)

Merchant-side counterpart to `@steelyard/buyer/policy`. Declarative rules for
which agents the merchant accepts purchases from, rate limits per agent
identity, currency / region restrictions, and (future) reputation gating.

The shape mirrors the buyer policy:

```yaml
# ./.steelyard/merchant-policy.yml
version: "0.1"
default: deny

rules:
  - name: "accept tier-1 agent runtimes"
    can: sell
    where:
      agent_identity: ["claude-desktop", "cursor", "vercel-ai-sdk"]
      currency: USD

  - name: "block sanctioned regions"
    cannot: sell
    where:
      buyer_country: ["XX", "YY"]
```

API (planned):

```typescript
import { MerchantPolicy } from "@steelyard/merchant/policy";

const policy = await MerchantPolicy.load();
const decision = policy.evaluate(incoming_purchase);
```

This subpath is **not yet in `package.json#exports`** — it ships when the
implementation is complete (no-stubs rule).
