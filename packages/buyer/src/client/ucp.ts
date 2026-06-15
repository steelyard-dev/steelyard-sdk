// Copyright (c) Steelyard contributors. MIT License.
import { mapUcpCheckoutStatus, type EcJwk, type HmsAlgorithm, type PurchaseIntent, type Receipt } from "@steelyard/core";
import { assertValidUcpCheckout, type Checkout } from "@steelyard/protocol/ucp/checkout";
import { resolveSigningKey, signUcpRequest, verifyUcpResponse, type UcpProfileDoc } from "@steelyard/protocol/ucp";
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
  postJsonResponse,
  purchaseKey,
  receiptBase,
  selectedHandler,
  stringValue,
  type DriverBaseOpts,
  type JsonHttpResponse,
  type JsonRecord,
  type JsonRequestHeaderPreparer,
  type PaymentHandlerLike
} from "./driver-common.js";

export interface UcpDriverOpts extends DriverBaseOpts {
  merchantUrl: string | URL;
  merchantProfile?: { ucp?: { payment_handlers?: Record<string, unknown> }; signing_keys?: EcJwk[] };
  supportsSteelyardMode?: boolean;
  ucpAuth?: UcpAuthOptions;
}

export type UcpAuthPreference = "hms" | "bearer";

export interface UcpHmsSigningOptions {
  kid: string;
  algorithm: HmsAlgorithm;
  profileUrl: string;
}

export interface UcpAuthOptions {
  preferred?: UcpAuthPreference;
  signing?: UcpHmsSigningOptions;
  bearerToken?: string;
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

export class UcpAuthMissing extends Error {
  constructor(message = "UCP auth could not be produced for the selected mechanism") {
    super(message);
    this.name = "UcpAuthMissing";
  }
}

export class UcpResponseSignatureInvalid extends Error {
  constructor(readonly reason: string, readonly detail?: string) {
    super(`UCP response signature verification failed: ${detail ? `${reason}: ${detail}` : reason}`);
    this.name = "UcpResponseSignatureInvalid";
  }
}

export const ucpDriver = { purchase };

export async function purchase(intent: PurchaseIntent, opts: UcpDriverOpts): Promise<Receipt> {
  const key = purchaseKey(opts, intent);
  const clock = driverClock(opts);
  const auth = resolveUcpRequestAuth(opts);
  const prepareHeaders = ucpHeaderPreparer(auth, clock);
  let checkout = asRecord(
    await postJson(joinUrl(opts.merchantUrl, "/checkout"), { line_items: [{ item: { id: intent.offer.id }, quantity: 1 }] }, {
      idempotencyKey: `${key}:create`,
      fetch: opts.fetch,
      prepareHeaders
    })
  );
  assertValidUcpCheckout(checkout);
  if (stringValue(checkout.status) === "canceled") throw new UcpCanceled(stringValue(checkout.id));
  const checkoutId = stringValue(checkout.id);
  const selected = selectedHandler(ucpHandlers(checkout, opts), opts.delegatePaymentUrl);
  if (!selected) throw new UcpNoCompatibleHandler(checkoutId);

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
      { idempotencyKey: `${key}:update`, fetch: opts.fetch, prepareHeaders }
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
  let signed: { jwt: string; key_id: string } | undefined;
  const completeBody: Record<string, unknown> = {
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
    }
  };
  if (opts.supportsSteelyardMode === true && canSignSteelyardMandate(opts.port)) {
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
    signed = await opts.port.signMandate(mandatePayload);
    completeBody["steelyard.checkout_mandate"] = signed.jwt;
  }
  const completedResponse = await postJsonResponse(
    joinUrl(opts.merchantUrl, `/checkout/${encodeURIComponent(checkoutId)}/complete`),
    completeBody,
    {
      idempotencyKey: `${key}:complete`,
      fetch: opts.fetch,
      prepareHeaders
    }
  );
  await verifySignedUcpCompleteResponse(opts, completedResponse, clock);
  const completed = asRecord(completedResponse.body);
  assertValidUcpCheckout(completed);
  return ucpReceipt(intent, completed, vaultTokenId, signed?.jwt, clock);
}

function ucpReceipt(
  intent: PurchaseIntent,
  checkout: JsonRecord,
  vaultTokenId: string,
  jwt: string | undefined,
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
        vault_token_id: vaultTokenId,
        ...(jwt ? { mandate_id: mandateId(jwt) } : {})
      }
    },
    ...(order.permalink_url ? { fulfillment: { permalink_url: String(order.permalink_url) } } : {})
  };
}

function canSignSteelyardMandate(port: UcpDriverOpts["port"]): boolean {
  return typeof port.mandatePublicKey === "function"
    && typeof port.pairwiseSubject === "function"
    && typeof port.signMandate === "function";
}

type ResolvedUcpRequestAuth =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | {
      kind: "hms";
      kid: string;
      algorithm: HmsAlgorithm;
      profileUrl: string;
      sign: (data: Uint8Array) => Promise<Uint8Array>;
    };

function resolveUcpRequestAuth(opts: UcpDriverOpts): ResolvedUcpRequestAuth {
  const auth = opts.ucpAuth;
  if (!auth) return { kind: "none" };

  const preferred = auth.preferred ?? "hms";
  const hms = hmsRequestAuth(opts);
  const bearer = typeof auth.bearerToken === "string" && auth.bearerToken
    ? { kind: "bearer" as const, token: auth.bearerToken }
    : undefined;

  if (preferred === "bearer") {
    if (bearer) return bearer;
    if (hms) return hms;
    throw new UcpAuthMissing("UCP bearer auth selected but no bearer token or HMS key is available");
  }

  if (hms) return hms;
  if (bearer) return bearer;
  throw new UcpAuthMissing("UCP HMS auth selected but signing config or vault key is missing");
}

function hmsRequestAuth(opts: UcpDriverOpts): Extract<ResolvedUcpRequestAuth, { kind: "hms" }> | undefined {
  const signing = opts.ucpAuth?.signing;
  if (!signing?.kid || !signing.profileUrl || !signing.algorithm) return undefined;
  if (typeof opts.port.signWithUcpKey !== "function") return undefined;
  return {
    kind: "hms",
    kid: signing.kid,
    algorithm: signing.algorithm,
    profileUrl: signing.profileUrl,
    sign: (data) => opts.port.signWithUcpKey!({ data, algorithm: signing.algorithm })
  };
}

async function verifySignedUcpCompleteResponse(
  opts: UcpDriverOpts,
  response: JsonHttpResponse,
  clock: () => Date
): Promise<void> {
  const signatureInput = response.headers["signature-input"];
  const signature = response.headers.signature;
  if (!signatureInput && !signature) return;

  const result = await verifyUcpResponse({
    status: response.status,
    headers: response.headers,
    body: response.rawBody.byteLength ? response.rawBody : undefined,
    resolveKey: async (kid) => resolveMerchantSigningKey(opts.merchantProfile, kid),
    now: clock()
  });
  if (!result.ok) throw new UcpResponseSignatureInvalid(result.reason, result.detail);
}

function resolveMerchantSigningKey(
  profile: UcpDriverOpts["merchantProfile"] | undefined,
  kid: string
): EcJwk | null {
  if (!profile) return null;
  return resolveSigningKey(profile as UcpProfileDoc, kid);
}

function ucpHeaderPreparer(
  auth: ResolvedUcpRequestAuth,
  clock: () => Date
): JsonRequestHeaderPreparer | undefined {
  if (auth.kind === "none") return undefined;
  return async (args) => {
    if (auth.kind === "bearer") {
      return { ...args.headers, authorization: `Bearer ${auth.token}` };
    }
    try {
      const signed = await signUcpRequest({
        method: args.method,
        url: args.url,
        headers: args.headers,
        body: args.body,
        signing: {
          kid: auth.kid,
          algorithm: auth.algorithm,
          sign: auth.sign
        },
        ucpAgent: `profile="${auth.profileUrl}"`,
        now: clock()
      });
      return signed.headers;
    } catch (error) {
      throw error instanceof UcpAuthMissing
        ? error
        : new UcpAuthMissing(error instanceof Error ? error.message : String(error));
    }
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
