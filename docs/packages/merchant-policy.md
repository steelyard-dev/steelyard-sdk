# `steelyard/merchant/policy`

Merchant-side checkout policy loader. The YAML shape mirrors
`steelyard/buyer/policy` and is parsed by the shared strict
`steelyard/core/policy-yaml` parser.

```yaml
version: "0.1"
default: deny

rules:
  - name: accept coffee purchases
    can: buy
    where:
      merchant_domain: coffee.example
      currency: USD
      amount:
        lte: 2500
```

```ts
import { MerchantPolicy } from "steelyard/merchant/policy";

const policy = MerchantPolicy.fromPath("/etc/steelyard/merchant-policy.yml");
const decision = await policy.evaluate(intent);
```

`fromPath()` hot-reloads: it stats the file on each `evaluate()` call and
reuses the last valid policy if a concurrent write produces a transient parse
error. If the file is deleted, evaluation throws `MerchantPolicyMissing`.

Pass the policy into checkout assembly:

```ts
const checkout = createCheckoutServer(manifest, {
  protocols: ["acp", "ucp"],
  policy,
  store,
  idempotency,
  psp,
  mandateVerifier
});
```

Denied purchases return HTTP 403. Approval-required decisions return HTTP 409
with the threshold in the response body.
