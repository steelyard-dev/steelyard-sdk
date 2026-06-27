# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to pre-1.0 semantic versioning (minor bumps may break).

## [Unreleased]

### Added

- `@steelyard/next` adapter package: `toNextHandler`, `toNextApiHandler`,
  `createCommerceRoutes`, `resolveManifestModule`, dev inspector page template.
- `steelyard init` command: interactive scaffolder for Next.js App Router
  apps with Stripe auto-detection, ASCII banner, transactional codegen, and
  per-tier wiring.
- `steelyard enable checkout` command: tier A → B upgrade with Stripe key
  verification.
- `examples/nextjs` demo app: human Stripe Checkout + agent surfaces in one
  Next.js 15 App Router project, generated via the CLI.

### Changed

- `@steelyard/cli` now depends on `prompts`, `ora`, `picocolors`, and `stripe`
  for the init flow.

## [0.10.0] - 2026-06-26

### Added
- New thin `@steelyard/psp` package exposing the public PSP adapter contract, re-exporting buyer-side contract types from `@steelyard/core`, and reserving `@steelyard/psp/conformance` as the adapter conformance entry point (PC1, PC2, PC3, PC4).
- Framework-agnostic conformance runners for merchant PSP adapters and buyer issuers, plus an in-repo dogfood test proving the first-party mock, Stripe, and reference implementations pass the kit (CF1, CF2, CF3, CF4).
- Standalone-shaped `examples/psp-adapter-template/` package showing a third-party adapter, issuer, and conformance test with only `@steelyard/psp` as a runtime dependency (TPL1).
- Public adapter-authoring documentation and `@steelyard/psp` README covering the contract surface, conformance kit, trust model, discoverability convention, and scoped stability policy (TPL2, TPL3, IN2).

### Changed
- Moved the protocol-neutral merchant PSP interfaces out of `@steelyard/merchant` and into `@steelyard/psp`, while preserving `@steelyard/merchant/psp` compatibility re-exports and leaving Stripe/reference/mock adapter behavior unchanged (RW1, RW2, RW3, RW4).

## [0.9.0] - 2026-06-26

### Added
- New `steelyard` umbrella package: one install (`npm install steelyard`) and one import expose the ~15 symbols most integrators need — `defineCommerce`, the per-protocol handlers, `createMerchantCheckout`, `stripePsp`/`referencePsp`, `createStripeSptIssuer`/`createReferencePaymentIssuer`, `Wallet`, and `Steelyard`/`connect` (UP1, UP2, UP3, UP4).
- `serveCommerce(manifest)` / `createCommerceHandler(manifest)`: serve a commerce manifest over all five read surfaces (`commerce.json`, `/commerce` HTTP API, `/mcp`, `/acp/feed`, `/.well-known/ucp` + `/api/catalog/*`) from one call, read-only by default with no PSP required, composing the existing protocol handlers behind one path router (SV1, SV2, SV3).
- Build-your-own quickstart: README and `docs/getting-started.md` now lead with `npm install steelyard` + an eight-line define-and-serve example reaching a live multi-protocol endpoint in under two minutes; the clone-the-demo path is kept as a secondary section (QS1, QS2, QS3).

### Changed
- The existing `@steelyard/*` packages, exports, and import paths are unchanged; the umbrella is purely additive (BC1, BC2, BC3).

## [0.8.0] - 2026-06-26

### Changed
- Extracted AP2 mandate and UCP HTTP Message Signature algorithms into `@steelyard/ucp-signing`, while preserving existing buyer, merchant, and protocol import paths through compatibility re-exports and adapters (US1, US2, US3, US4, US5, KS1, KS2, BD1, BD2).
- Deduplicated `PspCaptureResult` into `@steelyard/core` and re-exported it from the merchant, UCP, and ACP surfaces so PSP result shape has one canonical definition (DD1, DD2, DD3).
- Kept checkout behavior unchanged: AP2 remains opt-in through capability negotiation, the vault still owns UCP signing keys, and the legacy `net.steelyard.checkout_mandate.v0_1` mandate mode is retained (KS3, MM1, MM2, MM3).

## [0.7.0] - 2026-06-26

### Added
- UCP PSP capability declarations now drive `ucp.payment_handlers["net.steelyard"]`, so merchants can advertise payment handlers without hard-coding Stripe-specific UCP discovery fields (NC1, MV2, AD3).
- Added a guarded reference UCP payment rail: `referencePsp()` and `createReferencePaymentIssuer()` use `delegated_payment_token` / `dpt_` handles with signed, merchant- and transaction-bound scope verification before capture (RP1, RP2, RP3).
- Coffee-shop now has a dual UCP smoke that runs the same catalog through Stripe-backed and reference-backed checkout-server configs and compares receipt shape and order outcome (EX1).
- Added public payment-adapter documentation covering UCP-neutral adapters, Stripe SPT, the reference PSP, and ACP's current Stripe-only boundary (IN3).

### Changed
- Buyer, merchant, protocol, and docs code now use neutral payment capability and instrument vocabulary for UCP paths instead of assuming `shared_payment_token` everywhere (NC1, MV2, MV4).
- Stripe SPT capture failures are normalized to neutral PSP reasons while retaining vendor-specific detail codes for diagnostics (NC3).
- UCP buyer negotiation now requires advertised `available_instruments`; merchants that omit UCP instrument advertisement no longer match Stripe by default and now surface `NoCompatiblePaymentHandlerError` (BN2).
- UCP and AP2 selected payment instruments now use the issuer's `instrumentType`, including non-SPT issuers, instead of hard-coded `shared_payment_token` values (BN3).
- ACP checkout remains intentionally limited to direct Stripe SPT payment data and now rejects non-`shared_payment_token` wallet issuers before minting (AG1).

### Fixed
- `pnpm verify` and `pnpm validate-examples` now cover v0.7 adapter-neutral UCP discovery, handler negotiation, reference-token verification, ACP guard behavior, and dual-adapter coffee-shop smoke coverage (IN5, EX1).

## [0.6.0] - 2026-06-16

### Added
- Stripe Shared Payment Token primitives for test-mode minting and charging, including preview API-version pinning, live-key refusal, SPT error normalization, and shared constants (SP1, SP2, SP3, SP4, SC3).
- Buyer-side Stripe SPT issuer that scopes SPT minting to AP2 payment mandate drafts, refuses incomplete or widened scopes, and keeps Stripe keys in process memory only (SI1, SI2, SI3, SI4).
- Merchant Stripe PSP support for `spt_*` tokens behind `acceptSharedPaymentTokens`, while preserving the existing `pm_*` PaymentMethod path (SC1, SC2, SC4).
- UCP `ucp.payment_handlers["net.steelyard"]` Stripe advertisement, buyer handler discovery, compatible-handler selection, and AP2 handler binding (UH1, UH2, UH3, UH4).
- ACP checkout discovery, REST checkout-session routes, direct SPT `payment_data` completion, bearer auth, webhook HMAC helpers, and ACP-shaped error handling (AC1, AC2, AC3, AC4, AC5, AC6, AB1, AB2, AB3, AB4, AB5, AP5).
- Coffee-shop UCP+Stripe and ACP+Stripe smokes, offline mock Stripe validation, and vanilla ACP buyer interop coverage (EX1, EX2, EX4, EX5).
- Public docs for agentic payment, Stripe SPT errors, Stripe Test mode setup, and UCP payment handlers (IN3, IN4, IN5, IN6).

### Changed
- UCP AP2 payment mandates now embed Stripe SPTs in the existing `payment_instrument` claim without replacing the AP2 credential token slot (AP1, AP2, AP3, AP4).
- Buyer receipts can carry PSP PaymentIntent and charge references for UCP completions when the merchant checkout response includes open `payment_details` metadata (EX1).
- ACP and buyer code now imports ACP wire types from generated OpenAPI output, and UCP code adopts upstream SDK types only where they match the vendored schema (CP4, CP5).
- README and release notes describe v0.6 as the MCP/UCP/ACP SDK surface plus Stripe SPT adapter wiring; real Stripe payment validation remains opt-in and requires account-level business-profile/SPT access (IN1, IN2, IN7).

### Fixed
- `pnpm verify` now includes explicit v0.6 Stripe SPT conformance cases for primitives, issuer scope binding, PSP discrimination, UCP handler selection, ACP request shapes, and coffee-shop interop (IN8).
- `pnpm validate-examples` now exercises coffee-shop Stripe SPT UCP and ACP smokes in offline mock mode (EX4, IN9).

## [0.5.0] - 2026-06-15

### Added
- UCP AP2 mandate compliance with SD-JWT+KB checkout mandates, detached JWS merchant authorization, AP2 payment mandates, and AP2 envelope validation (CO5, MA5, BV5, SD5, VE5, PM5, SC5).
- AP2 capability advertisement for merchant and buyer UCP profiles using `dev.ucp.shopping.ap2_mandate` (DI5-4, DI5-5).
- Digital Payment Credential trust-model hooks for AP2 mandate verification, with OpenID4VP issuer integration left to deployments or a future release (TR5).
- Single-use AP2 nonce stores and merchant-issued checkout/payment nonces for replay protection (NO5).
- Coffee-shop AP2 smoke coverage and AP2 conformance cases in the verify harness, with a documented third-party fixture gap (IN5-2, IN5-5).

### Changed
- UCP buyer and merchant checkout paths session-lock into AP2 when both profiles advertise AP2, and reject Steelyard-mode fallback inside locked sessions (DI5-1, DI5-2, DI5-3).
- New wallet creation now provisions the ES256 UCP signing key used as the AP2 holder key when default mandate setup is enabled (KE5-1).
- PSP capture paths verify AP2 payment mandates before accepting payment mandate capture data (PM5-3).

### Deprecated
- `net.steelyard.checkout_mandate.v0_1` legacy Steelyard mandate mode for AP2-capable partners. v0.5 keeps it only for pre-AP2 sessions; later releases will remove it.

## [0.4.2] - 2026-06-15

### Added
- UCP HTTP Message Signatures per RFC 9421, RFC 9530, and RFC 8941, including request signing, response signing, MCP streamable-HTTP coverage, profile key discovery, and fixed-width ECDSA `r||s` signatures (CO1-CO4, KE1-KE3, DI1-DI3, S1-S4, MC1-MC2).
- Bearer auth alongside HTTP Message Signatures as dual-mechanism UCP auth support (DM1-DM2).
- Buyer-side UCP signing key creation, storage, public export, and opaque signing through the encrypted vault for AP2 holder-key reuse (DM3).
- Buyer signer-profile helpers for publishing public `signing_keys[]` at a platform profile URL (DM4).
- UCP signing error envelope coverage for `{ code, content }` responses (ER1).
- `CHANGELOG.md` and `docs/releases.md` as canonical public release-history surfaces (IN1, IN2).
- Public operator docs for UCP HTTP Message Signatures, dual auth, key rotation, and buyer HMS profiles (IN5).

### Changed
- `buildUcpDiscovery()` publishes public-only top-level `signing_keys[]` when merchant HMS auth is enabled (KE3).
- UCP checkout requests can be signed with `UCP-Agent`, `Signature-Input`, `Signature`, and `Content-Digest`, or sent with bearer auth when selected (DM1-DM2).

### Fixed
- Closed the UCP interop audit finding where Steelyard requests were unsigned and compliant UCP partners would reject them (S1-S2, DM1-DM2).
- Ensured private EC JWK `d` material is never published in UCP profile surfaces (CO3, KE3, DM4).

## [0.4.1] - 2026-06-15

### Fixed
- UCP capability map uses canonical full-key form (CK1, CK4).
- Backward-compat sniffing supports v0.3/v0.4 short-id-under-bucket capability profiles via an explicit alias table (CK2, CK4).
- Schema-valid Steelyard mandate capability key restored for UCP discovery (NF1).
- Base UCP completion no longer requires Steelyard mandate support (BU1, BU2).
- MCP `serverInfo.capabilities` no longer emits a nonstandard capability object (MC1).

### Changed
- Renamed UCP discovery constants to the canonical full-key form while preserving legacy sniffing behavior (CK2).

## [0.4.0] - 2026-06-14

### Added
- `/.well-known/commerce.json` well-known endpoint for the commerce manifest (WK1-WK5).
- Pure HTTP API under `/commerce` for manifest, offer, policy, and health surfaces (HT1-HT5).
- `steelyard` CLI commands: `validate`, `manifest`, and `doctor` (CL1-CL5).
- `@steelyard/core` commerce-manifest helpers, validation, canonical hashing, and public types (CO1-CO4).
- Authored JSON Schemas for the commerce manifest and HTTP API under `packages/core/spec/` (AS1, AS2).

## [0.3.0] - 2026-06-14

### Added
- ACP and UCP buyer checkout drivers with `Wallet.pay()` policy, vault, reservation, and receipt enforcement (W1-W7, B1-B7, M1-M9).
- Encrypted vault ledger with reservations and receipt persistence.
- Steelyard-mode UCP checkout mandates for pre-AP2 interop.
- Stripe PSP adapter and mock PSP guards for checkout testing.
- Verification harness under `packages/verify/` for protocol, lifecycle, security, and compatibility checks.

## [0.2.0] - 2026-06-14

### Added
- Local-first `Wallet` facade with `create`, `open`, `isAllowed`, `decide`, and advisory `pay` primitives.
- YAML buyer policy engine with deny-by-default rules, domain globs, explicit currencies, and project/global overlays.
- Encrypted local card vault with OS keychain storage and password-derived fallback for headless Linux and CI.
- Three-lane CI matrix for macOS keychain, Ubuntu keychain, and Ubuntu password-derived vault operation.

## [0.1.0] - 2026-06-14

### Added
- Initial read-only multi-protocol SDK for MCP, ACP, and UCP exposure.
- `defineCommerce()` manifest API and schema validation.
- Buyer client auto-detection across MCP, ACP, and UCP read surfaces.
- Coffee-shop example and early agent CLI surface.
