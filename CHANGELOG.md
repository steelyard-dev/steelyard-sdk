# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to pre-1.0 semantic versioning (minor bumps may break).

## [Unreleased]

## [0.4.2] - 2026-06-15

### Added
- UCP HTTP Message Signatures per RFC 9421, RFC 9530, and RFC 8941, including request signing, response signing, MCP streamable-HTTP coverage, profile key discovery, and fixed-width ECDSA `r||s` signatures (CO1-CO4, KE1-KE3, DI1-DI3, S1-S4, MC1-MC2).
- Bearer auth alongside HTTP Message Signatures as dual-mechanism UCP auth support (DM1-DM2).
- Buyer-side UCP signing key creation, storage, public export, and opaque signing through the encrypted vault for AP2 holder-key reuse (DM3).
- Buyer signer-profile helpers for publishing public `signing_keys[]` at a platform profile URL (DM4).
- UCP signing error envelope coverage for `{ code, content }` responses (ER1).
- `CHANGELOG.md` and `docs/releases.md` as canonical public release-history surfaces (IN1, IN2).

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
