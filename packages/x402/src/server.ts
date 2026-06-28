import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { X402SettlementAmbiguous } from "./errors.js";
import { createX402FacilitatorClient, memoryX402IdempotencyStore } from "./facilitator.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  parsePaymentSignatureHeader,
  paymentRequirementHash,
  redactUrl,
  sha256Hex,
  stableJson,
  toAtomicUnits
} from "./protocol.js";
import type {
  X402FacilitatorClient,
  X402PaywallOptions,
  X402PaymentPayload,
  X402ProtectedHandler,
  X402RouteRequirement,
  X402SettleResult
} from "./types.js";

export { createX402FacilitatorClient, memoryX402IdempotencyStore } from "./facilitator.js";
export type {
  X402FacilitatorClient,
  X402PaywallOptions,
  X402RouteRequirement,
  X402SettleResult,
  X402VerifyResult
} from "./types.js";

export function exactUsdc(opts: {
  amount: string;
  network: string;
  payTo: string;
  description?: string;
  resource?: string;
  mimeType?: string;
  outputSchema?: unknown;
  maxTimeoutSeconds?: number;
  handler?: X402ProtectedHandler;
}): X402RouteRequirement {
  return {
    scheme: "exact",
    network: opts.network,
    asset: "USDC",
    payTo: opts.payTo,
    maxAmountRequired: toAtomicUnits(opts.amount, "USDC"),
    ...(opts.resource ? { resource: opts.resource } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.mimeType ? { mimeType: opts.mimeType } : {}),
    ...("outputSchema" in opts ? { outputSchema: opts.outputSchema } : {}),
    ...(opts.maxTimeoutSeconds ? { maxTimeoutSeconds: opts.maxTimeoutSeconds } : {}),
    extra: { displayAmount: opts.amount, displayCurrency: "USDC" },
    ...(opts.handler ? { handler: opts.handler } : {})
  };
}

export function x402Paywall(opts: X402PaywallOptions): { handler: RequestListener } {
  const facilitator = facilitatorClient(opts.facilitator, opts.fetch);
  const store = opts.idempotencyStore ?? memoryX402IdempotencyStore();
  const clock = opts.clock ?? (() => new Date());

  return {
    handler: async (req, res) => {
      const route = matchRoute(req, opts.routes);
      if (!route) return writeJson(res, 404, { error: "not_found" });

      const resourceUrl = requestUrl(req);
      const requirement = {
        ...route.requirement,
        resource: route.requirement.resource ?? resourceUrl
      };
      const challenge = { x402Version: 2, accepts: [requirement] };
      if (!req.headers["payment-signature"]) {
        res.setHeader(PAYMENT_REQUIRED_HEADER, encodePaymentRequiredHeader(challenge));
        return writeJson(res, 402, challenge);
      }

      let paymentPayload: X402PaymentPayload;
      try {
        paymentPayload = parsePaymentSignatureHeader(req.headers);
      } catch (error) {
        res.setHeader(PAYMENT_REQUIRED_HEADER, encodePaymentRequiredHeader({ ...challenge, error: "invalid_payment_signature" }));
        return writeJson(res, 402, { error: error instanceof Error ? error.name : "invalid_payment_signature" });
      }

      const idempotencyKey = serverIdempotencyKey(paymentPayload, requirement);
      const existing = await store.get(idempotencyKey);
      const settleResult = existing ?? await verifyAndSettle(facilitator, paymentPayload, requirement, res, challenge, store, idempotencyKey);
      if (!settleResult) return;

      res.setHeader(PAYMENT_RESPONSE_HEADER, encodePaymentResponseHeader({
        success: settleResult.success,
        ...(settleResult.transaction ? { transaction: settleResult.transaction } : {}),
        ...(settleResult.network ? { network: settleResult.network } : {}),
        ...(settleResult.payer ? { payer: settleResult.payer } : {})
      }));

      try {
        const result = route.requirement.handler
          ? await route.requirement.handler(req, res)
          : { ok: true, paid: true, settledAt: clock().toISOString() };
        if (!res.writableEnded) await writeProtectedResult(res, result);
      } catch (error) {
        const requirementHash = paymentRequirementHash(requirement);
        const ambiguous = new X402SettlementAmbiguous(
          `x402 protected handler failed after settlement for ${redactUrl(resourceUrl)}`,
          { idempotencyKey, requirementHash }
        );
        if (!res.headersSent) writeJson(res, 500, {
          error: ambiguous.name,
          idempotencyKey,
          requirementHash
        });
        else res.destroy(error instanceof Error ? error : ambiguous);
      }
    }
  };
}

async function verifyAndSettle(
  facilitator: X402FacilitatorClient,
  paymentPayload: Parameters<X402FacilitatorClient["verify"]>[0]["paymentPayload"],
  requirement: X402RouteRequirement,
  res: ServerResponse,
  challenge: { x402Version: number; accepts: X402RouteRequirement[] },
  store: ReturnType<typeof memoryX402IdempotencyStore>,
  idempotencyKey: string
): Promise<X402SettleResult | undefined> {
  const verify = await facilitator.verify({ paymentPayload, paymentRequirements: requirement });
  if (!verify.valid) {
    res.setHeader(PAYMENT_REQUIRED_HEADER, encodePaymentRequiredHeader({ ...challenge, error: verify.reason ?? "payment_invalid" }));
    writeJson(res, 402, { error: verify.reason ?? "payment_invalid" });
    return undefined;
  }
  const settled = await facilitator.settle({ paymentPayload, paymentRequirements: requirement });
  if (!settled.success) {
    writeJson(res, 402, { error: settled.reason ?? "payment_settlement_failed" });
    return undefined;
  }
  await store.set(idempotencyKey, settled);
  return settled;
}

function facilitatorClient(input: string | X402FacilitatorClient, fetchImpl?: typeof fetch): X402FacilitatorClient {
  return typeof input === "string" ? createX402FacilitatorClient({ baseUrl: input, fetch: fetchImpl }) : input;
}

function matchRoute(req: IncomingMessage, routes: Record<string, X402RouteRequirement>) {
  const method = (req.method ?? "GET").toUpperCase();
  const path = new URL(requestUrl(req)).pathname;
  const exact = routes[`${method} ${path}`];
  if (exact) return { requirement: exact };
  const wildcard = routes["*"];
  return wildcard ? { requirement: wildcard } : undefined;
}

function requestUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  return `http://${host}${req.url ?? "/"}`;
}

function serverIdempotencyKey(paymentPayload: unknown, requirement: X402RouteRequirement): string {
  return `x402_server_${sha256Hex(stableJson({ paymentPayload, requirementHash: paymentRequirementHash(requirement) })).slice(0, 40)}`;
}

async function writeProtectedResult(
  res: ServerResponse,
  result: Response | string | Uint8Array | Record<string, unknown> | undefined
): Promise<void> {
  if (result === undefined) return writeJson(res, 200, { ok: true });
  if (result instanceof Response) {
    res.statusCode = result.status;
    for (const [key, value] of result.headers) res.setHeader(key, value);
    res.end(Buffer.from(await result.arrayBuffer()));
    return;
  }
  if (typeof result === "string" || result instanceof Uint8Array) {
    res.statusCode = 200;
    res.end(result);
    return;
  }
  return writeJson(res, 200, result);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  if (!res.hasHeader("content-type")) res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
