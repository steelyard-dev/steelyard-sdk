// Copyright (c) Steelyard contributors. MIT License.
import { mapAcpToOrderState, type PurchaseIntent, type Receipt } from "@steelyard/core";
import {
  ACP_API_VERSION_HEADER,
  ACP_VERSION,
  ACP_WEBHOOK_SIGNATURE_HEADER,
  assertValidCheckoutSession,
  assertValidCheckoutSessionWithOrder,
  verifyAcpWebhookSignature,
  type AcpWebhookSignatureVerificationResult
} from "@steelyard/protocol/acp/checkout";
import {
  asRecord,
  driverClock,
  joinUrl,
  notifyTotals,
  postJson,
  purchaseKey,
  receiptBase,
  stringValue,
  type DriverBaseOpts,
  type JsonRecord,
  type JsonRequestHeaderPreparer,
  type PaymentHandlerLike
} from "./driver-common.js";

export interface AcpDriverOpts extends DriverBaseOpts {
  merchantUrl: string | URL;
  acpAuth?: AcpAuthOptions;
  riskSignals?: unknown[];
}

export interface AcpCancelOpts {
  merchantUrl: string | URL;
  acpAuth?: AcpAuthOptions;
  idempotencyKey?: string;
  fetch?: typeof fetch;
}

export interface AcpAuthOptions {
  bearerToken?: string;
}

export interface AcpWebhookVerifyArgs {
  rawBody: string | Uint8Array;
  headers: Headers | Record<string, string | string[] | undefined>;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}

export class AcpNoCompatibleHandler extends Error {
  constructor() {
    super("ACP checkout did not advertise a compatible Stripe SPT handler");
    this.name = "AcpNoCompatibleHandler";
  }
}

export class AcpPaymentIssuerMissing extends Error {
  constructor() {
    super("ACP direct SPT checkout requires port.paymentIssuer");
    this.name = "AcpPaymentIssuerMissing";
  }
}

export class AcpProtocolViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpProtocolViolation";
  }
}

export class AcpCanceled extends Error {
  constructor(readonly checkoutId: string) {
    super(`ACP checkout canceled: ${checkoutId}`);
    this.name = "AcpCanceled";
  }
}

export class AcpExpired extends Error {
  constructor(readonly checkoutId: string) {
    super(`ACP checkout expired: ${checkoutId}`);
    this.name = "AcpExpired";
  }
}

export const acpDriver = { purchase, cancel };

export async function purchase(intent: PurchaseIntent, opts: AcpDriverOpts): Promise<Receipt> {
  const key = purchaseKey(opts, intent);
  const clock = driverClock(opts);
  const prepareHeaders = acpHeaderPreparer(opts.acpAuth);
  const createBody = {
    line_items: [{ id: intent.offer.id, name: intent.offer.title, unit_amount: intent.amount }],
    currency: intent.currency,
    capabilities: {}
  };
  const session = asRecord(
    await postJson(joinUrl(opts.merchantUrl, "/checkout_sessions"), createBody, {
      idempotencyKey: `${key}:create`,
      fetch: opts.fetch,
      prepareHeaders
    })
  );
  assertValidCheckoutSession(session);
  const ready = inspectAcpStatus(session);
  const totals = await notifyTotals(opts, ready);
  const handlers = acpHandlers(ready);
  const selected = selectedAcpHandler(handlers);
  if (!selected) throw new AcpNoCompatibleHandler();
  if (!opts.port.paymentIssuer) throw new AcpPaymentIssuerMissing();
  const checkoutId = stringValue(ready.id);
  const expiresAt = new Date(clock().getTime() + 15 * 60_000).toISOString();
  const spt = await opts.port.paymentIssuer.mintForMandate({
    iat: Math.floor(clock().getTime() / 1000),
    nonce: `acp:${checkoutId}:${key}`,
    payment: {
      amount: totals.amount,
      currency: totals.currency.toUpperCase(),
      checkout_id: checkoutId,
      expires_at: expiresAt
    }
  });
  const completeBody = {
    payment_data: {
      handler_id: selected.id,
      instrument: {
        type: "card",
        credential: { type: "spt", token: spt.id }
      }
    }
  };
  const completed = asRecord(
    await postJson(joinUrl(opts.merchantUrl, `/checkout_sessions/${encodeURIComponent(checkoutId)}/complete`), completeBody, {
      idempotencyKey: `${key}:complete`,
      fetch: opts.fetch,
      prepareHeaders
    })
  );
  assertValidCheckoutSessionWithOrder(completed);
  return acpReceipt(intent, completed, spt.id, clock);
}

export async function cancel(sessionId: string, opts: AcpCancelOpts): Promise<JsonRecord> {
  const canceled = asRecord(
    await postJson(joinUrl(opts.merchantUrl, `/checkout_sessions/${encodeURIComponent(sessionId)}/cancel`), {}, {
      idempotencyKey: opts.idempotencyKey ?? `acp:${sessionId}:cancel`,
      fetch: opts.fetch,
      prepareHeaders: acpHeaderPreparer(opts.acpAuth)
    })
  );
  assertValidCheckoutSession(canceled);
  return canceled;
}

export async function verifyAcpWebhook(args: AcpWebhookVerifyArgs): Promise<AcpWebhookSignatureVerificationResult> {
  return await verifyAcpWebhookSignature({
    rawBody: args.rawBody,
    secret: args.secret,
    header: headerValue(args.headers, ACP_WEBHOOK_SIGNATURE_HEADER),
    now: args.now,
    toleranceSeconds: args.toleranceSeconds
  });
}

function inspectAcpStatus(session: JsonRecord): JsonRecord {
  const status = stringValue(session.status);
  if (status === "ready_for_payment") return session;
  if (status === "completed") return session;
  if (status === "canceled") throw new AcpCanceled(stringValue(session.id));
  if (status === "expired") throw new AcpExpired(stringValue(session.id));
  throw new AcpProtocolViolation(`ACP checkout status not supported by v0.3 driver: ${status || "unknown"}`);
}

function acpReceipt(intent: PurchaseIntent, session: JsonRecord, vaultTokenId: string, clock: () => Date): Receipt {
  const order = asRecord(session.order);
  const payment = asRecord(session.payment_details);
  return {
    ...receiptBase(intent, "acp", session, clock),
    order_id: stringValue(order.id, stringValue(session.id)),
    status: mapAcpToOrderState(stringValue(session.status), stringValue(order.status, undefined as unknown as string)),
    reference: {
      acp: {
        checkout_session_id: stringValue(session.id),
        vault_token_id: vaultTokenId,
        ...(payment.psp_payment_id ? { psp_payment_id: String(payment.psp_payment_id) } : {})
      }
    }
  };
}

function acpHandlers(session: JsonRecord): PaymentHandlerLike[] {
  const capabilities = asRecord(session.capabilities);
  const payment = asRecord(capabilities.payment);
  const handlers = payment.handlers;
  return Array.isArray(handlers) ? handlers.map((handler) => asRecord(handler) as PaymentHandlerLike) : [];
}

function selectedAcpHandler(handlers: PaymentHandlerLike[]): PaymentHandlerLike | undefined {
  return handlers.find((handler) =>
    stringValue(handler.id) === "stripe"
    && asRecord(handler).requires_delegate_payment !== true
  );
}

function acpHeaderPreparer(auth: AcpAuthOptions | undefined): JsonRequestHeaderPreparer {
  return async ({ headers }) => ({
    ...headers,
    [ACP_API_VERSION_HEADER]: ACP_VERSION,
    ...(auth?.bearerToken ? { authorization: `Bearer ${auth.bearerToken}` } : {})
  });
}

function headerValue(headers: AcpWebhookVerifyArgs["headers"], name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
