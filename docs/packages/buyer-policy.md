# Policy (engine)

`@steelyard/buyer/policy` evaluates purchase intents against strict YAML policy.
Wallet users normally do not need this page.

```ts
import { BuyerPolicy } from "@steelyard/buyer/policy";

const policy = await BuyerPolicy.load();
const decision = await policy.evaluate(intent, { vault });
```

## YAML grammar

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

Parsing is strict: duplicate keys, anchors, aliases, tags, and files larger
than 1 MB are rejected. A rule must have exactly one of `can` or `cannot`.
`where.amount` requires `where.currency`.

## Precedence

Policy files overlay in this order:

1. All `cannot` rules from project and global files.
2. Project `can` rules.
3. Global `can` rules.
4. The `default` decision.

A global `cannot` cannot be overridden by a project `can`.

## Matching

`merchant_domain` matches the normalized transport domain: scheme and port are
removed, the value is lowercased, trailing dots are removed, and IDNA/punycode is
normalized. `*` matches one domain segment; `**` matches multiple segments.
Currency is normalized to uppercase ISO 4217. Categories are exact strings.

## Decisions and limits

`Decision` is a closed discriminated union on `status`: `allowed`, `denied`, or
`approval_required`. Spending limits query the vault ledger with
`vault.spendInWindow(window, currency)`. If a policy has non-zero limits and no
vault is supplied, evaluation denies with `spend_limits_require_vault`.

Wallet-owned rules use the reserved `steelyard.wallet.*` namespace. Wallet
setters only update that reserved section and leave hand-written rules alone.
