# Steelyard Coffee Example

This package hosts the local coffee-shop merchant used by Steelyard integration
tests and smoke scripts.

The UCP HTTP Message Signature keys in `src/demo-ucp-keys.ts` are demo-only
plaintext fixtures. Do not copy them into production services. Real merchants
and buyer platforms should keep private key material in environment-managed
secrets, a vault, or an HSM-backed signer, and publish only public JWK fields in
UCP profiles.

Useful checks:

```sh
STEELYARD_ALLOW_MOCK_PSP=1 pnpm --filter @steelyard/example-coffee-shop buy:real -- --protocol ucp
STEELYARD_ALLOW_MOCK_PSP=1 pnpm --filter @steelyard/example-coffee-shop smoke:bearer
STEELYARD_ALLOW_MOCK_PSP=1 pnpm --filter @steelyard/example-coffee-shop smoke:vanilla-ucp
```

## Stripe SPT Smokes

v0.6 adds end-to-end Stripe Shared Payment Token smokes for both protocol
surfaces. These use Stripe Test mode only. Do not use `sk_live_*`; the runtime
rejects live keys in this release.

Get an unrestricted Test mode secret key from the Stripe Dashboard, then run:

```sh
STRIPE_TEST_SECRET_KEY=sk_test_... \
pnpm --filter @steelyard/example-coffee-shop smoke:stripe:ucp

STRIPE_TEST_SECRET_KEY=sk_test_... \
pnpm --filter @steelyard/example-coffee-shop smoke:stripe:acp
```

The UCP smoke signs AP2 mandates, mints an SPT scoped to the checkout, embeds
that SPT in the AP2 payment mandate, and charges through Stripe Test API. The
ACP smoke discovers `/.well-known/acp.json`, creates a checkout session, skips
`delegate_payment`, completes with direct SPT `payment_data`, and verifies the
ACP webhook signature helper.

For offline validation and CI:

```sh
STEELYARD_MOCK_STRIPE=1 STRIPE_TEST_SECRET_KEY=sk_test_mock \
pnpm --filter @steelyard/example-coffee-shop smoke:stripe:ucp

STEELYARD_MOCK_STRIPE=1 STRIPE_TEST_SECRET_KEY=sk_test_mock \
pnpm --filter @steelyard/example-coffee-shop smoke:stripe:acp
```

The default Test mode seller profile is:

```text
profile_test_61TU90nIeGjU7NNVXA6TU90m7ISQWsBxpcx9lASWWXTk
```

Use your own Stripe network business profile by passing `sellerProfile` to
`createStripeSptIssuer()` in a custom harness.
