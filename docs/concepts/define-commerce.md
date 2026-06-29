# `defineCommerce(config)`

The single source of truth for everything Steelyard emits. Pass it into each
protocol adapter; the same `Manifest` powers all of them.

## Shape

```typescript
import { defineCommerce } from "steelyard/core";

const manifest = defineCommerce({
  identity: {
    name: "Acme Coffee",                              // required
    domain: "acme.example",                           // optional
    currencies: ["usd"]                               // optional; default ["USD"]
  },
  offers: [
    {
      id: "double",                                   // required, unique
      title: "Double Espresso",                       // required
      description: "Two shots.",                      // optional
      images: ["https://acme.example/double.png"],    // optional
      url: "https://acme.example/double",             // optional
      categories: ["espresso"],                       // optional
      availability: "in_stock",                       // required
      pricing: [
        { kind: "one_time", amount: 450, currency: "usd" }
      ]                                               // required, ≥1
    }
  ],
  policies: [
    { type: "returns", summary: "Prepared drinks are final." }
  ]                                                   // required, ≥1
});
```

`defineCommerce` parses the config through a Zod schema, fills in defaults,
and returns a normalized `Manifest`. Invalid input throws a `ZodError`.

## `Offer`

```typescript
interface Offer {
  id: string;                                         // unique within the manifest
  title: string;
  description?: string;
  images: string[];                                   // default []
  url?: string;
  categories: string[];                               // default []
  availability: "in_stock" | "preorder" | "out_of_stock" | "discontinued";
  pricing: Price[];                                   // ≥1 entry
  attributes?: Record<string, string | number | boolean>;
}
```

## `Price`

```typescript
type Price =
  | { kind: "one_time"; amount: number; currency: string }  // amount in minor units
  | { kind: "recurring"; amount: number; currency: string; interval: "day" | "week" | "month" | "year"; intervalCount?: number }
  | { kind: "contact_sales" };                              // explicit "ask us"
```

Amounts are always in **minor units** (cents, pence, etc.) per the ACP and
UCP conventions. Currencies are 3-letter ISO codes; Steelyard normalizes to
uppercase on emit.

## `Policy`

```typescript
type PolicyType = "shipping" | "returns" | "refunds" | "terms" | "privacy" | "other";

interface Policy {
  type: PolicyType;
  url?: string;
  summary: string;
}
```

At least one policy is required so the merchant surface always carries the
buyer's expectation around fulfillment.

## Validation

If you want to validate a config without throwing, use `validate()`:

```typescript
import { validate } from "steelyard/core";

const result = validate(rawInput);
if (!result.valid) {
  console.error(result.errors);   // ZodIssue[]
}
```

`defineCommerce` throws on invalid input; `validate` returns a structured
result.

## What's next

- :material-protocol: How [MCP](../protocols/mcp.md), [ACP](../protocols/acp.md),
  and [UCP](../protocols/ucp.md) map this config onto their respective wire
  shapes.
- :material-alert-circle: [Error taxonomy](errors.md) — what your buyer SDK
  sees when something fails.
