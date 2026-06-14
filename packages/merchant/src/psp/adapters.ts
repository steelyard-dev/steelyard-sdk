// Copyright (c) Steelyard contributors. MIT License.
import { createHash } from "node:crypto";

export interface PspCaptureArgs {
  vault_token: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
  session_id: string;
  merchant_id: string;
  handler_id?: string;
}

export type PspCaptureResult =
  | { ok: true; psp_payment_id: string; status: "captured" | "authorized" }
  | { ok: false; reason: "declined" | "fraud" | "insufficient_funds" | "expired_card" | "other"; message: string }
  | { ok: false; requires_authentication: true; continue_url: string };

export interface PspAdapter {
  name: string;
  supportsHandler(handlerId: string): boolean;
  capture(args: PspCaptureArgs): Promise<PspCaptureResult>;
  cancel(args: { psp_payment_id: string; idempotencyKey: string }): Promise<void>;
}

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
}

export interface StripePspOptions {
  apiKey: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  handlerIds?: readonly string[];
}

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

export function mockPsp(opts: MockPspOptions = {}): PspAdapter {
  assertMockAllowed(opts);
  const handlerIds = new Set(opts.handlerIds ?? []);
  const captures = new Map<string, PspCaptureResult>();
  const seed = opts.seed ?? "steelyard-mock-psp";
  return {
    name: "mock",
    supportsHandler: (handlerId) => handlerIds.size === 0 || handlerIds.has(handlerId),
    async capture(args) {
      validateCaptureArgs(args);
      const cached = captures.get(args.idempotencyKey);
      if (cached) return cloneResult(cached);
      const failure = mockFailure(opts.failOn, args);
      if (failure) {
        captures.set(args.idempotencyKey, failure);
        return cloneResult(failure);
      }
      const result: PspCaptureResult = {
        ok: true,
        psp_payment_id: `psp_payment_${shortHash(seed, args.vault_token, String(args.amount), args.currency, args.idempotencyKey)}`,
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
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new PspConfigError("stripePsp requires fetch support");
  const apiBaseUrl = (opts.apiBaseUrl ?? "https://api.stripe.com").replace(/\/+$/, "");
  const handlerIds = new Set(opts.handlerIds ?? ["stripe"]);
  return {
    name: "stripe",
    supportsHandler: (handlerId) => handlerIds.has(handlerId),
    async capture(args) {
      validateCaptureArgs(args);
      try {
        const response = await fetchImpl(`${apiBaseUrl}/v1/payment_intents`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": args.idempotencyKey
          },
          body: stripeCaptureBody(args)
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

function validateCaptureArgs(args: PspCaptureArgs): void {
  if (!args.vault_token) throw new PspConfigError("vault_token is required");
  if (!Number.isInteger(args.amount) || args.amount < 0) throw new PspConfigError("amount must be a non-negative integer");
  if (!/^[A-Z]{3}$/.test(args.currency)) throw new PspConfigError("currency must be ISO 4217 uppercase");
  if (!args.idempotencyKey) throw new PspConfigError("idempotencyKey is required");
  if (!args.session_id) throw new PspConfigError("session_id is required");
  if (!args.merchant_id) throw new PspConfigError("merchant_id is required");
}

function stripeCaptureBody(args: PspCaptureArgs): URLSearchParams {
  const body = new URLSearchParams();
  body.set("amount", String(args.amount));
  body.set("currency", args.currency.toLowerCase());
  body.set("payment_method", args.vault_token);
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

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[redacted]") : message;
}
