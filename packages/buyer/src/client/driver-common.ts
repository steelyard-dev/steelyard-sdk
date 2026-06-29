// Copyright (c) Steelyard contributors. MIT License.
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalizeForSigning,
  redactCardData,
  systemClock,
  totalAmount,
  type BillingPayload,
  type Checkout,
  type PurchaseIntent,
  type RawCard,
  type Receipt,
  type Total,
  type WalletDriverPort
} from "@steelyard-dev/core";

export interface DriverBaseOpts {
  port: WalletDriverPort;
  idempotencyKey?: string;
  fetch?: typeof fetch;
  clock?: () => Date;
  onTotalsKnown?: (amount: number, currency: string) => Promise<void> | void;
  delegatePaymentUrl?: string;
  merchantId: string;
}

export interface PaymentHandlerLike {
  id: string;
  available_instruments?: unknown[];
  config?: Record<string, unknown>;
}

export type JsonRecord = Record<string, unknown>;
export type JsonRequestHeaderPreparer = (args: {
  method: "POST" | "PATCH";
  url: URL;
  headers: Record<string, string>;
  body: Uint8Array;
}) => Promise<Record<string, string>>;
export interface JsonHttpResponse {
  status: number;
  headers: Record<string, string>;
  rawBody: Uint8Array;
  body: unknown;
}

export function driverClock(opts: { clock?: () => Date }): () => Date {
  return opts.clock ?? systemClock;
}

export function purchaseKey(opts: { idempotencyKey?: string }, intent: PurchaseIntent): string {
  return opts.idempotencyKey ?? intent.intent_id ?? randomUUID();
}

export async function postJson(
  url: string,
  body: unknown,
  opts: {
    idempotencyKey: string;
    fetch?: typeof fetch;
    prepareHeaders?: JsonRequestHeaderPreparer;
  }
): Promise<unknown> {
  return (await postJsonResponse(url, body, opts)).body;
}

export async function postJsonResponse(
  url: string,
  body: unknown,
  opts: {
    idempotencyKey: string;
    fetch?: typeof fetch;
    prepareHeaders?: JsonRequestHeaderPreparer;
  }
): Promise<JsonHttpResponse> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const rawBody = JSON.stringify(body);
  const headers = await prepareJsonHeaders({
    method: "POST",
    url,
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "idempotency-key": opts.idempotencyKey
    },
    prepareHeaders: opts.prepareHeaders
  });
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: rawBody
  });
  const responseBody = await readResponseBody(response);
  const text = new TextDecoder().decode(responseBody);
  const parsed = text ? parseJson(text) : {};
  if (!response.ok) {
    throw new Error(redactCardData(`HTTP ${response.status} from ${url}: ${text}`));
  }
  return {
    status: response.status,
    headers: responseHeaders(response),
    rawBody: responseBody,
    body: parsed
  };
}

export async function patchJson(
  url: string,
  body: unknown,
  opts: {
    idempotencyKey: string;
    fetch?: typeof fetch;
    prepareHeaders?: JsonRequestHeaderPreparer;
  }
): Promise<unknown> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const rawBody = JSON.stringify(body);
  const headers = await prepareJsonHeaders({
    method: "PATCH",
    url,
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "idempotency-key": opts.idempotencyKey
    },
    prepareHeaders: opts.prepareHeaders
  });
  const response = await fetchImpl(url, {
    method: "PATCH",
    headers,
    body: rawBody
  });
  const text = await response.text();
  if (!response.ok) throw new Error(redactCardData(`HTTP ${response.status} from ${url}: ${text}`));
  return text ? parseJson(text) : {};
}

export function joinUrl(base: string | URL, path: string): string {
  const value = String(base).replace(/\/+$/, "");
  return `${value}${path.startsWith("/") ? path : `/${path}`}`;
}

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

export function checkoutTotals(checkout: JsonRecord): { amount: number; currency: string } {
  const amount = totalAmount((Array.isArray(checkout.totals) ? checkout.totals : []) as Total[]);
  return { amount, currency: stringValue(checkout.currency, "USD") };
}

export async function notifyTotals(
  opts: { onTotalsKnown?: (amount: number, currency: string) => Promise<void> | void },
  checkout: JsonRecord
): Promise<{ amount: number; currency: string }> {
  const totals = checkoutTotals(checkout);
  await opts.onTotalsKnown?.(totals.amount, totals.currency);
  return totals;
}

export async function delegateVaultToken(args: {
  delegatePaymentUrl: string;
  port: WalletDriverPort;
  amount: number;
  currency: string;
  checkoutId: string;
  merchantId: string;
  purchaseKey: string;
  riskSignals?: unknown[];
  fetch?: typeof fetch;
  clock: () => Date;
}): Promise<string> {
  return await args.port.withRawCard(async (card) => {
    const request = delegatePaymentRequest(card, args);
    const response = await postJson(args.delegatePaymentUrl, request, {
      idempotencyKey: `${args.purchaseKey}:delegate`,
      fetch: args.fetch
    });
    const id = stringValue(asRecord(response).id);
    if (!id) throw new Error("delegate payment response missing id");
    return id;
  });
}

export function delegatePaymentRequest(
  card: RawCard | ({ number: string; exp: string; name: string } & Partial<RawCard>),
  args: {
    amount: number;
    currency: string;
    checkoutId: string;
    merchantId: string;
    purchaseKey: string;
    riskSignals?: unknown[];
    clock: () => Date;
  }
): JsonRecord {
  const pan = stringValue("pan" in card ? card.pan : card.number);
  const parsed = parseExpiry(stringValue(card.exp));
  return {
    payment_method: {
      type: "card",
      card_number_type: "fpan",
      number: pan,
      exp_month: parsed.month,
      exp_year: parsed.year,
      name: stringValue("name_on_card" in card ? card.name_on_card : card.name),
      cvc: "cvc" in card ? card.cvc : undefined,
      iin: pan.slice(0, 6),
      display_last4: pan.slice(-4),
      display_brand: "brand" in card ? card.brand : "other",
      display_card_funding_type: "credit",
      metadata: { source: "steelyard" }
    },
    allowance: {
      reason: "one_time",
      max_amount: args.amount,
      currency: args.currency.toLowerCase(),
      checkout_session_id: args.checkoutId,
      merchant_id: args.merchantId,
      expires_at: new Date(args.clock().getTime() + 15 * 60_000).toISOString()
    },
    risk_signals: args.riskSignals ?? [],
    metadata: { source: "steelyard", purchase_key: args.purchaseKey }
  };
}

export function selectedHandler(
  handlers: PaymentHandlerLike[],
  explicitDelegatePaymentUrl?: string
): { handler: PaymentHandlerLike; delegatePaymentUrl: string } | undefined {
  const candidate = explicitDelegatePaymentUrl
    ? handlers[0]
    : handlers.find((handler) => typeof handler.config?.delegate_payment_url === "string");
  if (!candidate) return undefined;
  const delegatePaymentUrl = explicitDelegatePaymentUrl ?? stringValue(candidate.config?.delegate_payment_url);
  return delegatePaymentUrl ? { handler: candidate, delegatePaymentUrl } : undefined;
}

export function handlerSupportsInstrument(handler: PaymentHandlerLike, instrumentType: string): boolean {
  const instruments = handler.available_instruments;
  if (!Array.isArray(instruments)) return false;
  return instruments.map(asRecord).some((instrument) => stringValue(instrument.type) === instrumentType);
}

export function canonicalMandateCheckout(checkout: JsonRecord): unknown {
  return canonicalizeForSigning({
    id: checkout.id,
    line_items: checkout.line_items,
    totals: checkout.totals,
    currency: checkout.currency
  } as Checkout);
}

export function receiptBase(
  intent: PurchaseIntent,
  protocol: "acp" | "ucp",
  checkout: JsonRecord,
  clock: () => Date
): Pick<Receipt, "intent" | "protocol" | "charged_amount" | "charged_currency" | "created_at"> {
  const totals = checkoutTotals(checkout);
  return {
    intent,
    protocol,
    charged_amount: totals.amount,
    charged_currency: totals.currency,
    created_at: clock().toISOString()
  };
}

export function mandateId(jwt: string): string {
  return createHash("sha256").update(jwt).digest("hex").slice(0, 16);
}

export function billingBuyer(billing: BillingPayload): JsonRecord {
  return {
    name: billing.name,
    ...(billing.email ? { email: billing.email } : {}),
    address: billing.address
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON response: ${(error as Error).message}`);
  }
}

async function readResponseBody(response: Response): Promise<Uint8Array> {
  if (typeof response.arrayBuffer === "function") {
    return new Uint8Array(await response.arrayBuffer());
  }
  const text = await response.text();
  return new TextEncoder().encode(text);
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!response.headers) return headers;
  for (const [name, value] of response.headers.entries()) headers[name.toLowerCase()] = value;
  return headers;
}

async function prepareJsonHeaders(args: {
  method: "POST" | "PATCH";
  url: string;
  body: string;
  headers: Record<string, string>;
  prepareHeaders?: JsonRequestHeaderPreparer;
}): Promise<Record<string, string>> {
  if (!args.prepareHeaders) return args.headers;
  return await args.prepareHeaders({
    method: args.method,
    url: new URL(args.url),
    headers: { ...args.headers },
    body: Buffer.from(args.body, "utf8")
  });
}

function parseExpiry(exp: string): { month: number; year: number } {
  const match = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(exp);
  if (!match) return { month: 1, year: 2099 };
  const year = Number(match[2]!.length === 2 ? `20${match[2]}` : match[2]);
  return { month: Number(match[1]), year };
}
