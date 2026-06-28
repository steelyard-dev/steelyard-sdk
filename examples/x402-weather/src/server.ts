import { createServer } from "node:http";
import type { Server } from "node:http";
import {
  exactUsdc,
  x402Paywall,
  type X402FacilitatorClient,
  type X402PaywallOptions,
  type X402SettleResult,
  type X402VerifyResult
} from "@steelyard/x402/server";

export function createMockWeatherFacilitator(): X402FacilitatorClient {
  const settled = new Map<string, X402SettleResult>();
  return {
    async verify({ paymentPayload }): Promise<X402VerifyResult> {
      return paymentPayload.signature
        ? { valid: true, payer: paymentPayload.payer, network: paymentPayload.network }
        : { valid: false, reason: "missing_signature" };
    },
    async settle({ paymentPayload, paymentRequirements }): Promise<X402SettleResult> {
      const key = `${paymentPayload.signature}:${paymentRequirements.resource ?? "weather"}`;
      const existing = settled.get(key);
      if (existing) return existing;
      const result = {
        success: true,
        transaction: `mock_${settled.size + 1}`,
        payer: paymentPayload.payer,
        network: paymentPayload.network
      };
      settled.set(key, result);
      return result;
    }
  };
}

export function createWeatherPaywall(opts: Partial<X402PaywallOptions> = {}) {
  return x402Paywall({
    facilitator: opts.facilitator ?? createMockWeatherFacilitator(),
    routes: {
      "GET /weather": exactUsdc({
        amount: "0.001",
        network: "eip155:84532",
        payTo: "0x0000000000000000000000000000000000000001",
        description: "Current weather observation",
        handler: () => ({ city: "London", condition: "sunny", paid: true })
      })
    },
    ...opts
  });
}

export async function startWeatherServer(port = 0): Promise<{ server: Server; url: string }> {
  const { handler } = createWeatherPaywall();
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}
