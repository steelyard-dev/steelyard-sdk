# Release History

## 0.6.0 - 2026-06-16

Steelyard v0.6 makes agentic payment real across both UCP and ACP. Buyers can
mint Stripe Shared Payment Tokens in Test mode, bind those tokens to AP2 payment
mandates on UCP, and complete checkout through a Steelyard merchant that charges
the SPT via Stripe. Merchants now advertise Stripe through the UCP
`ucp.payment_handlers["net.steelyard"]` registry, and buyers select compatible
handlers before checkout completion.

The release also ships the minimum ACP checkout surface: discovery at
`/.well-known/acp.json`, checkout-session create/update/complete/cancel routes,
bearer auth, direct SPT `payment_data`, and `Merchant-Signature` webhook
verification helpers. ACP does not use AP2 in v0.6; its trust boundary is bearer
auth plus webhook HMAC, while UCP keeps AP2 as the signed user-consent artifact.

Coffee-shop now has UCP+Stripe and ACP+Stripe smoke scripts that run against
Stripe Test API when `STRIPE_TEST_SECRET_KEY` is set, plus offline mock Stripe
mode for `pnpm validate-examples`. The docs now cover the v0.6 payment loop,
Stripe SPT error mapping, UCP payment handlers, and Test mode setup.

## 0.5.0 - 2026-06-15

Steelyard v0.5 closes the UCP AP2 mandate compliance gap. AP2-capable UCP
sessions now lock on the `dev.ucp.shopping.ap2_mandate` capability
intersection, return merchant-signed `ap2.merchant_authorization`, require
buyer SD-JWT+KB `ap2.checkout_mandate` on completion, and carry AP2 payment
mandates through the selected payment credential token. Merchant verification
checks issuer trust, holder-key binding, nonce replay, checkout terms, merchant
authorization, and PSP payment-mandate claims before capture.

The release uses the Digital Payment Credential trust model selected for v0.5:
deployments provide the trusted issuer resolver, while the local wallet reuses
its encrypted-vault UCP signing key as the AP2 holder key. Legacy
`net.steelyard.checkout_mandate.v0_1` remains available only for pre-AP2
partners, and the docs now include AP2 mandate, payment mandate, trust model,
and Steelyard-mode migration guidance.

## 0.4.2 - 2026-06-15

Steelyard v0.4.2 closes the UCP HTTP Message Signatures audit finding. UCP requests can now be signed with RFC 9421 `Signature-Input` and `Signature` headers, RFC 9530 `Content-Digest`, public `signing_keys[]` discovery, bounded profile fetching, and raw fixed-width ECDSA signatures. The release also adds dual UCP auth dispatch so merchants can accept both HTTP Message Signatures and bearer tokens, with UCP signing failures returned as `{ code, content }` envelopes.

The buyer side gains an encrypted-vault UCP signing key that will be reused as the AP2 holder key, plus helpers for publishing a public buyer signer profile. That prepares the next AP2 release without changing the ACP path or the existing checkout state machine.

Operator documentation now covers UCP HTTP Message Signatures, HMS versus bearer selection, key rotation, and buyer signer-profile hosting.

## 0.4.1 - 2026-06-15

Steelyard v0.4.1 is a UCP discovery compatibility hotfix. It restores canonical full-key capability advertising while keeping explicit sniffing support for legacy v0.3/v0.4 bucketed capability profiles. It also fixes base UCP completion so vanilla UCP partners can complete checkout without the Steelyard-mode mandate extension.

This patch keeps the v0.4 commerce-manifest and HTTP surfaces intact. For the previous migration notes, see [Migrating from v0.4](guides/migrating-from-v0.4.md).

## 0.4.0 - 2026-06-14

Steelyard v0.4.0 adds the public commerce-manifest surface: `/.well-known/commerce.json`, a pure `/commerce` HTTP API, authored schemas, canonical manifest hashing, and the `steelyard` CLI commands for validation, manifest inspection, and diagnostics. These surfaces let merchants define commerce once and expose it consistently across protocol and plain HTTP consumers.

The release keeps checkout behavior compatible with v0.3 while making the public read/validation story easier to operate. Migration guidance is available in [Migrating from v0.4](guides/migrating-from-v0.4.md).

## 0.3.0 - 2026-06-14

Steelyard v0.3.0 turns the buyer wallet from advisory primitives into an enforced purchase flow. `Wallet.pay()` now coordinates policy decisions, encrypted vault cards, reservations, mandate signing, merchant checkout drivers, PSP capture, and receipt persistence across ACP and UCP.

The release also introduces merchant checkout assembly pieces: stores, policy loading, PSP adapters, mandate verification, and cross-protocol parity tests. It remains compatible with the local-first wallet model introduced in v0.2.

## 0.2.0 - 2026-06-14

Steelyard v0.2.0 introduces the local-first wallet and YAML policy engine for autonomous agent buying. The root `Wallet` facade exposes setup/open, policy decisions, advisory payment preparation, card management, recovery, and password rotation while keeping card material encrypted locally.

The vault stores its master key in the OS keychain when available and falls back to password-derived encryption for containers and headless Linux. The release added a three-lane CI matrix covering macOS keychain, Ubuntu keychain, and Ubuntu password-derived operation. See [Migrating from v0.2](guides/migrating-from-v0.2.md) for upgrade notes.

## 0.1.0 - 2026-06-14

Steelyard v0.1.0 is the initial read-only SDK release. It includes schema-backed commerce definitions, MCP server emission, ACP feed support, UCP discovery and catalog support, buyer-client auto-detection across those read surfaces, and the coffee-shop example.

This release deliberately excludes carts, checkout, and payment execution. Those capabilities arrive in later releases as the wallet, policy, and checkout layers are added.
