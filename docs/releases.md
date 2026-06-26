# Release History

## 0.8.0 - 2026-06-26

Steelyard v0.8 is a behavior-preserving navigation cleanup. The AP2 mandate and
UCP HTTP Message Signature algorithms now live in the optional
`@steelyard/ucp-signing` package, with the existing buyer, merchant, and
protocol import paths preserved through compatibility re-exports and adapters.
The wallet vault remains the UCP signing-key custodian; `ucp-signing` operates
through the public `UcpSigner` seam and does not take ownership of private key
storage.

The release also collapses the duplicate PSP capture-result unions into one
canonical `PspCaptureResult` exported by `@steelyard/core`. AP2 remains opt-in
through UCP capability negotiation, the legacy
`net.steelyard.checkout_mandate.v0_1` mandate mode is retained, and the refactor
does not change protocol or checkout behavior.

## 0.7.0 - 2026-06-26

Steelyard v0.7 generalizes UCP payment wiring beyond Stripe-specific Shared
Payment Tokens. Merchant PSP adapters now declare neutral payment capabilities,
UCP discovery derives `payment_handlers` from those capabilities, and the buyer
matches wallet issuers to advertised `available_instruments` instead of falling
back to implicit Stripe behavior. Stripe remains supported through
`shared_payment_token`, but UCP can now complete with another issuer-defined
instrument type.

The release adds a guarded reference PSP and buyer issuer for local interop and
demo validation. The reference path signs `delegated_payment_token` handles and
verifies merchant, checkout, transaction, amount, currency, handler, instrument,
signature, and expiry before capture. Coffee-shop validation now runs the same
catalog through Stripe-backed and reference-backed UCP checkout configs and
compares receipt shape and order outcome.

ACP is unchanged in scope: it remains intentionally direct Stripe SPT-only in
v0.7 and rejects non-`shared_payment_token` wallet issuers before minting. The
new docs describe the adapter boundary, the reference PSP guard rails, neutral
Stripe error mapping, and the UCP/ACP split.

## 0.6.0 - 2026-06-16

Steelyard v0.6 completes the SDK surface for exposing one commerce definition
through MCP, UCP, and ACP, then wires UCP and ACP checkout to the same Stripe SPT
adapter path. Buyers can prepare Stripe Shared Payment Tokens in Test mode, bind
those tokens to AP2 payment mandates on UCP, and send direct SPT
`payment_data` on ACP. Merchants now advertise Stripe through the UCP
`ucp.payment_handlers["net.steelyard"]` registry, and buyers select compatible
handlers before checkout completion.

The release also ships the minimum ACP checkout surface: discovery at
`/.well-known/acp.json`, checkout-session create/update/complete/cancel routes,
bearer auth, direct SPT `payment_data`, and `Merchant-Signature` webhook
verification helpers. ACP does not use AP2 in v0.6; its trust boundary is bearer
auth plus webhook HMAC, while UCP keeps AP2 as the signed user-consent artifact.

Coffee-shop now has UCP+Stripe and ACP+Stripe smoke scripts validated in offline
mock Stripe mode by `pnpm validate-examples`. The same scripts can be pointed at
Stripe Test API with `STRIPE_TEST_SECRET_KEY`, but real Stripe SPT minting and
PaymentIntent capture require account-level business-profile/SPT access and are
not certified by this release. The docs now cover the v0.6 payment flow, Stripe
SPT error mapping, UCP payment handlers, and Test mode setup.

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
