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
