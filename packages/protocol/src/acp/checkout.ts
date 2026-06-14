// Copyright (c) Steelyard contributors. MIT License.
import type { Manifest } from "@steelyard/core";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import acpCheckoutSchema from "../../spec/acp/2026-04-17/json-schema/schema.agentic_checkout.json";

export type JsonObject = Record<string, unknown>;
export type CheckoutSessionCreateRequest = JsonObject;
export type CheckoutSessionUpdateRequest = JsonObject;
export type CheckoutSessionCompleteRequest = JsonObject;
export type CancelSessionRequest = JsonObject;
export type DiscountsRequest = { codes?: string[] };
export type DiscountsResponse = { codes: string[]; applied: unknown[]; rejected: unknown[] };
export type CheckoutSession = JsonObject;
export type CheckoutSessionWithOrder = JsonObject;

export type PspCaptureResult =
  | { ok: true; psp_payment_id: string; status: "captured" | "authorized" }
  | { ok: false; reason: "declined" | "fraud" | "insufficient_funds" | "expired_card" | "other"; message: string }
  | { ok: false; requires_authentication: true; continue_url: string };

export interface AcpValidationResult {
  valid: boolean;
  errors: ErrorObject[] | null | undefined;
}

const ACP_CHECKOUT_SCHEMA_ID = "https://example.com/schemas/agentic-checkout/bundle.schema.json";
const ACP_VERSION = "2026-04-17";

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

function checkoutSession(opts: {
  id: string;
  status: string;
  currency: string;
  line_items: unknown;
  totals: unknown[];
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

function totalsFromLineItems(lineItems: unknown): unknown[] {
  const total = Array.isArray(lineItems)
    ? lineItems.reduce((sum, item) => sum + totalFromLineItem(item), 0)
    : 0;
  return [{ type: "total", display_text: "Total", amount: total }];
}

function responseLineItems(items: unknown): unknown[] {
  if (!Array.isArray(items)) return [];
  return items.map((value, index) => {
    const item = asRecord(value);
    const itemId = stringValue(item.id, `item_${index + 1}`);
    const amount = integerValue(item.unit_amount, 0);
    return {
      id: itemId,
      item,
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
