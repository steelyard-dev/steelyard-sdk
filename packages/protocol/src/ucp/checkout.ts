// Copyright (c) Steelyard contributors. MIT License.
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import checkoutBaseSchema from "../../spec/ucp/2026-04-17/schemas/shopping/checkout.json";
import cartBaseSchema from "../../spec/ucp/2026-04-17/schemas/shopping/cart.json";
import {
  ALL_SCHEMAS,
  CHECKOUT_SCHEMA_ID,
  PAYMENT_INSTRUMENT_SCHEMA_ID
} from "./spec-schemas.js";

export type JsonSchema = Record<string, unknown> & {
  $id?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};
export type UcpRequestOperation = "create" | "update" | "complete";
export type Checkout = Record<string, unknown>;
export type OrderConfirmation = { id: string; label?: string; permalink_url: string };
export type CompletedUcpCheckout = Checkout & { status: "completed"; order: OrderConfirmation };
export type SelectedPaymentInstrument = {
  id: string;
  handler_id: string;
  type: string;
  credential?: unknown;
  selected?: boolean;
};
export type UcpValidationResult = {
  valid: boolean;
  errors: ErrorObject[] | null | undefined;
};

export type PspCaptureResult =
  | { ok: true; psp_payment_id: string; status: "captured" | "authorized" }
  | { ok: false; reason: "declined" | "fraud" | "insufficient_funds" | "expired_card" | "other"; message: string }
  | { ok: false; requires_authentication: true; continue_url: string };

const UCP_VERSION = "2026-04-17";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const schema of ALL_SCHEMAS) {
  ajv.addSchema(schema);
}
const schemaRegistry = buildSchemaRegistry(ALL_SCHEMAS as readonly JsonSchema[]);

export const requestCreateSchema = deriveRequestSchema(checkoutBaseSchema as JsonSchema, "create");
export const requestUpdateSchema = deriveRequestSchema(checkoutBaseSchema as JsonSchema, "update");
export const requestCompleteSchema = deriveRequestSchema(checkoutBaseSchema as JsonSchema, "complete");
export const cartCreateRequestSchema = deriveRequestSchema(cartBaseSchema as JsonSchema, "create");
export const cartUpdateRequestSchema = deriveRequestSchema(cartBaseSchema as JsonSchema, "update");

const validateCreateRequestFn = ajv.compile<Partial<Checkout>>(requestCreateSchema);
const validateUpdateRequestFn = ajv.compile<Partial<Checkout>>(requestUpdateSchema);
const validateCompleteRequestFn = ajv.compile<Partial<Checkout>>(requestCompleteSchema);
const validateCheckoutFn = loadValidator<Checkout>(CHECKOUT_SCHEMA_ID, "checkout");
const validateSelectedPaymentInstrumentFn = loadValidator<SelectedPaymentInstrument>(
  `${PAYMENT_INSTRUMENT_SCHEMA_ID}#/$defs/selected_payment_instrument`,
  "selected_payment_instrument"
);

export function deriveRequestSchema(base: JsonSchema, op: UcpRequestOperation): JsonSchema {
  return {
    ...deriveSchema(base, op, base.$id, { root: true }),
    $id: requestSchemaId(base, op),
    additionalProperties: true
  };
}

export function applyUcpCreate(
  req: Partial<Checkout>,
  ctx: { now: Date; checkoutId: string; currency: string; links?: unknown[] }
): { next: Checkout; response: Checkout } {
  assertValidUcpCreateRequest(req);
  const lineItems = responseLineItems(req.line_items);
  const checkout = checkoutResponse({
    id: ctx.checkoutId,
    status: "ready_for_complete",
    line_items: lineItems,
    currency: ctx.currency,
    totals: totalsFromLineItems(lineItems),
    links: ctx.links ?? defaultLinks(),
    payment: req.payment
  });
  assertValidUcpCheckout(checkout);
  return { next: checkout, response: checkout };
}

export function applyUcpUpdate(
  current: Checkout,
  req: Partial<Checkout>,
  _ctx: { now: Date }
): { next: Checkout; response: Checkout } {
  assertValidUcpCheckout(current);
  assertValidUcpUpdateRequest(req);
  const lineItems = req.line_items ? responseLineItems(req.line_items) : undefined;
  const next = {
    ...current,
    ...pickDefined(req, ["line_items", "buyer", "context", "signals", "attribution", "payment"])
  };
  if (lineItems) {
    next.line_items = lineItems;
    next.totals = totalsFromLineItems(lineItems);
  }
  assertValidUcpCheckout(next);
  return { next, response: next };
}

export function applyUcpComplete(
  current: Checkout,
  req: {
    payment: { instruments: SelectedPaymentInstrument[] };
    "steelyard.checkout_mandate"?: string;
  },
  ctx: {
    now: Date;
    mandateOk: { subject_id: string; key_id: string };
    pspResult: PspCaptureResult;
    orderId: string;
    permalinkUrl: string;
  }
): { next: CompletedUcpCheckout; response: CompletedUcpCheckout } {
  assertValidUcpCheckout(current);
  assertValidUcpCompleteRequest(req);
  if (!ctx.pspResult.ok) {
    throw new Error("UCP checkout completion requires a successful PSP capture result");
  }
  const instruments = req.payment.instruments;
  for (const instrument of instruments) assertValidSelectedPaymentInstrument(instrument);
  const next = {
    ...current,
    status: "completed",
    payment: req.payment,
    order: {
      id: ctx.orderId,
      permalink_url: ctx.permalinkUrl
    }
  } as CompletedUcpCheckout;
  assertValidUcpCheckout(next);
  return { next, response: next };
}

export function applyUcpCancel(current: Checkout, _ctx: { now: Date }): { next: Checkout; response: Checkout } {
  assertValidUcpCheckout(current);
  const next = { ...current, status: "canceled" };
  assertValidUcpCheckout(next);
  return { next, response: next };
}

export function validateUcpCreateRequest(value: unknown): UcpValidationResult {
  return validationResult(validateCreateRequestFn, value);
}

export function validateUcpUpdateRequest(value: unknown): UcpValidationResult {
  return validationResult(validateUpdateRequestFn, value);
}

export function validateUcpCompleteRequest(value: unknown): UcpValidationResult {
  return validationResult(validateCompleteRequestFn, value);
}

export function validateUcpCheckout(value: unknown): UcpValidationResult {
  return validationResult(validateCheckoutFn, value);
}

export function validateSelectedPaymentInstrument(value: unknown): UcpValidationResult {
  return validationResult(validateSelectedPaymentInstrumentFn, value);
}

export function assertValidUcpCreateRequest(value: unknown): asserts value is Partial<Checkout> {
  assertValid(validateCreateRequestFn, value, "UCP create checkout request");
}

export function assertValidUcpUpdateRequest(value: unknown): asserts value is Partial<Checkout> {
  assertValid(validateUpdateRequestFn, value, "UCP update checkout request");
}

export function assertValidUcpCompleteRequest(value: unknown): asserts value is Partial<Checkout> {
  assertValid(validateCompleteRequestFn, value, "UCP complete checkout request");
}

export function assertValidUcpCheckout(value: unknown): asserts value is Checkout {
  assertValid(validateCheckoutFn, value, "UCP checkout");
}

export function assertValidSelectedPaymentInstrument(value: unknown): asserts value is SelectedPaymentInstrument {
  assertValid(validateSelectedPaymentInstrumentFn, value, "UCP selected payment instrument");
}

function checkoutResponse(opts: {
  id: string;
  status: string;
  line_items: unknown;
  currency: string;
  totals: unknown[];
  links: unknown[];
  payment?: unknown;
}): Checkout {
  return {
    ucp: { version: UCP_VERSION, status: "success", payment_handlers: {} },
    id: opts.id,
    line_items: opts.line_items,
    status: opts.status,
    currency: opts.currency,
    totals: opts.totals,
    links: opts.links,
    ...(opts.payment ? { payment: opts.payment } : {})
  };
}

function requestDisposition(
  annotation: unknown,
  op: UcpRequestOperation
): "required" | "optional" | "omit" | undefined {
  if (annotation === "required" || annotation === "optional" || annotation === "omit") return annotation;
  if (annotation && typeof annotation === "object") {
    const value = (annotation as Record<string, unknown>)[op];
    if (value === "required" || value === "optional" || value === "omit") return value;
  }
  return undefined;
}

function deriveSchema(
  schema: JsonSchema,
  op: UcpRequestOperation,
  currentId: string | undefined,
  opts: { root?: boolean } = {}
): JsonSchema {
  const resolved = resolveReference(schema, currentId);
  const source = resolved.schema;
  const sourceId = resolved.id ?? currentId;
  const derived: JsonSchema = {};
  const omitted: string[] = [];
  const sourceRequired = new Set(source.required ?? []);

  for (const [key, value] of Object.entries(source)) {
    if (key === "$schema" || key === "$defs" || key === "ucp_request") continue;
    if (key === "$id") {
      if (opts.root) derived.$id = value as string;
      continue;
    }
    if (key === "properties" && isObjectRecord(value)) {
      const nextProperties: Record<string, JsonSchema> = {};
      const nextRequired: string[] = [];
      for (const [name, propertySchema] of Object.entries(value)) {
        const disposition = requestDisposition(propertySchema.ucp_request, op);
        if (disposition === "omit") {
          omitted.push(name);
          continue;
        }
        nextProperties[name] = deriveSchema(propertySchema, op, sourceId);
        if (disposition === "required" || (!disposition && sourceRequired.has(name))) {
          nextRequired.push(name);
        }
      }
      derived.properties = nextProperties;
      derived.required = nextRequired;
      continue;
    }
    if (key === "required") continue;
    if (key === "items" && isJsonSchema(value)) {
      derived.items = deriveSchema(value, op, sourceId);
      continue;
    }
    if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      derived[key] = value.map((item) =>
        isJsonSchema(item) ? deriveSchema(item, op, sourceId) : stripRequestAnnotations(item)
      );
      continue;
    }
    if ((key === "not" || key === "if" || key === "then" || key === "else") && isJsonSchema(value)) {
      derived[key] = deriveSchema(value, op, sourceId);
      continue;
    }
    derived[key] = stripRequestAnnotations(value);
  }

  if (omitted.length) addOmittedPropertyGuard(derived, omitted);
  return derived;
}

function resolveReference(schema: JsonSchema, currentId: string | undefined): { schema: JsonSchema; id?: string } {
  if (typeof schema.$ref !== "string") return { schema, id: schema.$id ?? currentId };
  const resolved = lookupSchemaRef(schema.$ref, currentId);
  if (!resolved) return { schema, id: currentId };
  return resolved;
}

function lookupSchemaRef(ref: string, currentId: string | undefined): { schema: JsonSchema; id?: string } | undefined {
  const [path, fragment = ""] = ref.split("#");
  const baseId = path ? resolveSchemaId(path, currentId) : currentId;
  const root = baseId ? schemaRegistry.get(baseId) : undefined;
  if (!root) return undefined;
  const schema = fragment ? readJsonPointer(root, fragment) : root;
  if (!isJsonSchema(schema)) return undefined;
  return { schema, id: schema.$id ?? baseId };
}

function resolveSchemaId(path: string, currentId: string | undefined): string {
  if (/^https?:\/\//.test(path)) return path;
  if (currentId) return new URL(path, currentId).toString();
  return path;
}

function readJsonPointer(root: JsonSchema, fragment: string): unknown {
  if (!fragment || fragment === "/") return root;
  const pointer = fragment.startsWith("/") ? fragment : fragment.replace(/^\//, "");
  return pointer
    .split("/")
    .filter(Boolean)
    .reduce<unknown>((node, rawPart) => {
      if (!node || typeof node !== "object") return undefined;
      const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
      return (node as Record<string, unknown>)[part];
    }, root);
}

function addOmittedPropertyGuard(schema: JsonSchema, omitted: string[]): void {
  const guard = { not: { anyOf: omitted.map((name) => ({ required: [name] })) } };
  if (schema.not === undefined) {
    schema.not = guard.not;
    return;
  }
  schema.allOf = [...(Array.isArray(schema.allOf) ? schema.allOf : []), guard];
}

function buildSchemaRegistry(schemas: readonly JsonSchema[]): Map<string, JsonSchema> {
  const registry = new Map<string, JsonSchema>();
  for (const schema of schemas) {
    if (schema.$id) registry.set(schema.$id, schema);
  }
  return registry;
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isObjectRecord(value: unknown): value is Record<string, JsonSchema> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stripRequestAnnotations<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripRequestAnnotations) as T;
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "ucp_request") result[key] = stripRequestAnnotations(child);
  }
  return result as T;
}

function requestSchemaId(base: JsonSchema, op: UcpRequestOperation): string {
  const id = base.$id ?? "urn:steelyard:ucp:request";
  return `${id}?steelyard_request=${op}`;
}

function totalsFromLineItems(lineItems: unknown): unknown[] {
  const total = Array.isArray(lineItems)
    ? lineItems.reduce((sum, item) => sum + totalFromLineItem(item), 0)
    : 0;
  return [
    { type: "subtotal", display_text: "Subtotal", amount: total },
    { type: "total", display_text: "Total", amount: total }
  ];
}

function responseLineItems(lineItems: unknown): unknown[] {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map((value, index) => {
    const record = asRecord(value);
    const item = asRecord(record.item);
    const itemId = stringValue(item.id, `item_${index + 1}`);
    const quantity = integerValue(record.quantity, 1);
    const price = integerValue(item.price, 0);
    return {
      id: stringValue(record.id, `line_${index + 1}`),
      item: {
        id: itemId,
        title: stringValue(item.title, itemId),
        price
      },
      quantity,
      totals: Array.isArray(record.totals)
        ? record.totals
        : [{ type: "total", display_text: "Total", amount: price * quantity }]
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

function defaultLinks(): unknown[] {
  return [{ type: "privacy_policy", url: "https://example.com/privacy" }];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function integerValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function loadValidator<T>(schemaRef: string, label: string): ValidateFunction<T> {
  const validator = ajv.getSchema(schemaRef) as ValidateFunction<T> | undefined;
  if (!validator) throw new Error(`Unable to load UCP ${label} validator at ${schemaRef}`);
  return validator;
}

function validationResult(validate: ValidateFunction, value: unknown): UcpValidationResult {
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
