# Approval And 3DS

Steelyard separates buyer policy approval from payment authentication.

Buyer policy approval happens before checkout. A wallet can require approval
above a threshold:

```ts
await wallet.setApprovalAbove({ USD: 25 });
```

If a purchase crosses that threshold, `wallet.purchase()` throws
`WalletApprovalRequired` unless the caller supplies an approval proof or resume
token.

Payment authentication happens after the PSP attempts capture. A PSP adapter
can return `requires_authentication` with a `continue_url`. The wallet releases
or escalates the reservation depending on whether the error is resumable.

## Current scope

v0.3 models the states and reservation behavior needed for approval and 3DS,
but it does not provide a hosted challenge UI. Integrators own the user
experience for collecting approvals and resuming escalated purchases.
