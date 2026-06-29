import type { PaymentMandate, PaymentMandateRequest, PurchaseIntent } from "steelyard/core";
import {
  createX402PaymentMandateIssuer,
  x402Fetch,
  type X402FetchOptions,
  type X402PaymentPayload,
  type X402Signer,
  type X402WalletLike
} from "steelyard/x402";

export function createMockX402Signer(): X402Signer {
  return {
    kind: "evm",
    async address() {
      return "0xbuyer000000000000000000000000000000000001";
    },
    async supportedNetworks() {
      return ["eip155:84532"];
    },
    async signPayment({ requirements, resource, nonce }): Promise<X402PaymentPayload> {
      return {
        x402Version: 2,
        scheme: requirements.scheme,
        network: requirements.network,
        payer: await this.address(),
        payload: {
          nonce,
          resource: resource.url,
          requirementHash: resource.requirementHash,
          maxAmountRequired: requirements.maxAmountRequired,
          payTo: requirements.payTo
        },
        signature: `mock_signature_${nonce}`
      };
    }
  };
}

export function createOfflineWallet(signer: X402Signer = createMockX402Signer()): X402WalletLike {
  const issuer = createX402PaymentMandateIssuer({
    signer,
    networks: ["eip155:84532"],
    assets: ["USDC"],
    schemes: ["exact"]
  });

  return {
    async decide(intent: PurchaseIntent) {
      return intent.amount <= 10_000
        ? { status: "allowed", rule: "offline x402 demo limit" }
        : { status: "denied", reason: "offline x402 demo limit exceeded" };
    },
    async chooseInstrument() {
      return {
        id: "agent-native_x402",
        mode: "agent-native",
        type: "x402",
        label: "Mock x402 signer",
        created_at: new Date("2026-06-28T00:00:00.000Z").toISOString(),
        default: true
      };
    },
    async prepareMandate(intent: PurchaseIntent, opts = {}): Promise<PaymentMandate> {
      return issuer.issueMandate({
        iat: 1_783_000_000,
        nonce: opts.idempotencyKey ?? "x402_weather_demo",
        merchant_id: intent.merchant.domain,
        handler_id: opts.handlerId ?? "x402",
        instrument_type: "x402",
        transaction_id: opts.transactionId,
        context: opts.context,
        payment: {
          amount: intent.amount,
          currency: intent.currency,
          checkout_id: intent.intent_id ?? "x402_weather",
          expires_at: "2026-06-28T00:05:00.000Z"
        }
      } satisfies PaymentMandateRequest);
    }
  };
}

export function createPaidWeatherFetch(opts: X402FetchOptions = {}) {
  return x402Fetch(createOfflineWallet(), {
    maxAmount: { amount: "0.01", currency: "USDC" },
    ...opts
  });
}
