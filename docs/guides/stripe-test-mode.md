# Stripe Test Mode

Use `stripePsp()` when you want the merchant checkout assembly to capture with
Stripe instead of the mock PSP.

```ts
import { stripePsp } from "@steelyard/merchant/psp";

const psp = stripePsp({
  apiKey: process.env.STRIPE_SECRET_KEY!
});
```

Then pass `psp` into `createMerchantCheckout()`.

## Manual smoke script

The coffee-shop example includes a manual script:

```bash
STRIPE_SECRET_KEY=sk_test_... \
pnpm --filter @steelyard/example-coffee-shop smoke:stripe
```

The script is not part of CI and should use Stripe test-mode credentials only.

## Notes

- Keep `STEELYARD_ALLOW_MOCK_PSP` unset when testing Stripe paths.
- Use stable idempotency keys while retrying the same test purchase.
- Never log raw card numbers or Stripe secret keys.
