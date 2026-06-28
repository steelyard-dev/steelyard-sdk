# x402 Paid Fetch

Use `x402Fetch(...)` when a buyer wallet needs to call an x402-protected HTTP
resource.

```ts
import { Wallet, x402Fetch, x402Payments } from "steelyard";

const wallet = await Wallet.open({ project: true });

await wallet.addInstrument(x402Payments({
  signer,
  networks: ["eip155:84532"],
  assets: ["USDC"],
  schemes: ["exact"]
}));

const fetchPaid = x402Fetch(wallet, {
  maxAmount: { amount: "0.10", currency: "USDC" },
  facilitator: "https://x402.org/facilitator"
});

const response = await fetchPaid("https://api.example.com/paid-weather");
const receipt = response.x402?.receipt;
```

## Flow

1. `x402Fetch` sends the first request without payment headers.
2. The server returns `402` with `PAYMENT-REQUIRED`.
3. Steelyard selects a supported requirement by scheme, network, asset, amount,
   and stable order.
4. The selected requirement becomes a local wallet policy intent.
5. The wallet runs policy before signing.
6. The configured signer creates a short-lived `PaymentMandate` containing the
   x402 payment payload.
7. `x402Fetch` retries with `PAYMENT-SIGNATURE`.
8. The successful response includes `PAYMENT-RESPONSE`, exposed as
   `response.x402.receipt`.

## Signer Boundary

`x402Payments(...)` accepts a signer object:

```ts
const signer = {
  kind: "evm",
  async address() {
    return "0x...";
  },
  async supportedNetworks() {
    return ["eip155:84532"];
  },
  async signPayment({ requirements, resource, nonce }) {
    return signWithYourWallet({ requirements, resource, nonce });
  }
};
```

Do not pass raw private key strings. Wrap viem, CDP, hardware wallets, embedded
wallets, or browser wallet adapters behind the signer interface.

## Error Handling

Buyer errors are typed:

- `X402PaymentRequiredParseError`
- `X402NoSupportedRequirement`
- `X402PaymentNotAllowed`
- `X402SignerUnavailable`
- `X402PaymentRetryFailed`
- `X402SettlementMissing`
- `X402SettlementAmbiguous`

Error messages redact signatures and payment payload material. Ambiguous
settlement errors include the idempotency key and requirement hash so callers
can retry or reconcile safely.
