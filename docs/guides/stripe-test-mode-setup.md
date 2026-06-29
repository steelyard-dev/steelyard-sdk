# Stripe Test-Mode Setup

Steelyard v0.6 is test-mode only for Stripe SPTs. Use an unrestricted
`sk_test_*` secret key. `sk_live_*` is rejected at runtime with
`STRIPE_LIVE_DISABLED_v0_6`.

The release validates the UCP and ACP SPT wiring with offline mock Stripe
smokes. Running the same smokes against `api.stripe.com` is opt-in and requires
the Stripe account behind the key to have business-profile/SPT access.

## 1. Get a Test Secret Key

In the Stripe Dashboard, switch to Test mode and copy the unrestricted secret
key for the account you are using for the coffee-shop smoke.

```sh
export STRIPE_TEST_SECRET_KEY=sk_test_...
```

Do not commit this value, print it in logs, or place it in `.env` files that can
be shared.

## 2. Seller Profile

The coffee-shop example defaults to the documented placeholder network business
profile:

```text
profile_test_61TU90nIeGjU7NNVXA6TU90m7ISQWsBxpcx9lASWWXTk
```

For your own integration, create or select a network business profile in the
Stripe Dashboard and pass it as `sellerProfile` to `createStripeSptPaymentMandateIssuer()`.
If Stripe returns `Stripe business profile not found`, the key is valid but the
account is not enabled for the SPT business-profile flow; use
`STEELYARD_MOCK_STRIPE=1` for SDK validation until Stripe enables that access.

## 3. Run the Coffee-Shop Smokes

UCP + AP2 + Stripe SPT:

```sh
STRIPE_TEST_SECRET_KEY=sk_test_... \
pnpm --filter steelyard-example-coffee-shop smoke:stripe:ucp
```

ACP + direct SPT `payment_data`:

```sh
STRIPE_TEST_SECRET_KEY=sk_test_... \
pnpm --filter steelyard-example-coffee-shop smoke:stripe:acp
```

CI and local offline validation use the same scripts with `STEELYARD_MOCK_STRIPE=1`.
That mode exercises the Steelyard SPT wiring without contacting Stripe and is
the v0.6 release gate.

## Notes

- Keep `STEELYARD_ALLOW_MOCK_PSP` unset for real Stripe smokes.
- UCP uses AP2 mandates and embeds the SPT in the AP2 payment mandate.
- ACP sends the raw SPT in `payment_data.instrument.credential.token`.
- Live Stripe mode is planned for a later release.
