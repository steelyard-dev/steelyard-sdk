import type { AgentNativeInstrument, PaymentMandate, PaymentMandateRequest, PurchaseIntent } from "@steelyard-dev/core";
import {
  X402PaymentNotAllowed,
  X402PaymentRequiredParseError,
  X402PaymentRetryFailed,
  X402SettlementAmbiguous,
  X402SignerUnavailable
} from "./errors.js";
import {
  PAYMENT_SIGNATURE_HEADER,
  assertAmountWithinLimit,
  deterministicIdempotencyKey,
  encodePaymentSignature,
  isX402PaymentRequired,
  parsePaymentRequiredHeader,
  parsePaymentResponseHeader,
  paymentRequirementHash,
  redactUrl,
  requestBodyHash,
  resourceContext,
  safeRequirementAmountToMinorUnits,
  selectPaymentRequirement,
  sha256Hex,
  stableJson
} from "./protocol.js";
import type {
  X402FetchOptions,
  X402FetchResponse,
  X402MandateContext,
  X402PaymentInstrumentOptions,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402WalletLike
} from "./types.js";

export function x402Payments(opts: X402PaymentInstrumentOptions): AgentNativeInstrument {
  return {
    mode: "agent-native",
    type: "x402",
    label: opts.label ?? "x402 payments",
    issuer: createX402PaymentMandateIssuer(opts)
  };
}

export function x402Exact(opts: Omit<X402PaymentInstrumentOptions, "schemes">): AgentNativeInstrument {
  return x402Payments({ ...opts, schemes: ["exact"] });
}

export function createX402ExactPaymentMandateIssuer(
  opts: Omit<X402PaymentInstrumentOptions, "schemes">
) {
  return createX402PaymentMandateIssuer({ ...opts, schemes: ["exact"] });
}

export function createX402PaymentMandateIssuer(opts: X402PaymentInstrumentOptions) {
  assertNoAccidentalMainnet(opts.networks, opts.allowMainnet);
  const schemes = new Set((opts.schemes ?? ["exact"]).map(String));
  const configuredNetworks = opts.networks ? new Set(opts.networks) : undefined;
  const assets = opts.assets ? new Set(opts.assets.map((asset) => asset.toUpperCase())) : undefined;
  const clock = opts.clock ?? (() => new Date());

  return {
    instrumentType: "x402" as const,
    async issueMandate(mandate: PaymentMandateRequest): Promise<PaymentMandate> {
      const context = parseMandateContext(mandate.context);
      const supportedNetworks = await opts.signer.supportedNetworks();
      if (!schemes.has(context.requirements.scheme)) {
        throw new X402SignerUnavailable(`x402 signer does not support scheme ${context.requirements.scheme}`);
      }
      if (configuredNetworks && !configuredNetworks.has(context.requirements.network)) {
        throw new X402SignerUnavailable(`x402 instrument is not configured for network ${context.requirements.network}`);
      }
      if (!supportedNetworks.includes(context.requirements.network)) {
        throw new X402SignerUnavailable(`x402 signer does not support network ${context.requirements.network}`);
      }
      if (assets && !assets.has(context.requirements.asset.toUpperCase())) {
        throw new X402SignerUnavailable(`x402 instrument is not configured for asset ${context.requirements.asset}`);
      }
      assertNoAccidentalMainnet([context.requirements.network], opts.allowMainnet);

      const paymentPayload = await opts.signer.signPayment({
        requirements: context.requirements,
        resource: context.resource,
        nonce: mandate.nonce,
        expiresAt: mandate.payment.expires_at
      });
      const expiresAt = Math.floor(Date.parse(mandate.payment.expires_at) / 1000);
      return {
        id: `x402_${sha256Hex(stableJson({ payload: redactPaymentPayload(paymentPayload), nonce: mandate.nonce })).slice(0, 32)}`,
        expires_at: Number.isFinite(expiresAt) ? expiresAt : Math.floor(clock().getTime() / 1000) + 300,
        max_amount: mandate.payment.amount,
        currency: mandate.payment.currency,
        scope_proof: {
          type: "x402_payment_payload",
          paymentPayload,
          requirementsHash: context.resource.requirementHash,
          resourceHash: sha256Hex(stableJson(context.resource)),
          idempotencyKey: context.resource.idempotencyKey
        }
      };
    }
  };
}

export function x402Fetch(wallet: X402WalletLike, opts: X402FetchOptions = {}) {
  return createX402Fetch(wallet, opts);
}

export function createX402Fetch(wallet: X402WalletLike, opts: X402FetchOptions = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new X402PaymentRetryFailed("global fetch is unavailable; pass X402FetchOptions.fetch");
  const clock = opts.clock ?? (() => new Date());

  return async function fetchWithX402(input: Request | URL | string, init?: RequestInit): Promise<X402FetchResponse> {
    const initialRequest = new Request(input, init);
    const retryTemplate = initialRequest.clone();
    const initialResponse = await fetchImpl(initialRequest);
    if (!isX402PaymentRequired(initialResponse)) return initialResponse as X402FetchResponse;

    const challenge = parsePaymentRequiredHeader(initialResponse.headers);
    const bodyHash = await requestBodyHash(retryTemplate);
    const baseUrl = new URL(retryTemplate.url);
    const requirement = selectPaymentRequirement(challenge.accepts, {
      schemes: opts.allowedSchemes,
      networks: opts.allowedNetworks,
      assets: opts.allowedAssets
    });
    assertAmountWithinLimit(requirement, opts.maxAmount);

    const intent = intentFromRequirement(retryTemplate, requirement, bodyHash);
    const instrument = await wallet.chooseInstrument(intent, {
      mode: "agent-native",
      type: "x402",
      instrumentId: opts.instrumentId
    });
    const requirementHash = paymentRequirementHash(requirement);
    const idempotencyKey = deterministicIdempotencyKey({
      method: retryTemplate.method,
      url: retryTemplate.url,
      bodyHash,
      requirementHash,
      instrumentId: opts.instrumentId ?? instrument.id
    });
    const resource = resourceContext({
      method: retryTemplate.method,
      url: retryTemplate.url,
      bodyHash,
      idempotencyKey,
      requirementHash
    });

    const decision = await wallet.decide(intent);
    if (decision.status !== "allowed") {
      throw new X402PaymentNotAllowed(
        decision.status === "approval_required"
          ? "wallet policy requires approval before x402 signing"
          : `wallet policy denied x402 payment: ${decision.reason}`
      );
    }

    const mandate = await wallet.prepareMandate(intent, {
      instrumentId: opts.instrumentId ?? instrument.id,
      handlerId: "x402",
      transactionId: idempotencyKey,
      idempotencyKey,
      context: {
        x402: {
          requirements: requirement,
          resource,
          ...(opts.facilitator ? { facilitator: opts.facilitator } : {})
        } satisfies X402MandateContext
      },
      clock
    });
    const paymentPayload = paymentPayloadFromMandate(mandate);
    const headers = new Headers(retryTemplate.headers);
    headers.set(PAYMENT_SIGNATURE_HEADER, encodePaymentSignature(paymentPayload));
    const retryRequest = new Request(retryTemplate, { headers });
    const paidResponse = await fetchImpl(retryRequest) as X402FetchResponse;
    if (!paidResponse.ok) {
      throw new X402SettlementAmbiguous(
        `x402 paid retry failed with status ${paidResponse.status} for ${redactUrl(baseUrl.toString())}`,
        { idempotencyKey, requirementHash }
      );
    }

    const paymentResponse = parsePaymentResponseHeader(paidResponse.headers);
    paidResponse.x402 = {
      requirements: requirement,
      paymentPayload,
      receipt: {
        idempotencyKey,
        requirementHash,
        requirements: requirement,
        paymentResponse,
        resource,
        settledAt: clock().toISOString(),
        ...(paymentResponse.transaction ? { transaction: paymentResponse.transaction } : {}),
        ...(paymentResponse.network ? { network: paymentResponse.network } : {}),
        ...(paymentResponse.payer ? { payer: paymentResponse.payer } : {})
      }
    };
    return paidResponse;
  };
}

function parseMandateContext(context: Record<string, unknown> | undefined): X402MandateContext {
  const candidate = context?.x402;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new X402PaymentRequiredParseError("x402 mandate context is missing");
  }
  const value = candidate as X402MandateContext;
  if (!value.requirements || !value.resource) {
    throw new X402PaymentRequiredParseError("x402 mandate context is incomplete");
  }
  return value;
}

function intentFromRequirement(request: Request, requirement: X402PaymentRequirements, bodyHash: string): PurchaseIntent {
  const url = new URL(request.url);
  const amount = safeRequirementAmountToMinorUnits(requirement);
  const requirementHash = paymentRequirementHash(requirement);
  return {
    merchant: {
      domain: url.hostname,
      transport_url: url.toString(),
      protocol: "x402"
    },
    offer: {
      id: requirement.resource ?? url.pathname,
      title: requirement.description ?? `x402 ${request.method.toUpperCase()} ${url.pathname}`,
      categories: ["x402"]
    },
    amount,
    currency: requirement.asset.toUpperCase(),
    intent_id: `x402_${sha256Hex(stableJson({
      method: request.method.toUpperCase(),
      url: request.url,
      bodyHash,
      requirementHash
    })).slice(0, 40)}`
  };
}

function paymentPayloadFromMandate(mandate: PaymentMandate): X402PaymentPayload {
  const payload = mandate.scope_proof.paymentPayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new X402PaymentRequiredParseError("x402 mandate did not contain a payment payload");
  }
  return payload as X402PaymentPayload;
}

function assertNoAccidentalMainnet(networks: readonly string[] | undefined, allowMainnet: boolean | undefined): void {
  if (allowMainnet) return;
  const mainnet = (networks ?? []).find((network) => ["eip155:1", "eip155:8453", "base", "ethereum", "solana"].includes(network));
  if (mainnet) throw new X402SignerUnavailable(`x402 mainnet network ${mainnet} requires allowMainnet: true`);
}

function redactPaymentPayload(payload: X402PaymentPayload): X402PaymentPayload {
  return {
    ...payload,
    ...(payload.signature ? { signature: "[REDACTED]" } : {}),
    payload: {
      ...payload.payload,
      signature: payload.payload.signature ? "[REDACTED]" : payload.payload.signature
    }
  };
}
