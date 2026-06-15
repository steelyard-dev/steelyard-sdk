// Copyright (c) Steelyard contributors. MIT License.
import {
  STRIPE_API_BASE,
  STRIPE_API_VERSION,
  STRIPE_LIVE_DISABLED_CODE,
  STRIPE_LIVE_KEY_PREFIX,
  STRIPE_PM_ID_PREFIX,
  STRIPE_SPT_ID_PREFIX,
  STRIPE_TEST_KEY_PREFIX
} from "./constants.js";

export {
  STRIPE_API_BASE,
  STRIPE_API_VERSION,
  STRIPE_LIVE_DISABLED_CODE,
  STRIPE_LIVE_KEY_PREFIX,
  STRIPE_PM_ID_PREFIX,
  STRIPE_SPT_ID_PREFIX,
  STRIPE_TEST_KEY_PREFIX
} from "./constants.js";

export interface StripeUsageLimits {
  currency: string;
  maxAmount: number;
  expiresAt: Date | number | string;
}

export interface MintSharedPaymentTokenArgs {
  apiKey: string;
  paymentMethod: string;
  sellerProfile: string;
  usageLimits: StripeUsageLimits;
  apiVersion?: string;
  idempotencyKey: string;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
}

export interface SptMintResult {
  id: string;
  expires_at: number;
  max_amount: number;
  currency: string;
}

export interface ChargeSharedPaymentTokenArgs {
  apiKey: string;
  sptId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  apiVersion?: string;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
}

export type StripePspCaptureResult =
  | {
      ok: true;
      psp_payment_id: string;
      psp_charge_id?: string;
      psp_charge_status?: string;
      status: "captured" | "authorized";
    }
  | {
      ok: false;
      reason:
        | "declined"
        | "fraud"
        | "insufficient_funds"
        | "expired_card"
        | "spt_expired"
        | "amount_exceeded"
        | "spt_revoked"
        | "spt_seller_mismatch"
        | "other";
      message: string;
    }
  | { ok: false; requires_authentication: true; continue_url: string };

export class StripeLiveDisabledError extends Error {
  readonly code = STRIPE_LIVE_DISABLED_CODE;

  constructor(message = "v0.6 is test-only") {
    super(message);
    this.name = "StripeLiveDisabledError";
  }
}

export class StripeSptMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeSptMintError";
  }
}

export class StripeSptChargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeSptChargeError";
  }
}

export function assertStripeTestSecretKey(apiKey: string): void {
  if (apiKey.startsWith(STRIPE_LIVE_KEY_PREFIX)) {
    throw new StripeLiveDisabledError("v0.6 is test-only");
  }
  if (!apiKey.startsWith(STRIPE_TEST_KEY_PREFIX)) {
    throw new StripeLiveDisabledError("v0.6 requires an unrestricted Stripe Test secret key");
  }
}

export async function mintSharedPaymentToken(args: MintSharedPaymentTokenArgs): Promise<SptMintResult> {
  assertStripeTestSecretKey(args.apiKey);
  if (!args.paymentMethod.startsWith(STRIPE_PM_ID_PREFIX)) {
    throw new StripeSptMintError("paymentMethod must be a Stripe PaymentMethod id");
  }
  if (!args.sellerProfile) {
    throw new StripeSptMintError("sellerProfile is required");
  }
  if (!Number.isInteger(args.usageLimits.maxAmount) || args.usageLimits.maxAmount < 0) {
    throw new StripeSptMintError("usageLimits.maxAmount must be a non-negative integer");
  }
  const expiresAt = unixSeconds(args.usageLimits.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new StripeSptMintError("usageLimits.expiresAt must resolve to unix seconds");
  }
  if (!args.idempotencyKey) {
    throw new StripeSptMintError("idempotencyKey is required");
  }

  const fetchImpl = args.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new StripeSptMintError("fetch support is required");

  const body = new URLSearchParams();
  body.set("payment_method", args.paymentMethod);
  body.set("seller_details[network_business_profile]", args.sellerProfile);
  body.set("usage_limits[currency]", args.usageLimits.currency.toLowerCase());
  body.set("usage_limits[expires_at]", String(expiresAt));
  body.set("usage_limits[max_amount]", String(args.usageLimits.maxAmount));

  let response: Response;
  try {
    response = await fetchImpl(`${apiBase(args.apiBaseUrl)}/v1/shared_payment/issued_tokens`, {
      method: "POST",
      headers: stripeHeaders(args.apiKey, args.apiVersion, args.idempotencyKey),
      body
    });
  } catch (error) {
    throw new StripeSptMintError(redactSecret(errorMessage(error), args.apiKey));
  }

  const payload = await readStripePayload(response);
  if (!response.ok) {
    throw new StripeSptMintError(redactSecret(stripeErrorMessage(payload, response.status), args.apiKey));
  }

  const record = asRecord(payload);
  const id = stringValue(record.id);
  if (!id.startsWith(STRIPE_SPT_ID_PREFIX)) {
    throw new StripeSptMintError("Stripe SPT response did not include an spt_ id");
  }
  return {
    id,
    expires_at: integerValue(record.expires_at, expiresAt),
    max_amount: integerValue(record.max_amount, args.usageLimits.maxAmount),
    currency: stringValue(record.currency, args.usageLimits.currency).toUpperCase()
  };
}

export async function chargeSharedPaymentToken(args: ChargeSharedPaymentTokenArgs): Promise<StripePspCaptureResult> {
  assertStripeTestSecretKey(args.apiKey);
  if (!args.sptId.startsWith(STRIPE_SPT_ID_PREFIX)) {
    throw new StripeSptChargeError("sptId must be a Stripe Shared Payment Token id");
  }
  if (!Number.isInteger(args.amount) || args.amount < 0) {
    throw new StripeSptChargeError("amount must be a non-negative integer");
  }
  if (!/^[A-Z]{3}$/.test(args.currency)) {
    throw new StripeSptChargeError("currency must be ISO 4217 uppercase");
  }
  if (!args.idempotencyKey) {
    throw new StripeSptChargeError("idempotencyKey is required");
  }

  const fetchImpl = args.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new StripeSptChargeError("fetch support is required");

  const body = new URLSearchParams();
  body.set("amount", String(args.amount));
  body.set("currency", args.currency.toLowerCase());
  body.set("payment_method_data[shared_payment_granted_token]", args.sptId);
  body.set("confirm", "true");

  try {
    const response = await fetchImpl(`${apiBase(args.apiBaseUrl)}/v1/payment_intents`, {
      method: "POST",
      headers: stripeHeaders(args.apiKey, args.apiVersion, args.idempotencyKey),
      body
    });
    const payload = await readStripePayload(response);
    if (!response.ok) return stripeFailure(payload);
    return stripeCaptureResult(payload);
  } catch (error) {
    throw new StripeSptChargeError(redactSecret(errorMessage(error), args.apiKey));
  }
}

export function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[redacted]") : message;
}

function stripeHeaders(apiKey: string, apiVersion: string | undefined, idempotencyKey: string): Record<string, string> {
  return {
    Authorization: basicAuth(apiKey),
    "Stripe-Version": apiVersion ?? STRIPE_API_VERSION,
    "Idempotency-Key": idempotencyKey,
    "Content-Type": "application/x-www-form-urlencoded"
  };
}

function basicAuth(apiKey: string): string {
  const token = `${apiKey}:`;
  const encoded = typeof btoa === "function"
    ? btoa(token)
    : Buffer.from(token, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

function apiBase(value: string | undefined): string {
  return (value ?? STRIPE_API_BASE).replace(/\/+$/, "");
}

function unixSeconds(value: Date | number | string): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : Math.floor(parsed / 1000);
}

async function readStripePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function stripeCaptureResult(payload: unknown): StripePspCaptureResult {
  const record = asRecord(payload);
  const id = stringValue(record.id, "stripe_payment_intent");
  const status = stringValue(record.status, "");
  const charge = latestCharge(record);
  if (status === "succeeded") {
    return {
      ok: true,
      psp_payment_id: id,
      ...(charge.id ? { psp_charge_id: charge.id } : {}),
      ...(charge.status ? { psp_charge_status: charge.status } : {}),
      status: "captured"
    };
  }
  if (status === "requires_capture") {
    return {
      ok: true,
      psp_payment_id: id,
      ...(charge.id ? { psp_charge_id: charge.id } : {}),
      ...(charge.status ? { psp_charge_status: charge.status } : {}),
      status: "authorized"
    };
  }
  if (status === "requires_action") {
    const continueUrl = stringValue(asRecord(asRecord(record.next_action).redirect_to_url).url, "");
    return { ok: false, requires_authentication: true, continue_url: continueUrl || "about:blank" };
  }
  return { ok: false, reason: "other", message: `Stripe returned status ${status || "unknown"}` };
}

function stripeFailure(payload: unknown): StripePspCaptureResult {
  const error = asRecord(asRecord(payload).error);
  const code = stringValue(error.code, "");
  const message = stringValue(error.message, "Stripe payment failed");
  if (code === "card_declined") return { ok: false, reason: "declined", message };
  if (code === "expired_card") return { ok: false, reason: "expired_card", message };
  if (code === "insufficient_funds") return { ok: false, reason: "insufficient_funds", message };
  if (code === "requires_authentication") {
    const continueUrl = stringValue(
      asRecord(asRecord(asRecord(error.payment_intent).next_action).redirect_to_url).url,
      "about:blank"
    );
    return { ok: false, requires_authentication: true, continue_url: continueUrl };
  }
  if (code === "spt_expired") return { ok: false, reason: "spt_expired", message };
  if (code === "spt_max_amount_exceeded") return { ok: false, reason: "amount_exceeded", message };
  if (code === "spt_revoked") return { ok: false, reason: "spt_revoked", message };
  if (code === "spt_seller_mismatch") return { ok: false, reason: "spt_seller_mismatch", message };
  return { ok: false, reason: "other", message };
}

function latestCharge(record: Record<string, unknown>): { id?: string; status?: string } {
  const latest = record.latest_charge;
  if (typeof latest === "string" && latest) return { id: latest };
  const charges = asRecord(record.charges);
  const data = charges.data;
  const first = Array.isArray(data) ? asRecord(data[0]) : {};
  return {
    ...(typeof first.id === "string" ? { id: first.id } : {}),
    ...(typeof first.status === "string" ? { status: first.status } : {})
  };
}

function stripeErrorMessage(payload: unknown, status: number): string {
  const error = asRecord(asRecord(payload).error);
  const code = stringValue(error.code, "");
  const message = stringValue(error.message, "");
  return `Stripe SPT mint failed (${status})${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function integerValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
