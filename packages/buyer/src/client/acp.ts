// Copyright (c) Steelyard contributors. MIT License.
import { mapAcpToOrderState, type PurchaseIntent, type Receipt } from "@steelyard/core";
import {
  assertValidCheckoutSession,
  assertValidCheckoutSessionWithOrder
} from "@steelyard/protocol/acp/checkout";
import {
  asRecord,
  delegateVaultToken,
  driverClock,
  joinUrl,
  notifyTotals,
  postJson,
  purchaseKey,
  receiptBase,
  selectedHandler,
  stringValue,
  type DriverBaseOpts,
  type JsonRecord,
  type PaymentHandlerLike
} from "./driver-common.js";

export interface AcpDriverOpts extends DriverBaseOpts {
  merchantUrl: string | URL;
  riskSignals?: unknown[];
}

export class AcpNoPspEndpoint extends Error {
  constructor() {
    super("ACP checkout did not advertise a delegate payment endpoint");
    this.name = "AcpNoPspEndpoint";
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

export const acpDriver = { purchase };

export async function purchase(intent: PurchaseIntent, opts: AcpDriverOpts): Promise<Receipt> {
  const key = purchaseKey(opts, intent);
  const clock = driverClock(opts);
  const createBody = {
    line_items: [{ id: intent.offer.id, name: intent.offer.title, unit_amount: intent.amount }],
    currency: intent.currency,
    capabilities: {}
  };
  const session = asRecord(
    await postJson(joinUrl(opts.merchantUrl, "/checkout_sessions"), createBody, {
      idempotencyKey: `${key}:create`,
      fetch: opts.fetch
    })
  );
  assertValidCheckoutSession(session);
  const ready = inspectAcpStatus(session);
  const totals = await notifyTotals(opts, ready);
  const handlers = acpHandlers(ready);
  const selected = selectedHandler(handlers, opts.delegatePaymentUrl);
  if (!selected) throw new AcpNoPspEndpoint();
  const checkoutId = stringValue(ready.id);
  const vaultTokenId = await delegateVaultToken({
    delegatePaymentUrl: selected.delegatePaymentUrl,
    port: opts.port,
    amount: totals.amount,
    currency: totals.currency,
    checkoutId,
    merchantId: opts.merchantId,
    purchaseKey: key,
    riskSignals: opts.riskSignals,
    fetch: opts.fetch,
    clock
  });
  const completeBody = {
    payment_data: {
      handler_id: selected.handler.id,
      instrument: {
        type: "vault_token",
        credential: { type: "vault_token", token: vaultTokenId }
      }
    }
  };
  const completed = asRecord(
    await postJson(joinUrl(opts.merchantUrl, `/checkout_sessions/${encodeURIComponent(checkoutId)}/complete`), completeBody, {
      idempotencyKey: `${key}:complete`,
      fetch: opts.fetch
    })
  );
  assertValidCheckoutSessionWithOrder(completed);
  return acpReceipt(intent, completed, vaultTokenId, clock);
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
