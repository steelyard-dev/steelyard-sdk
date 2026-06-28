# `@steelyard/x402`

x402 paid HTTP resource support for Steelyard.

```sh
npm install @steelyard/x402
```

Buyer:

```ts
import { x402Fetch, x402Payments } from "@steelyard/x402";

await wallet.addInstrument(x402Payments({
  signer,
  networks: ["eip155:84532"],
  assets: ["USDC"],
  schemes: ["exact"]
}));

const fetchPaid = x402Fetch(wallet, {
  maxAmount: { amount: "0.10", currency: "USDC" }
});

const response = await fetchPaid("https://api.example.com/paid-weather");
console.log(response.x402?.receipt.transaction);
```

Server:

```ts
import { exactUsdc, x402Paywall } from "@steelyard/x402/server";

const paywall = x402Paywall({
  facilitator,
  routes: {
    "GET /paid-weather": exactUsdc({
      amount: "0.001",
      network: "eip155:84532",
      payTo,
      description: "Paid weather API response"
    })
  }
});
```

Use x402 for paid HTTP resources. Use ACP/UCP checkout for commerce checkout.
Wallet policy runs before x402 signing, signer adapters are bring-your-own, and
public examples never accept raw private key strings.

`x402Exact(...)` is available as an advanced protocol-specific helper for the
x402 `exact` scheme. Prefer `x402Payments({ schemes: ["exact"] })` in first-run
application code.
