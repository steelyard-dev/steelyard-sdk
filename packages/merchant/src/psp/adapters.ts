// Copyright (c) Steelyard contributors. MIT License.
import { createHash } from "node:crypto";
import {
  assertValidEcJwk,
  defaultClock,
  verifyDetachedJws,
  type EcJwk,
  type HmsAlgorithm,
  type PspCaptureResult
} from "@steelyard/core";
import type {
  PaymentCapability,
  PspAdapter,
  PspCaptureArgs
} from "@steelyard/psp";
import {
  STRIPE_LIVE_KEY_PREFIX,
  STRIPE_SPT_ID_PREFIX,
  StripeLiveDisabledError,
  assertStripeTestSecretKey,
  chargeSharedPaymentToken,
  redactSecret
} from "@steelyard/core/stripe";
import { verifyAp2PaymentMandate } from "@steelyard/ucp-signing";
export type { PspCaptureResult } from "@steelyard/core";
export type {
  PspAdapter,
  PspCaptureArgs,
  PspPaymentIntent,
  PspPaymentMandate
} from "@steelyard/psp";

export type MockPspFailMode =
  | "declined"
  | "fraud"
  | "insufficient_funds"
  | "expired_card"
  | "requires_authentication"
  | ((args: PspCaptureArgs) => PspCaptureResult | undefined);

export interface MockPspOptions {
  allowInProduction?: boolean;
  failOn?: MockPspFailMode;
  handlerIds?: readonly string[];
  seed?: string;
  clock?: () => Date;
}

export interface StripePspOptions {
  apiKey: string;
  apiBaseUrl?: string;
  apiVersion?: string;
  fetch?: typeof fetch;
  handlerIds?: readonly string[];
  acceptSharedPaymentTokens?: boolean;
  clock?: () => Date;
}

export interface ReferencePspOptions {
  signingKey: EcJwk;
  allowInProduction?: boolean;
  clock?: () => Date;
}

export const REFERENCE_PAYMENT_HANDLER_ID = "reference";
export const REFERENCE_PAYMENT_INSTRUMENT_TYPE = "delegated_payment_token";
export const REFERENCE_PAYMENT_TOKEN_PREFIX = "dpt_";

export class MockInProductionError extends Error {
  constructor() {
    super(
      "mockPsp() refused outside a known test environment. Use stripePsp() for real PSP integration. " +
        "For demo/staging: pass allowInProduction: true AND set STEELYARD_ALLOW_MOCK_PSP=1."
    );
    this.name = "MockInProductionError";
  }
}

export class PspConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PspConfigError";
  }
}

export class StripePspError extends Error {
  constructor(operation: string, cause: unknown, secret: string) {
    super(`stripePsp ${operation} failed: ${redactSecret(errorMessage(cause), secret)}`);
    this.name = "StripePspError";
  }
}

export class ReferencePspInProductionError extends Error {
  constructor() {
    super(
      "referencePsp() refused outside a known test environment. " +
        "For demo/staging: pass allowInProduction: true AND set STEELYARD_ALLOW_REFERENCE_PSP=1."
    );
    this.name = "ReferencePspInProductionError";
  }
}

export function mockPsp(opts: MockPspOptions = {}): PspAdapter {
  assertMockAllowed(opts);
  const handlerIds = new Set(opts.handlerIds ?? []);
  const capabilities = mockCapabilities(opts.handlerIds);
  const captures = new Map<string, PspCaptureResult>();
  const seed = opts.seed ?? "steelyard-mock-psp";
  const clock = defaultClock(opts.clock);
  return {
    name: "mock",
    capabilities,
    supportsHandler: (handlerId) => handlerIds.size === 0 || handlerIds.has(handlerId),
    async capture(args) {
      const validation = await validateCaptureArgs(args, clock, capabilities);
      const cached = captures.get(args.idempotencyKey);
      if (cached) return cloneResult(cached);
      const failure = mockFailure(opts.failOn, args);
      if (failure) {
        captures.set(args.idempotencyKey, failure);
        return cloneResult(failure);
      }
      const result: PspCaptureResult = {
        ok: true,
        psp_payment_id: `psp_payment_${shortHash(
          seed,
          pspPaymentMethod(args, validation),
          String(args.amount),
          args.currency,
          args.idempotencyKey
        )}`,
        status: "captured"
      };
      captures.set(args.idempotencyKey, result);
      return cloneResult(result);
    },
    async cancel(args) {
      if (!args.psp_payment_id) throw new PspConfigError("psp_payment_id is required");
      if (!args.idempotencyKey) throw new PspConfigError("idempotencyKey is required");
    }
  };
}

export function mockVaultToken(input: {
  idempotencyKey: string;
  paymentCredential: string;
  seed?: string;
}): string {
  if (!input.idempotencyKey) throw new PspConfigError("idempotencyKey is required");
  if (!input.paymentCredential) throw new PspConfigError("paymentCredential is required");
  return `vt_test_${shortHash(input.seed ?? "steelyard-mock-psp", input.paymentCredential, input.idempotencyKey)}`;
}

export function stripePsp(opts: StripePspOptions): PspAdapter {
  if (!opts.apiKey) throw new PspConfigError("stripePsp requires an apiKey argument");
  if (opts.apiKey.startsWith(STRIPE_LIVE_KEY_PREFIX)) throw new StripeLiveDisabledError("v0.6 is test-only");
  if (opts.acceptSharedPaymentTokens === true) assertStripeTestSecretKey(opts.apiKey);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new PspConfigError("stripePsp requires fetch support");
  const apiBaseUrl = (opts.apiBaseUrl ?? "https://api.stripe.com").replace(/\/+$/, "");
  const handlerIds = new Set(opts.handlerIds ?? ["stripe"]);
  const capabilities = [...handlerIds].map((handlerId) => ({
    handlerId,
    instrumentType: "shared_payment_token",
    idPrefix: STRIPE_SPT_ID_PREFIX
  })) satisfies PaymentCapability[];
  const clock = defaultClock(opts.clock);
  return {
    name: "stripe",
    capabilities,
    supportsHandler: (handlerId) => handlerIds.has(handlerId),
    async capture(args) {
      const validation = await validateCaptureArgs(args, clock, capabilities);
      const paymentMethod = pspPaymentMethod(args, validation);
      if (paymentMethod.startsWith(STRIPE_SPT_ID_PREFIX)) {
        if (opts.acceptSharedPaymentTokens !== true) {
          throw new PspConfigError("STRIPE_SPT_NOT_ENABLED");
        }
        return neutralStripeResult(await chargeSharedPaymentToken({
          apiKey: opts.apiKey,
          apiBaseUrl,
          apiVersion: opts.apiVersion,
          sptId: paymentMethod,
          amount: args.amount,
          currency: args.currency,
          idempotencyKey: args.idempotencyKey,
          fetch: fetchImpl
        }));
      }
      try {
        const response = await fetchImpl(`${apiBaseUrl}/v1/payment_intents`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": args.idempotencyKey
          },
          body: stripeCaptureBody(args, paymentMethod)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) return stripeFailure(payload);
        return stripeCaptureResult(payload);
      } catch (error) {
        throw new StripePspError("capture", error, opts.apiKey);
      }
    },
    async cancel(args) {
      if (!args.psp_payment_id) throw new PspConfigError("psp_payment_id is required");
      if (!args.idempotencyKey) throw new PspConfigError("idempotencyKey is required");
      try {
        const response = await fetchImpl(
          `${apiBaseUrl}/v1/payment_intents/${encodeURIComponent(args.psp_payment_id)}/cancel`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${opts.apiKey}`,
              "content-type": "application/x-www-form-urlencoded",
              "idempotency-key": args.idempotencyKey
            }
          }
        );
        if (!response.ok) await response.text().catch(() => "");
      } catch (error) {
        throw new StripePspError("cancel", error, opts.apiKey);
      }
    }
  };
}

export function referencePsp(opts: ReferencePspOptions): PspAdapter {
  assertReferenceAllowed(opts);
  const signingKey = validReferenceKey(opts.signingKey);
  const capabilities = [{
    handlerId: REFERENCE_PAYMENT_HANDLER_ID,
    instrumentType: REFERENCE_PAYMENT_INSTRUMENT_TYPE,
    idPrefix: REFERENCE_PAYMENT_TOKEN_PREFIX
  }] satisfies PaymentCapability[];
  const captures = new Map<string, PspCaptureResult>();
  const clock = defaultClock(opts.clock);
  return {
    name: "reference",
    capabilities,
    supportsHandler: (handlerId) => handlerId === REFERENCE_PAYMENT_HANDLER_ID,
    async capture(args) {
      const validation = await validateCaptureArgs(args, clock, capabilities);
      const cached = captures.get(args.idempotencyKey);
      if (cached) return cloneResult(cached);
      const paymentMethod = pspPaymentMethod(args, validation);
      const verification = await verifyReferencePaymentToken(paymentMethod, signingKey, args, validation, clock);
      if (!verification.ok) {
        const result = referenceFailure(verification.reason);
        captures.set(args.idempotencyKey, result);
        return cloneResult(result);
      }
      const referenceId = shortHash(
        paymentMethod,
        String(args.amount),
        args.currency,
        args.idempotencyKey
      );
      const result: PspCaptureResult = {
        ok: true,
        psp_payment_id: `psp_reference_${referenceId}`,
        psp_charge_id: `charge_reference_${referenceId}`,
        psp_charge_status: "succeeded",
        status: "captured"
      };
      captures.set(args.idempotencyKey, result);
      return cloneResult(result);
    },
    async cancel(args) {
      if (!args.psp_payment_id) throw new PspConfigError("psp_payment_id is required");
      if (!args.idempotencyKey) throw new PspConfigError("idempotencyKey is required");
    }
  };
}

function mockCapabilities(handlerIds: readonly string[] | undefined): readonly PaymentCapability[] {
  return (handlerIds ?? []).map((handlerId) => ({
    handlerId,
    instrumentType: "vault_token",
    idPrefix: "vt_"
  }));
}

type ReferenceTokenVerification =
  | { ok: true; payload: ReferenceTokenPayload }
  | { ok: false; reason: ReferenceTokenFailureReason };

type ReferenceTokenFailureReason =
  | "reference_token_shape_invalid"
  | "reference_token_signature_invalid"
  | "reference_token_expired"
  | "reference_token_merchant_mismatch"
  | "reference_token_checkout_mismatch"
  | "reference_token_transaction_mismatch"
  | "reference_token_amount_mismatch"
  | "reference_token_currency_mismatch"
  | "reference_token_handler_mismatch"
  | "reference_token_instrument_mismatch";

interface ReferenceTokenPayload {
  merchant_id: string;
  checkout_id: string;
  transaction_id: string;
  amount: number;
  currency: string;
  handler_id: string;
  instrument_type: string;
  exp: number;
}

async function verifyReferencePaymentToken(
  token: string,
  signingKey: EcJwk,
  args: PspCaptureArgs,
  validation: CaptureValidation,
  clock: () => Date
): Promise<ReferenceTokenVerification> {
  const compact = token.startsWith(REFERENCE_PAYMENT_TOKEN_PREFIX)
    ? token.slice(REFERENCE_PAYMENT_TOKEN_PREFIX.length)
    : "";
  const parts = compact.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, reason: "reference_token_shape_invalid" };
  }
  const payloadBytes = base64urlBytes(parts[1]!);
  if (!payloadBytes) return { ok: false, reason: "reference_token_shape_invalid" };
  const payload = referencePayload(payloadBytes);
  if (!payload) return { ok: false, reason: "reference_token_shape_invalid" };
  const verified = await verifyDetachedJws({
    jws: `${parts[0]}..${parts[2]}`,
    payload: payloadBytes,
    resolveKey: async (kid, alg) => kid === signingKey.kid && alg === algorithmForReferenceKey(signingKey)
      ? publicReferenceKey(signingKey)
      : null
  });
  if (!verified.ok) return { ok: false, reason: "reference_token_signature_invalid" };

  const expectedTransactionId = args.payment_mandate?.payment_intent.transaction_id ?? args.session_id;
  const now = Math.floor(clock().getTime() / 1000);
  if (payload.exp <= now) return { ok: false, reason: "reference_token_expired" };
  if (payload.merchant_id !== args.merchant_id) return { ok: false, reason: "reference_token_merchant_mismatch" };
  if (payload.checkout_id !== args.session_id) return { ok: false, reason: "reference_token_checkout_mismatch" };
  if (payload.transaction_id !== expectedTransactionId) return { ok: false, reason: "reference_token_transaction_mismatch" };
  if (payload.amount !== args.amount) return { ok: false, reason: "reference_token_amount_mismatch" };
  if (payload.currency !== args.currency) return { ok: false, reason: "reference_token_currency_mismatch" };
  if (payload.handler_id !== args.handler_id) return { ok: false, reason: "reference_token_handler_mismatch" };
  if (payload.instrument_type !== args.instrument_type) return { ok: false, reason: "reference_token_instrument_mismatch" };

  const mandateInstrument = stringValue(asRecord(validation.paymentMandateClaims?.payment_instrument).type, "");
  if (mandateInstrument && payload.instrument_type !== mandateInstrument) {
    return { ok: false, reason: "reference_token_instrument_mismatch" };
  }
  return { ok: true, payload };
}

function referenceFailure(reason: ReferenceTokenFailureReason): PspCaptureResult {
  return {
    ok: false,
    reason: reason === "reference_token_expired" ? "expired" : "other",
    detail: reason,
    message: `reference PSP token rejected: ${reason}`
  };
}

function referencePayload(bytes: Uint8Array): ReferenceTokenPayload | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const record = asRecord(value);
    const payload = {
      merchant_id: stringValue(record.merchant_id, ""),
      checkout_id: stringValue(record.checkout_id, ""),
      transaction_id: stringValue(record.transaction_id, ""),
      amount: record.amount,
      currency: stringValue(record.currency, ""),
      handler_id: stringValue(record.handler_id, ""),
      instrument_type: stringValue(record.instrument_type, ""),
      exp: record.exp
    };
    if (
      !payload.merchant_id ||
      !payload.checkout_id ||
      !payload.transaction_id ||
      !Number.isSafeInteger(payload.amount) ||
      !/^[A-Z]{3}$/.test(payload.currency) ||
      !payload.handler_id ||
      !payload.instrument_type ||
      !Number.isSafeInteger(payload.exp)
    ) {
      return null;
    }
    return payload as ReferenceTokenPayload;
  } catch {
    return null;
  }
}

function validReferenceKey(value: EcJwk): EcJwk & { kid: string } {
  const key = assertValidEcJwk(value);
  if (!key.kid) throw new PspConfigError("referencePsp signingKey.kid is required");
  return key as EcJwk & { kid: string };
}

function publicReferenceKey(key: EcJwk): EcJwk {
  const { d: _d, ...publicKey } = key;
  return publicKey;
}

function algorithmForReferenceKey(key: EcJwk): HmsAlgorithm {
  if (key.alg === "ES256" || key.alg === "ES384") return key.alg;
  if (key.crv === "P-256") return "ES256";
  if (key.crv === "P-384") return "ES384";
  throw new PspConfigError(`unsupported referencePsp signingKey.crv: ${key.crv}`);
}

function base64urlBytes(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function assertReferenceAllowed(opts: ReferencePspOptions): void {
  const isKnownTest = !!process.env.VITEST || !!process.env.JEST_WORKER_ID || !!process.env.STEELYARD_TEST;
  const bothOptIns = opts.allowInProduction === true && process.env.STEELYARD_ALLOW_REFERENCE_PSP === "1";
  if (!isKnownTest && !bothOptIns) throw new ReferencePspInProductionError();
}

function assertMockAllowed(opts: MockPspOptions): void {
  const isKnownTest = !!process.env.VITEST || !!process.env.JEST_WORKER_ID || !!process.env.STEELYARD_TEST;
  const bothOptIns = opts.allowInProduction === true && process.env.STEELYARD_ALLOW_MOCK_PSP === "1";
  if (!isKnownTest && !bothOptIns) throw new MockInProductionError();
}

function mockFailure(failOn: MockPspFailMode | undefined, args: PspCaptureArgs): PspCaptureResult | undefined {
  if (!failOn) return undefined;
  if (typeof failOn === "function") return failOn(args);
  if (failOn === "requires_authentication") {
    return {
      ok: false,
      requires_authentication: true,
      continue_url: `https://mock.steelyard.local/auth/${encodeURIComponent(args.idempotencyKey)}`
    };
  }
  return { ok: false, reason: failOn, message: `mock PSP ${failOn}` };
}

interface CaptureValidation {
  paymentMandateClaims?: Record<string, unknown>;
}

async function validateCaptureArgs(
  args: PspCaptureArgs,
  clock: () => Date,
  capabilities: readonly PaymentCapability[]
): Promise<CaptureValidation> {
  if (!args.vault_token) throw new PspConfigError("vault_token is required");
  if (!Number.isInteger(args.amount) || args.amount < 0) throw new PspConfigError("amount must be a non-negative integer");
  if (!/^[A-Z]{3}$/.test(args.currency)) throw new PspConfigError("currency must be ISO 4217 uppercase");
  if (!args.idempotencyKey) throw new PspConfigError("idempotencyKey is required");
  if (!args.session_id) throw new PspConfigError("session_id is required");
  if (!args.merchant_id) throw new PspConfigError("merchant_id is required");
  if (args.payment_mandate) {
    const verified = await verifyAp2PaymentMandate({
      mandate: args.payment_mandate,
      expectedHandlerId: args.handler_id,
      clock,
      capabilities
    });
    if (!verified.ok) throw new PspConfigError(`payment_mandate invalid: ${verified.reason}`);
    return { paymentMandateClaims: verified.claims };
  }
  return {};
}

function pspPaymentMethod(args: PspCaptureArgs, validation: CaptureValidation): string {
  const paymentInstrument = asRecord(validation.paymentMandateClaims?.payment_instrument);
  const id = paymentInstrument.id;
  return typeof id === "string" && id ? id : args.vault_token;
}

function stripeCaptureBody(args: PspCaptureArgs, paymentMethod: string): URLSearchParams {
  const body = new URLSearchParams();
  body.set("amount", String(args.amount));
  body.set("currency", args.currency.toLowerCase());
  body.set("payment_method", paymentMethod);
  body.set("confirm", "true");
  body.set("capture_method", "automatic");
  body.set("metadata[source]", "steelyard");
  body.set("metadata[session_id]", args.session_id);
  body.set("metadata[merchant_id]", args.merchant_id);
  for (const [key, value] of Object.entries(args.metadata)) {
    body.set(`metadata[${key}]`, value);
  }
  return body;
}

function stripeCaptureResult(payload: unknown): PspCaptureResult {
  const record = asRecord(payload);
  const id = stringValue(record.id, "stripe_payment_intent");
  const status = stringValue(record.status, "");
  if (status === "succeeded") return { ok: true, psp_payment_id: id, status: "captured" };
  if (status === "requires_capture") return { ok: true, psp_payment_id: id, status: "authorized" };
  if (status === "requires_action") {
    const continueUrl = stringValue(asRecord(asRecord(record.next_action).redirect_to_url).url, "");
    return { ok: false, requires_authentication: true, continue_url: continueUrl || "about:blank" };
  }
  return { ok: false, reason: "other", message: `Stripe returned status ${status || "unknown"}` };
}

function stripeFailure(payload: unknown): PspCaptureResult {
  const error = asRecord(asRecord(payload).error);
  const code = stringValue(error.code, "");
  const message = stringValue(error.message, "Stripe payment failed");
  if (code === "card_declined") return { ok: false, reason: "declined", message };
  if (code === "expired_card") return { ok: false, reason: "expired_card", message };
  if (code === "insufficient_funds") return { ok: false, reason: "insufficient_funds", message };
  return { ok: false, reason: "other", message };
}

function neutralStripeResult(result: Awaited<ReturnType<typeof chargeSharedPaymentToken>>): PspCaptureResult {
  if (result.ok || "requires_authentication" in result) return result;
  switch (result.reason) {
    case "spt_expired":
      return { ok: false, reason: "expired", detail: result.reason, message: result.message };
    case "amount_exceeded":
      return { ok: false, reason: "limit_exceeded", detail: result.reason, message: result.message };
    case "spt_revoked":
      return { ok: false, reason: "revoked", detail: result.reason, message: result.message };
    case "spt_seller_mismatch":
      return { ok: false, reason: "seller_mismatch", detail: result.reason, message: result.message };
    case "declined":
    case "fraud":
    case "insufficient_funds":
    case "expired_card":
    case "other":
      return { ok: false, reason: result.reason, message: result.message };
  }
}

function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

function cloneResult<T extends PspCaptureResult>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
