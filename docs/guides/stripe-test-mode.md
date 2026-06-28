# Stripe Test Mode

Use `stripePsp()` when you want the merchant checkout assembly to capture with
Stripe test-mode credentials instead of the mock PSP. v0.6 rejects `sk_live_*`
at runtime.

```ts
import { stripePsp } from "@steelyard/merchant/psp";

const psp = stripePsp({
  apiKey: process.env.STRIPE_SECRET_KEY! // sk_test_...
});
```

Then pass `psp` into `createCheckoutServer()`.

## Manual smoke script

The coffee-shop example includes a manual script:

```bash
STRIPE_SECRET_KEY=sk_test_... \
pnpm --filter @steelyard/example-coffee-shop smoke:stripe
```

The script is not part of CI and should use Stripe test-mode credentials only.
It exercises the direct `pm_*` PaymentMethod path, not the UCP/ACP SPT flow.

For v0.6 Stripe Shared Payment Token setup and the UCP/ACP coffee-shop smokes,
see [Stripe test-mode setup](stripe-test-mode-setup.md).

## Notes

- Keep `STEELYARD_ALLOW_MOCK_PSP` unset when testing Stripe paths.
- Use stable idempotency keys while retrying the same test purchase.
- Never log raw card numbers or Stripe secret keys.
