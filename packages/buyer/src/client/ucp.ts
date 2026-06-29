// Copyright (c) Steelyard contributors. MIT License.
import {
  jcsCanonicalize,
  mapUcpCheckoutStatus,
  verifyDetachedJws,
  type Ap2ErrorCode,
  type EcJwk,
  type HmsAlgorithm,
  type PurchaseIntent,
  type Receipt
} from "@steelyard-dev/core";
import { assertValidUcpCheckout, type Checkout } from "@steelyard-dev/protocol/ucp/checkout";
import {
  UcpAp2EnvelopeValidationError,
  assertValidAp2EnvelopeOnResponse,
  resolveSigningKey,
  signUcpRequest,
  verifyUcpResponse,
  type UcpProfileDoc
} from "@steelyard-dev/protocol/ucp";
import {
  issueAp2CheckoutMandate,
  issueAp2PaymentMandate,
  ucpAp2PaymentTransactionId,
  type Ap2PaymentInstrument,
  type Ap2PaymentMerchant
} from "../vault/mandate-ap2/index.js";
import {
  asRecord,
  billingBuyer,
  canonicalMandateCheckout,
  delegateVaultToken,
  driverClock,
  handlerSupportsInstrument,
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
  ap2Locked?: boolean;
  ap2?: UcpAp2MandateOptions;
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

export interface UcpAp2MandateOptions {
  enabled: boolean;
  issuer: string;
  checkoutNonce?: string;
  paymentNonce?: string;
  paymentAudience?: string;
  payee?: Ap2PaymentMerchant;
  paymentInstrument?: Ap2PaymentInstrument;
  checkoutMandateExpiresInSeconds?: number;
  paymentMandateExpiresInSeconds?: number;
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

export class Ap2MerchantAuthorizationInvalid extends Error {
  readonly code: Ap2ErrorCode = "merchant_authorization_invalid";

  constructor(readonly reason: string) {
    super(`AP2 merchant authorization invalid: ${reason}`);
    this.name = "Ap2MerchantAuthorizationInvalid";
  }
}

export class Ap2SessionInconsistent extends Error {
  readonly code: Ap2ErrorCode;

  constructor(code: Extract<Ap2ErrorCode, "merchant_authorization_missing" | "agent_missing_key">, message: string) {
    super(message);
    this.name = "Ap2SessionInconsistent";
    this.code = code;
  }
}

export const ucpDriver = { purchase };

export async function purchase(intent: PurchaseIntent, opts: UcpDriverOpts): Promise<Receipt> {
  const key = purchaseKey(opts, intent);
  const clock = driverClock(opts);
  const ap2Required = opts.ap2Locked === true || opts.ap2?.enabled === true;
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
  await verifyAp2MerchantAuthorization(checkout, opts, { required: ap2Required });
  if (stringValue(checkout.status) === "canceled") throw new UcpCanceled(stringValue(checkout.id));
  const checkoutId = stringValue(checkout.id);
  const selected = selectedUcpHandler(ucpHandlers(checkout, opts), opts);
  if (!selected) throw new UcpNoCompatibleHandler(checkoutId);

  const instrumentId = `instrument_${key.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "1"}`;
  let selectedInstrumentType = ucpSelectedInstrumentType(selected.handler, opts) ?? "vault_token";
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
              type: selectedInstrumentType,
              selected: true
            }
          ]
        }
      },
      { idempotencyKey: `${key}:update`, fetch: opts.fetch, prepareHeaders }
    )
  );
  assertValidUcpCheckout(checkout);
  await verifyAp2MerchantAuthorization(checkout, opts, { required: ap2Required });
  const totals = await notifyTotals(opts, checkout);
  const audience = opts.merchantId;
  let vaultTokenId = "";
  let ap2Mandates: {
    checkout_mandate: string;
    payment_mandate: string;
    payment_token_id: string;
    payment_instrument_type: string;
  } | undefined;
  if (ap2Required && opts.port.paymentMandateIssuer) {
    ap2Mandates = await issueUcpAp2Mandates({
      opts,
      checkout: checkout as Checkout,
      totals,
      audience,
      handlerId: stringValue(selected.handler.id),
      clock
    });
    vaultTokenId = ap2Mandates.payment_token_id;
    selectedInstrumentType = ap2Mandates.payment_instrument_type;
  } else if (!ap2Required && opts.port.paymentMandateIssuer && handlerSupportsInstrument(selected.handler, opts.port.paymentMandateIssuer.instrumentType)) {
    const mandate = await issueUcpPaymentMandate({
      opts,
      totals,
      checkoutId,
      handlerId: stringValue(selected.handler.id),
      purchaseKey: key,
      clock
    });
    vaultTokenId = mandate.id;
    selectedInstrumentType = opts.port.paymentMandateIssuer.instrumentType;
  } else {
    vaultTokenId = await delegateVaultToken({
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
    ap2Mandates = ap2Required
      ? await issueUcpAp2Mandates({
          opts,
          checkout: checkout as Checkout,
          totals,
          vaultTokenId,
          audience,
          handlerId: stringValue(selected.handler.id),
          clock
        })
      : undefined;
  }
  let mandateJwt = ap2Mandates?.checkout_mandate;
  const completeBody: Record<string, unknown> = {
    payment: {
      instruments: [
        {
          id: instrumentId,
          handler_id: selected.handler.id,
          type: selectedInstrumentType,
          credential: {
            type: ap2Mandates ? "ap2_payment_mandate" : tokenType,
            token: ap2Mandates?.payment_mandate ?? vaultTokenId
          },
          selected: true
        }
      ]
    }
  };
  if (ap2Mandates) {
    completeBody.ap2 = { checkout_mandate: ap2Mandates.checkout_mandate };
  } else if (opts.supportsSteelyardMode === true && canSignSteelyardMandate(opts.port)) {
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
    mandateJwt = signed.jwt;
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
  return ucpReceipt(intent, completed, vaultTokenId, mandateJwt, clock);
}

async function issueUcpAp2Mandates(args: {
  opts: UcpDriverOpts;
  checkout: Checkout;
  totals: { amount: number; currency: string };
  vaultTokenId?: string;
  audience: string;
  handlerId: string;
  clock: () => Date;
}): Promise<{ checkout_mandate: string; payment_mandate: string; payment_token_id: string; payment_instrument_type: string }> {
  const ap2 = args.opts.ap2;
  if (!ap2?.enabled) {
    throw new Ap2SessionInconsistent("agent_missing_key", "AP2 session is locked but AP2 mandate options are not configured");
  }
  if (!canIssueAp2Mandates(args.opts.port)) {
    throw new UcpAuthMissing("UCP AP2 mandates require a UCP signing key");
  }
  const checkoutMandate = await issueAp2CheckoutMandate({
    signer: args.opts.port,
    checkout: args.checkout,
    issuer: ap2.issuer,
    audience: args.audience,
    nonce: resolveAp2Nonce(args.checkout, ap2.checkoutNonce, "checkout_nonce"),
    buyer: {
      name: args.opts.port.billing.name,
      email: args.opts.port.billing.email,
      address: asRecord(args.opts.port.billing.address)
    },
    clock: args.clock,
    expiresInSeconds: ap2.checkoutMandateExpiresInSeconds
  });
  const expiresAt = new Date(args.clock().getTime() + 15 * 60_000).toISOString();
  const paymentNonce = resolveAp2Nonce(args.checkout, ap2.paymentNonce, "payment_nonce");
  const payment = {
    amount: args.totals.amount,
    currency: args.totals.currency,
    checkout_id: stringValue(asRecord(args.checkout).id),
    expires_at: expiresAt
  };
  const issuedAt = Math.floor(args.clock().getTime() / 1000);
  const issuer = args.opts.port.paymentMandateIssuer;
  const issued = issuer
    ? await issuer.issueMandate({
        iat: issuedAt,
        nonce: paymentNonce,
        merchant_id: args.opts.merchantId,
        handler_id: args.handlerId,
        instrument_type: issuer.instrumentType,
        transaction_id: ucpAp2PaymentTransactionId(args.checkout),
        payment
      })
    : undefined;
  const paymentInstrument = issued && issuer
    ? {
        id: issued.id,
        type: issuer.instrumentType,
        description: "Issuer payment token"
      }
    : ap2.paymentInstrument ?? {
        id: args.vaultTokenId ?? "",
        type: "card",
        description: "Payment credential"
      };
  const paymentMandate = await issueAp2PaymentMandate({
    signer: args.opts.port,
    checkout: args.checkout,
    issuer: ap2.issuer,
    audience: ap2.paymentAudience ?? args.audience,
    nonce: paymentNonce,
    payment,
    payee: ap2.payee ?? payeeFromMerchantId(args.opts.merchantId),
    paymentInstrument,
    handlerId: args.handlerId,
    clock: args.clock,
    expiresInSeconds: ap2.paymentMandateExpiresInSeconds
  });
  return {
    checkout_mandate: checkoutMandate.checkout_mandate,
    payment_mandate: paymentMandate.payment_mandate,
    payment_token_id: issued?.id ?? args.vaultTokenId ?? paymentInstrument.id,
    payment_instrument_type: paymentInstrument.type
  };
}

async function issueUcpPaymentMandate(args: {
  opts: UcpDriverOpts;
  totals: { amount: number; currency: string };
  checkoutId: string;
  handlerId: string;
  purchaseKey: string;
  clock: () => Date;
}) {
  const issuer = args.opts.port.paymentMandateIssuer;
  if (!issuer) throw new UcpAuthMissing("UCP payment mandate issuer is required for this payment handler");
  const expiresAt = new Date(args.clock().getTime() + 15 * 60_000).toISOString();
  return await issuer.issueMandate({
    iat: Math.floor(args.clock().getTime() / 1000),
    nonce: `ucp:${args.checkoutId}:${args.purchaseKey}`,
    merchant_id: args.opts.merchantId,
    handler_id: args.handlerId,
    instrument_type: issuer.instrumentType,
    transaction_id: args.checkoutId,
    payment: {
      amount: args.totals.amount,
      currency: args.totals.currency,
      checkout_id: args.checkoutId,
      expires_at: expiresAt
    }
  });
}

function resolveAp2Nonce(checkout: Checkout, configured: string | undefined, field: "checkout_nonce" | "payment_nonce"): string {
  if (configured) return configured;
  const nonce = asRecord(asRecord(checkout).ap2)[field];
  if (typeof nonce === "string" && nonce) return nonce;
  throw new Ap2SessionInconsistent(
    "merchant_authorization_missing",
    `AP2 session is locked but checkout.ap2.${field} is missing`
  );
}

function ucpReceipt(
  intent: PurchaseIntent,
  checkout: JsonRecord,
  vaultTokenId: string,
  jwt: string | undefined,
  clock: () => Date
): Receipt {
  const order = asRecord(checkout.order);
  const payment = asRecord(checkout.payment_details);
  return {
    ...receiptBase(intent, "ucp", checkout, clock),
    order_id: stringValue(order.id, stringValue(checkout.id)),
    status: mapUcpCheckoutStatus(stringValue(checkout.status)),
    reference: {
      ucp: {
        checkout_id: stringValue(checkout.id),
        vault_token_id: vaultTokenId,
        ...(jwt ? { mandate_id: mandateId(jwt) } : {}),
        ...pspReference(payment)
      }
    },
    ...(order.permalink_url ? { fulfillment: { permalink_url: String(order.permalink_url) } } : {})
  };
}

function pspReference(payment: JsonRecord): {
  psp_payment_id?: string;
  psp_charge_id?: string;
  psp_charge_status?: string;
} {
  return {
    ...(payment.psp_payment_id ? { psp_payment_id: String(payment.psp_payment_id) } : {}),
    ...(payment.psp_charge_id ? { psp_charge_id: String(payment.psp_charge_id) } : {}),
    ...(payment.psp_charge_status ? { psp_charge_status: String(payment.psp_charge_status) } : {})
  };
}

function canSignSteelyardMandate(port: UcpDriverOpts["port"]): boolean {
  return typeof port.mandatePublicKey === "function"
    && typeof port.pairwiseSubject === "function"
    && typeof port.signMandate === "function";
}

function canIssueAp2Mandates(
  port: UcpDriverOpts["port"]
): port is UcpDriverOpts["port"] & {
  exportUcpSigningPublicKey: NonNullable<UcpDriverOpts["port"]["exportUcpSigningPublicKey"]>;
  signWithUcpKey: NonNullable<UcpDriverOpts["port"]["signWithUcpKey"]>;
} {
  return typeof port.exportUcpSigningPublicKey === "function" && typeof port.signWithUcpKey === "function";
}

function payeeFromMerchantId(merchantId: string): Ap2PaymentMerchant {
  try {
    const url = new URL(merchantId);
    return {
      id: merchantId,
      name: url.hostname,
      website: url.origin
    };
  } catch {
    return {
      id: merchantId,
      name: merchantId
    };
  }
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

async function verifyAp2MerchantAuthorization(
  checkout: JsonRecord,
  opts: UcpDriverOpts,
  session: { required: boolean }
): Promise<void> {
  if (session.required) {
    try {
      assertValidAp2EnvelopeOnResponse(checkout);
    } catch (error) {
      if (error instanceof UcpAp2EnvelopeValidationError) {
        throw new Ap2SessionInconsistent(
          "merchant_authorization_missing",
          "AP2 session is locked but checkout.ap2.merchant_authorization is missing"
        );
      }
      throw error;
    }
  }
  const merchantAuthorization = stringValue(asRecord(checkout.ap2).merchant_authorization);
  if (!merchantAuthorization) {
    if (session.required) {
      throw new Ap2SessionInconsistent(
        "merchant_authorization_missing",
        "AP2 session is locked but checkout.ap2.merchant_authorization is missing"
      );
    }
    return;
  }

  let result: Awaited<ReturnType<typeof verifyDetachedJws>>;
  try {
    result = await verifyDetachedJws({
      jws: merchantAuthorization,
      payload: jcsCanonicalize(checkoutWithoutAp2(checkout)),
      resolveKey: async (kid) => resolveMerchantSigningKey(opts.merchantProfile, kid)
    });
  } catch {
    throw new Ap2MerchantAuthorizationInvalid("signature_invalid");
  }
  if (!result.ok) throw new Ap2MerchantAuthorizationInvalid(ap2MerchantAuthorizationReason(result.reason));
}

function checkoutWithoutAp2(checkout: JsonRecord): JsonRecord {
  const { ap2: _ap2, ...payload } = checkout;
  return payload;
}

function ap2MerchantAuthorizationReason(reason: string): string {
  return reason === "key_not_found" ? "unknown_kid" : reason;
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

function selectedUcpHandler(
  handlers: PaymentHandlerLike[],
  opts: UcpDriverOpts
): { handler: PaymentHandlerLike; delegatePaymentUrl: string } | undefined {
  const delegated = selectedHandler(handlers, opts.delegatePaymentUrl);
  if (delegated) return delegated;
  const issuer = opts.port.paymentMandateIssuer;
  if (!issuer) return undefined;
  const compatible = handlers.find((handler) => handlerSupportsInstrument(handler, issuer.instrumentType));
  return compatible ? { handler: compatible, delegatePaymentUrl: "" } : undefined;
}

function ucpSelectedInstrumentType(handler: PaymentHandlerLike, opts: UcpDriverOpts): string | undefined {
  const issuer = opts.port.paymentMandateIssuer;
  return issuer && handlerSupportsInstrument(handler, issuer.instrumentType) ? issuer.instrumentType : undefined;
}

function flattenHandlers(catalog: Record<string, unknown>): PaymentHandlerLike[] {
  return Object.values(catalog)
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map((handler) => {
      const record = asRecord(handler);
      return {
        id: stringValue(record.id),
        available_instruments: Array.isArray(record.available_instruments) ? record.available_instruments : undefined,
        config: asRecord(record.config)
      };
    })
    .filter((handler) => handler.id);
}
