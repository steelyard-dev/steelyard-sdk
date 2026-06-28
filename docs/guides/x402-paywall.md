# x402 Paywall

Use `x402Paywall(...)` to protect explicit HTTP routes with x402 payment
requirements.

```ts
import { createServer } from "node:http";
import { exactUsdc, x402Paywall } from "steelyard";

const paywall = x402Paywall({
  facilitator,
  routes: {
    "GET /paid-weather": exactUsdc({
      amount: "0.001",
      network: "eip155:84532",
      payTo: process.env.X402_PAY_TO!,
      description: "Paid weather API response",
      handler: () => ({ condition: "sunny", paid: true })
    })
  }
});

createServer(paywall.handler).listen(3000);
```

The first adapter is intentionally small. Route matching supports exact
`METHOD /path` keys and `*`; mount it where your framework routing already
decides path ownership.

## Facilitator Boundary

Pass either a facilitator URL or an `X402FacilitatorClient`:

```ts
const facilitator = {
  async verify({ paymentPayload, paymentRequirements }) {
    return { valid: true };
  },
  async settle({ paymentPayload, paymentRequirements }) {
    return { success: true, transaction: "0x..." };
  }
};
```

The HTTP client boundary calls `/verify` and `/settle`. Steelyard does not
operate a facilitator and does not hide a production default.

## Settlement And Idempotency

For matched routes:

1. Missing `PAYMENT-SIGNATURE` returns `402` with `PAYMENT-REQUIRED`.
2. Present signatures are verified through the facilitator.
3. Verified payments are settled through the facilitator.
4. The response includes `PAYMENT-RESPONSE`.

`memoryX402IdempotencyStore()` prevents duplicate settlement for the same
signature and route requirement in local demos. Production servers should pass a
durable custom store.

## Offline Example

```sh
pnpm --filter @steelyard/example-x402-weather test
pnpm --filter @steelyard/example-x402-weather build
```
