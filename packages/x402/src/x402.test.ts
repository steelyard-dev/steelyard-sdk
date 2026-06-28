import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  X402NoSupportedRequirement,
  X402PaymentNotAllowed,
  X402PaymentRequiredParseError,
  X402SignerUnavailable,
  X402SettlementMissing,
  createX402ExactPaymentMandateIssuer,
  createX402Fetch,
  createX402PaymentMandateIssuer,
  deterministicIdempotencyKey,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignature,
  parsePaymentRequiredHeader,
  paymentRequirementHash,
  redactUrl,
  selectPaymentRequirement,
  x402Exact,
  x402Fetch,
  x402Payments
} from "./index.js";
import { createX402FacilitatorClient, exactUsdc, memoryX402IdempotencyStore, x402Paywall } from "./server.js";
import type { X402FacilitatorClient } from "./server.js";
import type { X402PaymentPayload, X402PaymentRequirements, X402Signer, X402WalletLike } from "./index.js";

const requirement: X402PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "USDC",
  payTo: "0x0000000000000000000000000000000000000001",
  maxAmountRequired: "1000",
  resource: "https://api.example.test/weather",
  description: "Paid weather"
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("x402 protocol helpers", () => {
  it("parses v2 PAYMENT-* headers case-insensitively", () => {
    const header = encodePaymentRequiredHeader({ x402Version: 2, accepts: [requirement] });
    const parsed = parsePaymentRequiredHeader({ "payment-required": header });

    expect(parsed).toEqual({ x402Version: 2, accepts: [requirement] });
  });

  it("rejects malformed payment headers with typed errors and no payload leakage", () => {
    expect(() => parsePaymentRequiredHeader({ "PAYMENT-REQUIRED": "not json!" })).toThrow(
      X402PaymentRequiredParseError
    );
    expect(() => parsePaymentRequiredHeader({ "PAYMENT-REQUIRED": "not json!" })).toThrow(/PAYMENT-REQUIRED/);
  });

  it("selects requirements deterministically and rejects unsupported options", () => {
    const expensive = { ...requirement, maxAmountRequired: "2000" };
    const cheap = { ...requirement, maxAmountRequired: "1000" };
    const otherNetwork = { ...cheap, network: "eip155:1" };

    expect(selectPaymentRequirement([expensive, cheap], {
      schemes: ["exact"],
      networks: ["eip155:84532"],
      assets: ["USDC"]
    })).toBe(cheap);
    expect(selectPaymentRequirement([otherNetwork, cheap], {
      schemes: ["exact"],
      networks: ["eip155:84532"],
      assets: ["USDC"]
    })).toBe(cheap);
    expect(() => selectPaymentRequirement([otherNetwork], {
      schemes: ["exact"],
      networks: ["eip155:84532"],
      assets: ["USDC"]
    })).toThrow(X402NoSupportedRequirement);
  });

  it("binds deterministic buyer idempotency keys to request facts", () => {
    const base = {
      method: "GET",
      url: "https://api.example.test/weather",
      bodyHash: "empty",
      requirementHash: paymentRequirementHash(requirement),
      instrumentId: "agent-native_x402"
    };

    const first = deterministicIdempotencyKey(base);
    expect(deterministicIdempotencyKey(base)).toBe(first);
    expect(deterministicIdempotencyKey({ ...base, url: "https://api.example.test/other" })).not.toBe(first);
    expect(deterministicIdempotencyKey({ ...base, bodyHash: "different" })).not.toBe(first);
    expect(deterministicIdempotencyKey({ ...base, requirementHash: "different" })).not.toBe(first);
  });

  it("redacts obvious URL secrets", () => {
    expect(redactUrl("https://api.example.test/weather?api_key=secret&city=rome&token=abc")).toBe(
      "https://api.example.test/weather?api_key=%5BREDACTED%5D&city=rome&token=%5BREDACTED%5D"
    );
  });
});

describe("x402 buyer integration", () => {
  it("wraps an x402 signer as an agent-native payment instrument", () => {
    const signer = deterministicSigner();
    const generic = x402Payments({ signer, networks: ["eip155:84532"], assets: ["USDC"], schemes: ["exact"] });
    const exact = x402Exact({ signer, networks: ["eip155:84532"], assets: ["USDC"] });
    const exactIssuer = createX402ExactPaymentMandateIssuer({
      signer,
      networks: ["eip155:84532"],
      assets: ["USDC"]
    });

    expect(generic).toMatchObject({ mode: "agent-native", type: "x402", label: "x402 payments" });
    expect(generic.issuer.instrumentType).toBe("x402");
    expect(exact.issuer.instrumentType).toBe("x402");
    expect(exactIssuer.instrumentType).toBe("x402");
  });

  it("requires explicit opt-in for mainnet networks", () => {
    const signer = deterministicSigner();

    expect(() => x402Payments({
      signer,
      networks: ["eip155:8453"],
      assets: ["USDC"],
      schemes: ["exact"]
    })).toThrow(X402SignerUnavailable);

    expect(() => x402Payments({
      signer,
      networks: ["eip155:8453"],
      assets: ["USDC"],
      schemes: ["exact"],
      allowMainnet: true
    })).not.toThrow();
  });

  it("runs wallet policy before signing and attaches typed settlement metadata", async () => {
    const events: string[] = [];
    const signer = deterministicSigner(events);
    const wallet = walletForSigner(signer, { events });
    const calls: Request[] = [];
    const paidFetch = x402Fetch(wallet, {
      maxAmount: { amount: "0.10", currency: "USDC" },
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        calls.push(request.clone());
        if (calls.length === 1) {
          expect(request.headers.get("PAYMENT-SIGNATURE")).toBeNull();
          return new Response("payment required", {
            status: 402,
            headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, accepts: [requirement] }) }
          });
        }
        expect(request.headers.get("PAYMENT-SIGNATURE")).toEqual(expect.any(String));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": encodePaymentResponseHeader({
              success: true,
              transaction: "0xsettled",
              network: "eip155:84532",
              payer: "0xbuyer"
            })
          }
        });
      }
    });

    const response = await paidFetch("https://api.example.test/weather");

    expect(response.x402?.receipt).toMatchObject({
      transaction: "0xsettled",
      network: "eip155:84532",
      payer: "0xbuyer"
    });
    expect(events).toEqual(["choose", "decide", "prepare", "sign"]);
    expect(calls).toHaveLength(2);
  });

  it("prevents signer invocation when policy denies or requires approval", async () => {
    const events: string[] = [];
    const signer = deterministicSigner(events);
    const fetchImpl = async () => new Response("payment required", {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, accepts: [requirement] }) }
    });

    await expect(createX402Fetch(walletForSigner(signer, { decision: { status: "denied", reason: "blocked" }, events }), {
      fetch: fetchImpl
    })("https://api.example.test/weather")).rejects.toThrow(X402PaymentNotAllowed);
    expect(events).not.toContain("sign");

    events.length = 0;
    await expect(createX402Fetch(walletForSigner(signer, {
      decision: { status: "approval_required", threshold: { amount: 1, currency: "USDC" }, matched_rule: "needs human" },
      events
    }), { fetch: fetchImpl })("https://api.example.test/weather")).rejects.toThrow(X402PaymentNotAllowed);
    expect(events).not.toContain("sign");
  });

  it("surfaces a missing settlement response as a typed error", async () => {
    const signer = deterministicSigner();
    const wallet = walletForSigner(signer);
    const paidFetch = x402Fetch(wallet, {
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        return request.headers.has("PAYMENT-SIGNATURE")
          ? new Response("paid", { status: 200 })
          : new Response("payment required", {
            status: 402,
            headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, accepts: [requirement] }) }
          });
      }
    });

    await expect(paidFetch("https://api.example.test/weather")).rejects.toThrow(X402SettlementMissing);
  });
});

describe("x402 server integration", () => {
  it("creates an HTTP facilitator client for /verify and /settle", async () => {
    const calls: string[] = [];
    const client = createX402FacilitatorClient({
      baseUrl: "https://facilitator.example",
      fetch: async (url, init) => {
        calls.push(`${init?.method} ${url}`);
        return new Response(JSON.stringify(String(url).endsWith("/verify")
          ? { valid: true }
          : { success: true, transaction: "0xsettled" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await expect(client.verify({
      paymentPayload: deterministicPayload(requirement),
      paymentRequirements: requirement
    })).resolves.toEqual({ valid: true });
    await expect(client.settle({
      paymentPayload: deterministicPayload(requirement),
      paymentRequirements: requirement
    })).resolves.toEqual({ success: true, transaction: "0xsettled" });
    expect(calls).toEqual([
      "POST https://facilitator.example/verify",
      "POST https://facilitator.example/settle"
    ]);
  });

  it("protects a route, delegates verify/settle, and does not settle duplicate signatures twice", async () => {
    const calls = { verify: 0, settle: 0 };
    const facilitator: X402FacilitatorClient = {
      async verify() {
        calls.verify += 1;
        return { valid: true, payer: "0xbuyer", network: "eip155:84532" };
      },
      async settle() {
        calls.settle += 1;
        return { success: true, transaction: `0xsettled_${calls.settle}`, payer: "0xbuyer", network: "eip155:84532" };
      }
    };
    const paywall = x402Paywall({
      facilitator,
      idempotencyStore: memoryX402IdempotencyStore(),
      routes: {
        "GET /paid": exactUsdc({
          amount: "0.001",
          network: "eip155:84532",
          payTo: "0x0000000000000000000000000000000000000001",
          description: "Paid API",
          handler: () => ({ ok: true, weather: "sunny" })
        })
      }
    });
    const { url, close } = await listen(paywall.handler);
    try {
      const challenge = await fetch(`${url}/paid`);
      expect(challenge.status).toBe(402);
      const parsed = parsePaymentRequiredHeader(challenge.headers);
      expect(parsed.accepts[0]?.maxAmountRequired).toBe("1000");

      const payload = deterministicPayload(parsed.accepts[0]!);
      const paidHeaders = { "PAYMENT-SIGNATURE": encodePaymentSignature(payload) };
      const paid = await fetch(`${url}/paid`, { headers: paidHeaders });
      expect(paid.status).toBe(200);
      await expect(paid.json()).resolves.toEqual({ ok: true, weather: "sunny" });
      expect(paid.headers.get("PAYMENT-RESPONSE")).toEqual(expect.any(String));

      const duplicate = await fetch(`${url}/paid`, { headers: paidHeaders });
      expect(duplicate.status).toBe(200);
      expect(calls).toEqual({ verify: 1, settle: 1 });
    } finally {
      await close();
    }
  });

  it("returns a fresh 402 when facilitator verification fails", async () => {
    const facilitator: X402FacilitatorClient = {
      async verify() {
        return { valid: false, reason: "bad_signature" };
      },
      async settle() {
        throw new Error("settle should not be called");
      }
    };
    const paywall = x402Paywall({
      facilitator,
      routes: {
        "GET /paid": exactUsdc({
          amount: "0.001",
          network: "eip155:84532",
          payTo: "0x0000000000000000000000000000000000000001"
        })
      }
    });
    const { url, close } = await listen(paywall.handler);
    try {
      const payload = deterministicPayload(requirement);
      const response = await fetch(`${url}/paid`, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignature(payload) } });
      expect(response.status).toBe(402);
      expect(response.headers.get("PAYMENT-REQUIRED")).toEqual(expect.any(String));
    } finally {
      await close();
    }
  });

  it("returns 402 and does not run the protected handler when settlement fails", async () => {
    const calls = { settle: 0, handler: 0 };
    const facilitator: X402FacilitatorClient = {
      async verify() {
        return { valid: true, payer: "0xbuyer", network: "eip155:84532" };
      },
      async settle() {
        calls.settle += 1;
        return { success: false, reason: "insufficient_funds" };
      }
    };
    const paywall = x402Paywall({
      facilitator,
      routes: {
        "GET /paid": exactUsdc({
          amount: "0.001",
          network: "eip155:84532",
          payTo: "0x0000000000000000000000000000000000000001",
          handler: () => {
            calls.handler += 1;
            return { ok: true };
          }
        })
      }
    });
    const { url, close } = await listen(paywall.handler);
    try {
      const response = await fetch(`${url}/paid`, {
        headers: { "PAYMENT-SIGNATURE": encodePaymentSignature(deterministicPayload(requirement)) }
      });

      expect(response.status).toBe(402);
      await expect(response.json()).resolves.toEqual({ error: "insufficient_funds" });
      expect(calls).toEqual({ settle: 1, handler: 0 });
    } finally {
      await close();
    }
  });
});

function deterministicSigner(events: string[] = []): X402Signer {
  return {
    kind: "evm",
    async address() {
      return "0xbuyer";
    },
    async supportedNetworks() {
      return ["eip155:84532"];
    },
    async signPayment(args) {
      events.push("sign");
      return deterministicPayload(args.requirements, args.resource.idempotencyKey);
    }
  };
}

function deterministicPayload(requirements: X402PaymentRequirements, nonce = "nonce"): X402PaymentPayload {
  return {
    x402Version: 2,
    scheme: requirements.scheme,
    network: requirements.network,
    payer: "0xbuyer",
    payload: {
      nonce,
      payTo: requirements.payTo,
      maxAmountRequired: requirements.maxAmountRequired
    },
    signature: `sig_${nonce}`
  };
}

function walletForSigner(
  signer: X402Signer,
  opts: {
    decision?: Awaited<ReturnType<X402WalletLike["decide"]>>;
    events?: string[];
  } = {}
): X402WalletLike {
  const issuer = createX402PaymentMandateIssuer({
    signer,
    networks: ["eip155:84532"],
    assets: ["USDC"],
    schemes: ["exact"]
  });
  const events = opts.events ?? [];
  return {
    async decide() {
      events.push("decide");
      return opts.decision ?? { status: "allowed", rule: "unit" };
    },
    async chooseInstrument() {
      events.push("choose");
      return {
        id: "agent-native_x402",
        mode: "agent-native",
        type: "x402",
        label: "x402 payments",
        created_at: new Date("2026-06-28T00:00:00.000Z").toISOString(),
        default: true
      };
    },
    async prepareMandate(intent, prepareOpts) {
      events.push("prepare");
      return issuer.issueMandate({
        iat: 1_783_000_000,
        nonce: prepareOpts?.idempotencyKey ?? "nonce",
        merchant_id: intent.merchant.domain,
        handler_id: prepareOpts?.handlerId,
        instrument_type: "x402",
        transaction_id: prepareOpts?.transactionId,
        context: prepareOpts?.context,
        payment: {
          amount: intent.amount,
          currency: intent.currency,
          checkout_id: intent.intent_id ?? "intent",
          expires_at: "2026-06-28T00:10:00.000Z"
        }
      });
    }
  };
}

async function listen(handler: RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
