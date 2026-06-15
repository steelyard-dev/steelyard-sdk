// Copyright (c) Steelyard contributors. MIT License.
import { createHash } from "node:crypto";
import { SDJwtInstance } from "@sd-jwt/core";
import {
  assertValidEcJwk,
  defaultClock,
  ecdsaVerifyRaw,
  type EcJwk,
  type HmsAlgorithm
} from "@steelyard/core";
import { parseSdJwtKbPresentation } from "../mandate/ap2-verifier.js";

export interface PspPaymentIntent {
  amount: number;
  currency: string;
  checkout_id: string;
  expires_at: string;
  transaction_id?: string;
}

export interface PspPaymentMandate {
  format: "ap2-sd-jwt-kb";
  payload: string;
  holder_jwk: EcJwk;
  payment_intent: PspPaymentIntent;
}

export interface PspCaptureArgs {
  vault_token: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
  session_id: string;
  merchant_id: string;
  handler_id?: string;
  payment_mandate?: PspPaymentMandate;
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
  clock?: () => Date;
}

export interface StripePspOptions {
  apiKey: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  handlerIds?: readonly string[];
  clock?: () => Date;
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
  const clock = defaultClock(opts.clock);
  return {
    name: "mock",
    supportsHandler: (handlerId) => handlerIds.size === 0 || handlerIds.has(handlerId),
    async capture(args) {
      const validation = await validateCaptureArgs(args, clock);
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
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new PspConfigError("stripePsp requires fetch support");
  const apiBaseUrl = (opts.apiBaseUrl ?? "https://api.stripe.com").replace(/\/+$/, "");
  const handlerIds = new Set(opts.handlerIds ?? ["stripe"]);
  const clock = defaultClock(opts.clock);
  return {
    name: "stripe",
    supportsHandler: (handlerId) => handlerIds.has(handlerId),
    async capture(args) {
      const validation = await validateCaptureArgs(args, clock);
      try {
        const response = await fetchImpl(`${apiBaseUrl}/v1/payment_intents`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": args.idempotencyKey
          },
          body: stripeCaptureBody(args, validation)
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

interface CaptureValidation {
  paymentMandateClaims?: Record<string, unknown>;
}

async function validateCaptureArgs(args: PspCaptureArgs, clock: () => Date): Promise<CaptureValidation> {
  if (!args.vault_token) throw new PspConfigError("vault_token is required");
  if (!Number.isInteger(args.amount) || args.amount < 0) throw new PspConfigError("amount must be a non-negative integer");
  if (!/^[A-Z]{3}$/.test(args.currency)) throw new PspConfigError("currency must be ISO 4217 uppercase");
  if (!args.idempotencyKey) throw new PspConfigError("idempotencyKey is required");
  if (!args.session_id) throw new PspConfigError("session_id is required");
  if (!args.merchant_id) throw new PspConfigError("merchant_id is required");
  if (args.payment_mandate) {
    const verified = await verifyAp2PaymentMandate(args.payment_mandate, clock);
    if (!verified.ok) throw new PspConfigError(`payment_mandate invalid: ${verified.reason}`);
    return { paymentMandateClaims: verified.claims };
  }
  return {};
}

type PaymentMandateVerificationResult =
  | { ok: true; claims: Record<string, unknown> }
  | {
      ok: false;
      reason:
        | "shape_invalid"
        | "issuer_header_invalid"
        | "issuer_signature_invalid"
        | "holder_key_invalid"
        | "claims_invalid"
        | "kb_header_invalid"
        | "kb_signature_invalid"
        | "sd_hash_mismatch"
        | "iat_in_future"
        | "expired"
        | "transaction_mismatch"
        | "amount_mismatch"
        | "currency_mismatch";
    };

async function verifyAp2PaymentMandate(
  mandate: PspPaymentMandate,
  clock: () => Date
): Promise<PaymentMandateVerificationResult> {
  if ((mandate as { format?: string }).format !== "ap2-sd-jwt-kb" || !mandate.payload) {
    return { ok: false, reason: "shape_invalid" };
  }
  const parsed = parseSdJwtKbPresentation(mandate.payload);
  if (!parsed.ok) return { ok: false, reason: "shape_invalid" };
  const issuerJwt = decodeCompactJws(parsed.sdJwt);
  const kbJwt = decodeCompactJws(parsed.kbJwt);
  if (!issuerJwt || !kbJwt) return { ok: false, reason: "shape_invalid" };
  const holderKey = validHolderKey(mandate.holder_jwk);
  if (!holderKey) return { ok: false, reason: "holder_key_invalid" };
  const issuerAlg = hmsAlgorithm(issuerJwt.header.alg);
  const issuerKid = typeof issuerJwt.header.kid === "string" ? issuerJwt.header.kid : "";
  if (issuerJwt.header.typ !== "dc+sd-jwt" || !issuerAlg || issuerKid !== holderKey.kid) {
    return { ok: false, reason: "issuer_header_invalid" };
  }
  if (!(await verifyJwsSignature(issuerJwt, issuerAlg, holderKey))) {
    return { ok: false, reason: "issuer_signature_invalid" };
  }
  const claims = await unpackClaims(mandate.payload);
  if (!claims) return { ok: false, reason: "claims_invalid" };

  const kbAlg = hmsAlgorithm(kbJwt.header.alg);
  if (kbJwt.header.typ !== "kb+jwt" || !kbAlg) return { ok: false, reason: "kb_header_invalid" };
  if (!(await verifyJwsSignature(kbJwt, kbAlg, holderKey))) {
    return { ok: false, reason: "kb_signature_invalid" };
  }
  if (kbJwt.payload.sd_hash !== sdHash(parsed)) return { ok: false, reason: "sd_hash_mismatch" };

  const now = Math.floor(clock().getTime() / 1000);
  if (!validNumber(kbJwt.payload.iat) || kbJwt.payload.iat > now) return { ok: false, reason: "iat_in_future" };
  if (!validNumber(claims.exp) || claims.exp <= now) return { ok: false, reason: "expired" };
  if (claims.vct !== "mandate.payment.1") return { ok: false, reason: "claims_invalid" };

  const intent = mandate.payment_intent;
  if (!intent?.transaction_id || claims.transaction_id !== intent.transaction_id) {
    return { ok: false, reason: "transaction_mismatch" };
  }
  const amount = asRecord(claims.payment_amount);
  if (amount.amount !== intent.amount) return { ok: false, reason: "amount_mismatch" };
  if (amount.currency !== intent.currency) return { ok: false, reason: "currency_mismatch" };
  if (Date.parse(intent.expires_at) <= clock().getTime()) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

interface DecodedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Uint8Array;
  signingInput: string;
}

function decodeCompactJws(value: string): DecodedJws | null {
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (!isRecord(header) || !isRecord(payload)) return null;
    return {
      header,
      payload,
      signature: Buffer.from(parts[2], "base64url"),
      signingInput: `${parts[0]}.${parts[1]}`
    };
  } catch {
    return null;
  }
}

async function verifyJwsSignature(jws: DecodedJws, alg: HmsAlgorithm, key: EcJwk): Promise<boolean> {
  try {
    return await ecdsaVerifyRaw({
      algorithm: alg,
      publicKeyJwk: key,
      data: Buffer.from(jws.signingInput, "utf8"),
      signature: jws.signature
    });
  } catch {
    return false;
  }
}

async function unpackClaims(value: string): Promise<Record<string, unknown> | null> {
  try {
    const sdJwt = new SDJwtInstance<Record<string, unknown>>({
      hasher: sha256Hasher,
      hashAlg: "sha-256"
    });
    const claims = await sdJwt.getClaims(value);
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

function sdHash(parsed: { sdJwt: string; disclosures: string[] }): string {
  const input = `${parsed.sdJwt}~${parsed.disclosures.map((disclosure) => `${disclosure}~`).join("")}`;
  return createHash("sha256").update(Buffer.from(input, "utf8")).digest("base64url");
}

async function sha256Hasher(data: string | ArrayBuffer, alg: string): Promise<Uint8Array> {
  const normalized = alg.toLowerCase();
  if (normalized !== "sha-256" && normalized !== "sha256") {
    throw new Error(`unsupported SD-JWT hash algorithm: ${alg}`);
  }
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return createHash("sha256").update(bytes).digest();
}

function validHolderKey(value: EcJwk): EcJwk | null {
  try {
    return assertValidEcJwk(value);
  } catch {
    return null;
  }
}

function hmsAlgorithm(value: unknown): HmsAlgorithm | null {
  return value === "ES256" || value === "ES384" ? value : null;
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function pspPaymentMethod(args: PspCaptureArgs, validation: CaptureValidation): string {
  const paymentInstrument = asRecord(validation.paymentMandateClaims?.payment_instrument);
  const id = paymentInstrument.id;
  return typeof id === "string" && id ? id : args.vault_token;
}

function stripeCaptureBody(args: PspCaptureArgs, validation: CaptureValidation): URLSearchParams {
  const body = new URLSearchParams();
  body.set("amount", String(args.amount));
  body.set("currency", args.currency.toLowerCase());
  body.set("payment_method", pspPaymentMethod(args, validation));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
