// Copyright (c) Steelyard contributors. MIT License.
import type { Manifest } from "@steelyard/core";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import acpCheckoutSchema from "../../spec/acp/2026-04-17/json-schema/schema.agentic_checkout.json";
import type {
  AcpCancelSessionRequest,
  AcpCheckoutSession,
  AcpCheckoutSessionCompleteRequest,
  AcpCheckoutSessionCreateRequest,
  AcpCheckoutSessionUpdateRequest,
  AcpCheckoutSessionWithOrder,
  AcpDiscoveryResponse as GeneratedAcpDiscoveryResponse,
  AcpDiscountsRequest,
  AcpDiscountsResponse
} from "./types.generated.js";

export type JsonObject = Record<string, unknown>;
export type CheckoutSessionCreateRequest = AcpCheckoutSessionCreateRequest;
export type CheckoutSessionUpdateRequest = AcpCheckoutSessionUpdateRequest;
export type CheckoutSessionCompleteRequest = AcpCheckoutSessionCompleteRequest;
export type CancelSessionRequest = AcpCancelSessionRequest;
export type DiscountsRequest = AcpDiscountsRequest;
export type DiscountsResponse = AcpDiscountsResponse;
export type CheckoutSession = AcpCheckoutSession;
export type CheckoutSessionWithOrder = AcpCheckoutSessionWithOrder;
export type AcpDiscoveryResponse = GeneratedAcpDiscoveryResponse;
export type {
  AcpCancelSessionRequest,
  AcpCheckoutSession,
  AcpCheckoutSessionCompleteRequest,
  AcpCheckoutSessionCreateRequest,
  AcpCheckoutSessionUpdateRequest,
  AcpCheckoutSessionWithOrder,
  AcpDiscountsRequest,
  AcpDiscountsResponse,
  AcpPaymentData,
  AcpPaymentHandler
} from "./types.generated.js";

export interface AcpDiscoveryOptions {
  apiBaseUrl: string;
  services?: AcpDiscoveryResponse["capabilities"]["services"];
  supportedCurrencies?: string[];
  supportedLocales?: string[];
  transports?: AcpDiscoveryResponse["transports"];
  documentationUrl?: string;
}

export type AcpWebhookSignatureErrorCode =
  | "acp_webhook_signature_missing"
  | "acp_webhook_signature_malformed"
  | "acp_webhook_signature_stale"
  | "acp_webhook_signature_invalid";

export type AcpWebhookSignatureVerificationResult =
  | { ok: true; timestamp: number; signature: string }
  | { ok: false; code: AcpWebhookSignatureErrorCode; message: string };

export type PspCaptureResult =
  | { ok: true; psp_payment_id: string; psp_charge_id?: string; psp_charge_status?: string; status: "captured" | "authorized" }
  | { ok: false; reason: "declined" | "fraud" | "insufficient_funds" | "expired_card" | "other"; message: string }
  | { ok: false; requires_authentication: true; continue_url: string };

export interface AcpValidationResult {
  valid: boolean;
  errors: ErrorObject[] | null | undefined;
}

const ACP_CHECKOUT_SCHEMA_ID = "https://example.com/schemas/agentic-checkout/bundle.schema.json";
export const ACP_VERSION = "2026-04-17";
export const ACP_API_VERSION_HEADER = "API-Version";
export const ACP_WEBHOOK_SIGNATURE_HEADER = "Merchant-Signature";
export const ACP_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(acpCheckoutSchema, ACP_CHECKOUT_SCHEMA_ID);

const validateCreateRequestFn = validator<CheckoutSessionCreateRequest>("CheckoutSessionCreateRequest");
const validateUpdateRequestFn = validator<CheckoutSessionUpdateRequest>("CheckoutSessionUpdateRequest");
const validateCompleteRequestFn = validator<CheckoutSessionCompleteRequest>("CheckoutSessionCompleteRequest");
const validateCancelRequestFn = validator<CancelSessionRequest>("CancelSessionRequest");
const validateDiscountsRequestFn = validator<DiscountsRequest>("DiscountsRequest");
const validateDiscountsResponseFn = validator<DiscountsResponse>("DiscountsResponse");
const validateCheckoutSessionFn = validator<CheckoutSession>("CheckoutSession");
const validateCheckoutSessionWithOrderFn = validator<CheckoutSessionWithOrder>("CheckoutSessionWithOrder");
const validateDiscoveryResponseFn = validator<AcpDiscoveryResponse>("DiscoveryResponse");

export function buildAcpDiscovery(opts: AcpDiscoveryOptions): AcpDiscoveryResponse {
  const doc: AcpDiscoveryResponse = {
    protocol: {
      name: "acp",
      version: ACP_VERSION,
      supported_versions: [ACP_VERSION],
      ...(opts.documentationUrl ? { documentation_url: opts.documentationUrl } : {})
    },
    api_base_url: opts.apiBaseUrl.replace(/\/$/, ""),
    transports: opts.transports ?? ["rest"],
    capabilities: {
      services: opts.services ?? ["checkout"],
      ...(opts.supportedCurrencies?.length ? { supported_currencies: opts.supportedCurrencies.map((currency) => currency.toLowerCase()) } : {}),
      ...(opts.supportedLocales?.length ? { supported_locales: opts.supportedLocales } : {})
    }
  };
  assertValidAcpDiscovery(doc);
  return doc;
}

export function applyCreateRequest(
  req: CheckoutSessionCreateRequest,
  ctx: { manifest: Manifest; now: Date; sessionId: string }
): { next: CheckoutSession; response: CheckoutSession } {
  assertValidCheckoutSessionCreateRequest(req);
  const lineItems = responseLineItems(req.line_items);
  const session = checkoutSession({
    id: ctx.sessionId,
    status: "ready_for_payment",
    currency: stringValue(req.currency, ctx.manifest.identity.currencies[0] ?? "USD"),
    line_items: lineItems,
    totals: totalsFromLineItems(lineItems),
    now: ctx.now
  });
  assertValidCheckoutSession(session);
  return { next: session, response: session };
}

export function applyUpdateRequest(
  current: CheckoutSession,
  req: CheckoutSessionUpdateRequest,
  ctx: { now: Date }
): { next: CheckoutSession; response: CheckoutSession } {
  assertValidCheckoutSession(current);
  assertValidCheckoutSessionUpdateRequest(req);
  const lineItems = req.line_items ? responseLineItems(req.line_items) : undefined;
  const next: CheckoutSession = {
    ...current,
    ...pickDefined(req, [
      "buyer",
      "fulfillment_details",
      "fulfillment_groups",
      "selected_fulfillment_options",
      "discounts"
    ]),
    updated_at: ctx.now.toISOString()
  };
  if (lineItems) {
    next.line_items = lineItems;
    next.totals = totalsFromLineItems(lineItems);
  }
  assertValidCheckoutSession(next);
  return { next, response: next };
}

export function applyCompleteRequest(
  current: CheckoutSession,
  req: CheckoutSessionCompleteRequest,
  ctx: { now: Date; pspResult: PspCaptureResult }
): { next: CheckoutSessionWithOrder; response: CheckoutSessionWithOrder } {
  assertValidCheckoutSession(current);
  assertValidCheckoutSessionCompleteRequest(req);
  if (!ctx.pspResult.ok) {
    throw new Error("ACP checkout completion requires a successful PSP capture result");
  }
  const id = stringValue(current.id, "checkout");
  const next = {
    ...current,
    status: "completed",
    updated_at: ctx.now.toISOString(),
    order: {
      id: `order_${id}`,
      checkout_session_id: id,
      permalink_url: `https://example.com/orders/${encodeURIComponent(id)}`,
      status: ctx.pspResult.status === "captured" ? "confirmed" : "created"
    }
  };
  assertValidCheckoutSessionWithOrder(next);
  return { next, response: next };
}

export function applyCancelRequest(
  current: CheckoutSession,
  req: CancelSessionRequest,
  ctx: { now: Date }
): { next: CheckoutSession; response: CheckoutSession } {
  assertValidCheckoutSession(current);
  assertValidCancelSessionRequest(req);
  const next = { ...current, status: "canceled", updated_at: ctx.now.toISOString() };
  assertValidCheckoutSession(next);
  return { next, response: next };
}

export function applyDiscountsRequest(_manifest: Manifest, req: DiscountsRequest): DiscountsResponse {
  assertValidDiscountsRequest(req);
  const codes = req.codes ?? [];
  const response: DiscountsResponse = {
    codes,
    applied: [],
    rejected: codes.map((code) => ({
      code,
      reason: "discount_code_invalid",
      message: "Discount code is not configured"
    }))
  };
  assertValidDiscountsResponse(response);
  return response;
}

export function validateCheckoutSessionCreateRequest(value: unknown): AcpValidationResult {
  return validationResult(validateCreateRequestFn, value);
}

export function validateCheckoutSessionUpdateRequest(value: unknown): AcpValidationResult {
  return validationResult(validateUpdateRequestFn, value);
}

export function validateCheckoutSessionCompleteRequest(value: unknown): AcpValidationResult {
  return validationResult(validateCompleteRequestFn, value);
}

export function validateCancelSessionRequest(value: unknown): AcpValidationResult {
  return validationResult(validateCancelRequestFn, value);
}

export function validateDiscountsRequest(value: unknown): AcpValidationResult {
  return validationResult(validateDiscountsRequestFn, value);
}

export function validateDiscountsResponse(value: unknown): AcpValidationResult {
  return validationResult(validateDiscountsResponseFn, value);
}

export function validateCheckoutSession(value: unknown): AcpValidationResult {
  return validationResult(validateCheckoutSessionFn, value);
}

export function validateCheckoutSessionWithOrder(value: unknown): AcpValidationResult {
  return validationResult(validateCheckoutSessionWithOrderFn, value);
}

export function validateAcpDiscovery(value: unknown): AcpValidationResult {
  return validationResult(validateDiscoveryResponseFn, value);
}

export function assertValidCheckoutSessionCreateRequest(value: unknown): asserts value is CheckoutSessionCreateRequest {
  assertValid(validateCreateRequestFn, value, "ACP CheckoutSessionCreateRequest");
}

export function assertValidCheckoutSessionUpdateRequest(value: unknown): asserts value is CheckoutSessionUpdateRequest {
  assertValid(validateUpdateRequestFn, value, "ACP CheckoutSessionUpdateRequest");
}

export function assertValidCheckoutSessionCompleteRequest(value: unknown): asserts value is CheckoutSessionCompleteRequest {
  assertValid(validateCompleteRequestFn, value, "ACP CheckoutSessionCompleteRequest");
}

export function assertValidCancelSessionRequest(value: unknown): asserts value is CancelSessionRequest {
  assertValid(validateCancelRequestFn, value, "ACP CancelSessionRequest");
}

export function assertValidDiscountsRequest(value: unknown): asserts value is DiscountsRequest {
  assertValid(validateDiscountsRequestFn, value, "ACP DiscountsRequest");
}

export function assertValidDiscountsResponse(value: unknown): asserts value is DiscountsResponse {
  assertValid(validateDiscountsResponseFn, value, "ACP DiscountsResponse");
}

export function assertValidCheckoutSession(value: unknown): asserts value is CheckoutSession {
  assertValid(validateCheckoutSessionFn, value, "ACP CheckoutSession");
}

export function assertValidCheckoutSessionWithOrder(value: unknown): asserts value is CheckoutSessionWithOrder {
  assertValid(validateCheckoutSessionWithOrderFn, value, "ACP CheckoutSessionWithOrder");
}

export function assertValidAcpDiscovery(value: unknown): asserts value is AcpDiscoveryResponse {
  assertValid(validateDiscoveryResponseFn, value, "ACP DiscoveryResponse");
}

export async function signAcpWebhook(args: {
  rawBody: string | Uint8Array;
  secret: string;
  timestamp?: number | Date;
}): Promise<string> {
  const timestamp = acpSignatureTimestamp(args.timestamp ?? new Date());
  const digest = await acpHmacHex(args.secret, signedWebhookPayload(timestamp, rawBodyBytes(args.rawBody)));
  return `t=${timestamp},v1=${digest}`;
}

export async function verifyAcpWebhookSignature(args: {
  rawBody: string | Uint8Array;
  secret: string;
  header: string | undefined;
  now?: Date;
  toleranceSeconds?: number;
}): Promise<AcpWebhookSignatureVerificationResult> {
  if (!args.header) {
    return { ok: false, code: "acp_webhook_signature_missing", message: "Missing Merchant-Signature header." };
  }
  const parsed = /^t=(\d+),v1=([a-fA-F0-9]{64})$/.exec(args.header.trim());
  if (!parsed) {
    return {
      ok: false,
      code: "acp_webhook_signature_malformed",
      message: "Merchant-Signature must be t=<timestamp>,v1=<64_hex>."
    };
  }

  const timestamp = Number(parsed[1]);
  const signature = parsed[2]!.toLowerCase();
  const now = Math.floor((args.now ?? new Date()).getTime() / 1000);
  const tolerance = args.toleranceSeconds ?? ACP_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) {
    return { ok: false, code: "acp_webhook_signature_stale", message: "Merchant-Signature timestamp is outside tolerance." };
  }

  const expected = await acpHmacHex(args.secret, signedWebhookPayload(timestamp, rawBodyBytes(args.rawBody)));
  if (!constantTimeEqualHex(signature, expected)) {
    return { ok: false, code: "acp_webhook_signature_invalid", message: "Merchant-Signature digest is invalid." };
  }
  return { ok: true, timestamp, signature };
}

function checkoutSession(opts: {
  id: string;
  status: CheckoutSession["status"];
  currency: string;
  line_items: CheckoutSession["line_items"];
  totals: CheckoutSession["totals"];
  now: Date;
}): CheckoutSession {
  return {
    id: opts.id,
    protocol: { version: ACP_VERSION },
    capabilities: {},
    status: opts.status,
    currency: opts.currency,
    line_items: opts.line_items,
    fulfillment_options: [],
    totals: opts.totals,
    messages: [],
    links: [],
    created_at: opts.now.toISOString(),
    updated_at: opts.now.toISOString()
  };
}

function totalsFromLineItems(lineItems: unknown): CheckoutSession["totals"] {
  const total = Array.isArray(lineItems)
    ? lineItems.reduce((sum, item) => sum + totalFromLineItem(item), 0)
    : 0;
  return [{ type: "total", display_text: "Total", amount: total }];
}

function responseLineItems(items: unknown): CheckoutSession["line_items"] {
  if (!Array.isArray(items)) return [];
  return items.map((value, index) => {
    const item = asRecord(value);
    const itemId = stringValue(item.id, `item_${index + 1}`);
    const normalizedItem = { ...item, id: itemId };
    const amount = integerValue(item.unit_amount, 0);
    return {
      id: itemId,
      item: normalizedItem,
      quantity: 1,
      totals: [{ type: "total", display_text: "Total", amount }]
    };
  });
}

function totalFromLineItem(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const totals = (value as { totals?: unknown }).totals;
  if (!Array.isArray(totals)) return 0;
  const total = totals.find(
    (item): item is { type?: unknown; amount?: unknown } =>
      !!item && typeof item === "object" && (item as { type?: unknown }).type === "total"
  );
  return typeof total?.amount === "number" ? total.amount : 0;
}

function pickDefined(source: JsonObject, keys: string[]): JsonObject {
  const result: JsonObject = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function integerValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function acpSignatureTimestamp(value: number | Date): number {
  return value instanceof Date ? Math.floor(value.getTime() / 1000) : value;
}

function rawBodyBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function signedWebhookPayload(timestamp: number, rawBody: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const payload = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  payload.set(prefix, 0);
  payload.set(rawBody, prefix.byteLength);
  return payload;
}

async function acpHmacHex(secret: string, payload: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await globalThis.crypto.subtle.sign("HMAC", key, payload);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function validator<T>(defName: string): ValidateFunction<T> {
  const validate = ajv.getSchema(`${ACP_CHECKOUT_SCHEMA_ID}#/$defs/${defName}`) as ValidateFunction<T> | undefined;
  if (!validate) throw new Error(`Unable to load ACP ${defName} schema`);
  return validate;
}

function validationResult(validate: ValidateFunction, value: unknown): AcpValidationResult {
  const valid = validate(value);
  return { valid, errors: validate.errors };
}

function assertValid<T>(validate: ValidateFunction<T>, value: unknown, label: string): asserts value is T {
  if (!validate(value)) {
    throw new Error(`${label} failed spec validation: ${formatErrors(validate.errors)}`);
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "(no AJV errors reported)";
  return ajv.errorsText(errors, { separator: "; " });
}
