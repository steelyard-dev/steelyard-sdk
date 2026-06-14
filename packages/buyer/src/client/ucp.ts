// Copyright (c) Steelyard contributors. MIT License.
import { mapUcpCheckoutStatus, type PurchaseIntent, type Receipt } from "@steelyard/core";
import { assertValidUcpCheckout, type Checkout } from "@steelyard/protocol/ucp/checkout";
import {
  asRecord,
  billingBuyer,
  canonicalMandateCheckout,
  delegateVaultToken,
  driverClock,
  joinUrl,
  mandateId,
  notifyTotals,
  patchJson,
  postJson,
  purchaseKey,
  receiptBase,
  selectedHandler,
  stringValue,
  type DriverBaseOpts,
  type JsonRecord,
  type PaymentHandlerLike
} from "./driver-common.js";

export interface UcpDriverOpts extends DriverBaseOpts {
  merchantUrl: string | URL;
  merchantProfile?: { ucp?: { payment_handlers?: Record<string, PaymentHandlerLike[]> } };
  supportsSteelyardMode?: boolean;
}

export class UcpNoCompatibleHandler extends Error {
  constructor(readonly checkoutId: string) {
    super(`UCP checkout has no compatible payment handler: ${checkoutId}`);
    this.name = "UcpNoCompatibleHandler";
  }
}

export class UcpSteelyardModeNotSupported extends Error {
  constructor(readonly checkoutId: string) {
    super(`UCP merchant does not advertise Steelyard checkout mandates: ${checkoutId}`);
    this.name = "UcpSteelyardModeNotSupported";
  }
}

export class UcpCanceled extends Error {
  constructor(readonly checkoutId: string) {
    super(`UCP checkout canceled: ${checkoutId}`);
    this.name = "UcpCanceled";
  }
}

export const ucpDriver = { purchase };

export async function purchase(intent: PurchaseIntent, opts: UcpDriverOpts): Promise<Receipt> {
  const key = purchaseKey(opts, intent);
  const clock = driverClock(opts);
  let checkout = asRecord(
    await postJson(joinUrl(opts.merchantUrl, "/checkout"), { line_items: [{ item: { id: intent.offer.id }, quantity: 1 }] }, {
      idempotencyKey: `${key}:create`,
      fetch: opts.fetch
    })
  );
  assertValidUcpCheckout(checkout);
  if (stringValue(checkout.status) === "canceled") throw new UcpCanceled(stringValue(checkout.id));
  const checkoutId = stringValue(checkout.id);
  const selected = selectedHandler(ucpHandlers(checkout, opts), opts.delegatePaymentUrl);
  if (!selected) throw new UcpNoCompatibleHandler(checkoutId);
  if (opts.supportsSteelyardMode === false) throw new UcpSteelyardModeNotSupported(checkoutId);

  const instrumentId = `instrument_${key.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "1"}`;
  const tokenType = stringValue(selected.handler.config?.token_type, "vault_token");
  checkout = asRecord(
    await patchJson(
      joinUrl(opts.merchantUrl, `/checkout/${encodeURIComponent(checkoutId)}`),
      {
        line_items: [{ item: { id: intent.offer.id }, quantity: 1 }],
        buyer: billingBuyer(opts.port.billing),
        payment: {
          instruments: [
            {
              id: instrumentId,
              handler_id: selected.handler.id,
              type: "vault_token",
              selected: true
            }
          ]
        }
      },
      { idempotencyKey: `${key}:update`, fetch: opts.fetch }
    )
  );
  assertValidUcpCheckout(checkout);
  const totals = await notifyTotals(opts, checkout);
  const vaultTokenId = await delegateVaultToken({
    delegatePaymentUrl: selected.delegatePaymentUrl,
    port: opts.port,
    amount: totals.amount,
    currency: totals.currency,
    checkoutId,
    merchantId: opts.merchantId,
    purchaseKey: key,
    fetch: opts.fetch,
    clock
  });
  const audience = opts.merchantId;
  const publicKey = await opts.port.mandatePublicKey();
  const mandatePayload = {
    iss: publicKey.key_id,
    sub: await opts.port.pairwiseSubject(audience),
    aud: audience,
    iat: Math.floor(clock().getTime() / 1000),
    exp: Math.floor(clock().getTime() / 1000) + 300,
    "steelyard:mandate_version": "v0.1",
    "steelyard:checkout": canonicalMandateCheckout(checkout),
    "steelyard:purchase_key": key,
    "steelyard:payment": {
      handler_id: selected.handler.id,
      credential_id: vaultTokenId,
      expires_at: new Date(clock().getTime() + 15 * 60_000).toISOString()
    }
  };
  const signed = await opts.port.signMandate(mandatePayload);
  const completeBody = {
    payment: {
      instruments: [
        {
          id: instrumentId,
          handler_id: selected.handler.id,
          type: "vault_token",
          credential: { type: tokenType, token: vaultTokenId },
          selected: true
        }
      ]
    },
    "steelyard.checkout_mandate": signed.jwt
  };
  const completed = asRecord(
    await postJson(joinUrl(opts.merchantUrl, `/checkout/${encodeURIComponent(checkoutId)}/complete`), completeBody, {
      idempotencyKey: `${key}:complete`,
      fetch: opts.fetch
    })
  );
  assertValidUcpCheckout(completed);
  return ucpReceipt(intent, completed, vaultTokenId, signed.jwt, clock);
}

function ucpReceipt(
  intent: PurchaseIntent,
  checkout: JsonRecord,
  vaultTokenId: string,
  jwt: string,
  clock: () => Date
): Receipt {
  const order = asRecord(checkout.order);
  return {
    ...receiptBase(intent, "ucp", checkout, clock),
    order_id: stringValue(order.id, stringValue(checkout.id)),
    status: mapUcpCheckoutStatus(stringValue(checkout.status)),
    reference: {
      ucp: {
        checkout_id: stringValue(checkout.id),
        mandate_id: mandateId(jwt),
        vault_token_id: vaultTokenId
      }
    },
    ...(order.permalink_url ? { fulfillment: { permalink_url: String(order.permalink_url) } } : {})
  };
}

function ucpHandlers(checkout: Checkout, opts: UcpDriverOpts): PaymentHandlerLike[] {
  return [
    ...flattenHandlers(asRecord(asRecord(checkout.ucp).payment_handlers)),
    ...flattenHandlers(asRecord(opts.merchantProfile?.ucp?.payment_handlers))
  ];
}

function flattenHandlers(catalog: Record<string, unknown>): PaymentHandlerLike[] {
  return Object.values(catalog)
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map((handler) => asRecord(handler) as PaymentHandlerLike);
}
