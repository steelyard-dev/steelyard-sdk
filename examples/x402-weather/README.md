# x402 Weather Example

Offline x402 paid HTTP resource demo.

The server protects `GET /weather` with `x402Paywall(...)` and a mock
facilitator. The client uses `x402Fetch(...)` with a small in-memory wallet-like
object so the whole example runs without live chain access, funded wallets, or
raw private key strings.

```sh
pnpm --filter steelyard-example-x402-weather test
pnpm --filter steelyard-example-x402-weather build
```

In a real buyer app, replace the offline wallet object with `Wallet.open(...)`
and add an `x402Payments(...)` instrument backed by your own signer.
