# Stripe Test-Mode Setup

Steelyard v0.6 is test-mode only for Stripe SPTs. Use an unrestricted
`sk_test_*` secret key. `sk_live_*` is rejected at runtime with
`STRIPE_LIVE_DISABLED_v0_6`.

## 1. Get a Test Secret Key

In the Stripe Dashboard, switch to Test mode and copy the unrestricted secret
key for the account you are using for the coffee-shop smoke.

```sh
export STRIPE_TEST_SECRET_KEY=sk_test_...
```

Do not commit this value, print it in logs, or place it in `.env` files that can
be shared.

## 2. Seller Profile

Stripe's Test API accepts the documented placeholder network business profile
used by the coffee-shop example:

```text
profile_test_61TU90nIeGjU7NNVXA6TU90m7ISQWsBxpcx9lASWWXTk
```

For your own integration, create or select a network business profile in the
Stripe Dashboard and pass it as `sellerProfile` to `createStripeSptIssuer()`.

## 3. Run the Coffee-Shop Smokes

UCP + AP2 + Stripe SPT:

```sh
STRIPE_TEST_SECRET_KEY=sk_test_... \
pnpm --filter @steelyard/example-coffee-shop smoke:stripe:ucp
```

ACP + direct SPT `payment_data`:

```sh
STRIPE_TEST_SECRET_KEY=sk_test_... \
pnpm --filter @steelyard/example-coffee-shop smoke:stripe:acp
```

CI and local offline validation use the same scripts with `STEELYARD_MOCK_STRIPE=1`.
That mode exercises the Steelyard SPT wiring without contacting Stripe.

## Notes

- Keep `STEELYARD_ALLOW_MOCK_PSP` unset for real Stripe smokes.
- UCP uses AP2 mandates and embeds the SPT in the AP2 payment mandate.
- ACP sends the raw SPT in `payment_data.instrument.credential.token`.
- Live Stripe mode is planned for a later release.
