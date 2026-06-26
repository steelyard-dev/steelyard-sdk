# Payment Adapters

Steelyard v0.10 makes PSP adapters a public contract. External authors should
build against `@steelyard/psp`, not `@steelyard/merchant` internals.

```sh
npm install @steelyard/psp
```

```ts
import type { PspAdapter, WalletPaymentIssuer } from "@steelyard/psp";
import { runPspConformance, runIssuerConformance } from "@steelyard/psp/conformance";
```

## Adapter Shape

A merchant PSP adapter implements `PspAdapter`:

```ts
export const myPsp: PspAdapter = {
  name: "my-psp",
  capabilities: [{
    handlerId: "my-psp",
    instrumentType: "my_payment_token",
    idPrefix: "my_"
  }],
  supportsHandler: (handlerId) => handlerId === "my-psp",
  async capture(args) {
    // Verify args.vault_token or args.payment_mandate, then capture with your PSP.
    return { ok: true, psp_payment_id: "psp_123", status: "captured" };
  },
  async cancel(args) {
    // Make cancellation idempotent for args.idempotencyKey.
  }
};
```

The buyer side implements `WalletPaymentIssuer`: declare one `instrumentType`
and mint a scoped handle from `PaymentIssuerMandateDraft`. The issuer's
`instrumentType` must match one of the merchant adapter's advertised
`capabilities[].instrumentType` values.

`@steelyard/psp` owns the merchant-side contract types
`PspAdapter`, `PspCaptureArgs`, `PspPaymentMandate`, and `PspPaymentIntent`. It
also re-exports the buyer-side contract types from `@steelyard/core`, so adapter
authors can import the full contract from one package.

## Run Conformance

The conformance kit has no test-framework dependency. Use it from Vitest, Jest,
`node:test`, or a CI script:

```ts
const pspReport = await runPspConformance(myPsp, fixtures);
if (pspReport.failed > 0) throw new Error(JSON.stringify(pspReport.cases, null, 2));

const issuerReport = await runIssuerConformance(myIssuer, fixtures);
if (issuerReport.failed > 0) throw new Error(JSON.stringify(issuerReport.cases, null, 2));
```

`runPspConformance()` checks capability declarations, `supportsHandler`,
successful capture shape, capture idempotency, cancel idempotency, optional
failure fixtures, and optional mandate/instrument mismatch fixtures. It does not
construct AP2 SD-JWT mandates; if your adapter supports AP2 mandate capture,
provide a sample mandate in the fixtures.

`runIssuerConformance()` checks that `instrumentType` is declared, minted handles
do not widen amount/currency/expiry scope, and incomplete mandate drafts are
rejected.

See `examples/psp-adapter-template/` for a standalone-shaped adapter package
with a conformance test.

## Trust Model

A PSP adapter handles money and tokens, so installing a third-party adapter is a
trust decision. Review the package source, maintainers, dependency tree,
publishing controls, and operational posture before using it in production.

Steelyard limits the blast radius:

- The merchant `PspAdapter.capture()` receives scoped `PspCaptureArgs`, not raw
  vault key material.
- The buyer issuer mints through the wallet/vault's scoped signer path.
- Neither the merchant adapter nor the buyer issuer should receive or persist
  raw vault keys.

That boundary limits what an adapter can access, but it does not make arbitrary
adapter code safe. Treat adapters like payment infrastructure.

## Stability Policy

The `@steelyard/psp` adapter contract follows additive-only semver: your adapter
will not break on a minor release. New minor releases may add optional members or
helpers, but breaking interface changes to `PspAdapter`, `PspCaptureArgs`, the
payment mandate types, or the issuer contract require a major bump.

The wider Steelyard SDK remains pre-1.0. Minor releases can still change other
SDK surfaces; this stability promise is scoped to the public PSP contract.

## Discoverability

Third-party adapters should use:

- npm package name prefix: `steelyard-psp-*`
- npm keyword: `steelyard-psp`

Known adapters:

- `@steelyard/merchant/psp` Stripe and reference adapters: first-party,
  in-repo reference implementations.
- `examples/psp-adapter-template`: standalone-shaped starter for external
  authors.

## Current Boundaries

UCP is the adapter-neutral checkout path: it drives **UCP payment negotiation**,
where merchants advertise payment capabilities and buyers match a wallet issuer by
`instrumentType`. New PSP integrations start with a UCP capability declaration, a
buyer issuer with a distinct `instrumentType`, and a merchant adapter that verifies
the handle before capture. The in-repo `referencePsp()` and
`createReferencePaymentIssuer()` are the canonical example of a non-Stripe adapter on
this path.

ACP checkout is intentionally narrower. The ACP driver accepts only a
`shared_payment_token` issuer and sends direct Stripe-style SPT `payment_data`.
Using a non-SPT issuer fails before minting.

AP2 mandate issuance and verification, AP2 envelope checks, merchant
authorization signing, AP2 payment-mandate verification, and UCP HTTP Message
Signature operations live in `@steelyard/ucp-signing`. Applications normally
reach those through the buyer, merchant, and protocol package exports.
