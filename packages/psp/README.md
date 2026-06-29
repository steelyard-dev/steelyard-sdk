# steelyard/psp

Public PSP adapter contract and conformance kit for Steelyard.

Use this package when you are building a payment adapter outside the Steelyard
monorepo. It is intentionally thin: the only runtime dependency is
`steelyard/core`.

## Contract Surface

```ts
import type {
  PspAdapter,
  PspCaptureArgs,
  PspPaymentIntent,
  PspPaymentMandate,
  PaymentMandateIssuer,
  PaymentCapability,
  PaymentMandate,
  PaymentMandateRequest,
  SptHandle,
  PspCaptureResult
} from "steelyard/psp";
```

Merchant adapters implement `PspAdapter`: declare `capabilities`, answer
`supportsHandler(handlerId)`, perform `capture(args)`, and make `cancel(args)`
idempotent. Buyer issuers implement `PaymentMandateIssuer`: declare one
`instrumentType` and mint a scoped `PaymentMandate` for a
`PaymentMandateRequest`.

`PspPaymentIntent`, `PspPaymentMandate`, `PspCaptureArgs`, and `PspAdapter` are
owned by this package. Foundational buyer-side contract types are re-exported
from `steelyard/core` so adapter authors can import the full contract from one
package.

## Conformance

`steelyard/psp/conformance` exports framework-agnostic runners:

```ts
import { runPspConformance, runMandateIssuerConformance } from "steelyard/psp/conformance";

const pspReport = await runPspConformance(adapter, fixtures);
const issuerReport = await runMandateIssuerConformance(issuer, fixtures);

if (pspReport.failed > 0 || issuerReport.failed > 0) {
  throw new Error("adapter conformance failed");
}
```

The runners return structured reports and do not depend on Vitest, Jest,
`node:test`, or Steelyard's internal verify package.

## Stability Policy

The adapter contract follows additive-only semver: your adapter will not break on
a minor release. New minor releases may add optional members or new exported
helpers, but breaking changes to `PspAdapter`, `PspCaptureArgs`, the payment
mandate types, or the issuer contract require a major version.

The wider Steelyard SDK is still pre-1.0 and may make breaking changes on minor
releases. This stability promise is scoped specifically to the
`steelyard/psp` contract surface.

## Trust Model

A PSP adapter handles money and tokens, so installing a third-party adapter is a
trust decision. Steelyard limits what adapters receive:

- The merchant `PspAdapter.capture()` receives scoped `PspCaptureArgs`, not raw
  vault key material.
- Buyer issuers mint through the wallet/vault's scoped signer path.
- Neither the merchant adapter nor the buyer issuer should hold raw vault keys.

Adapters are still privileged code in your checkout path. Review their source,
dependencies, release process, and operational controls before using them in
production.
