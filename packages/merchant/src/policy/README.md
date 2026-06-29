# `steelyard/merchant/policy`

Merchant-side checkout policy loader. The YAML shape mirrors
`steelyard/buyer/policy` and is parsed by the shared strict
`steelyard/core/policy-yaml` parser.

```yaml
version: "0.1"
default: deny

rules:
  - name: "accept coffee purchases"
    can: buy
    where:
      merchant_domain: coffee.example
      currency: USD
```

```typescript
import { MerchantPolicy } from "steelyard/merchant/policy";

const policy = MerchantPolicy.fromPath("/etc/steelyard/merchant-policy.yml");
const decision = await policy.evaluate(intent);
```

`fromPath()` stats the file on every `evaluate()` call and reparses when the
mtime changes. If the file is deleted, evaluation throws `MerchantPolicyMissing`.
