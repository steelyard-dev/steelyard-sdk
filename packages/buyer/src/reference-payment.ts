// Copyright (c) Steelyard contributors. MIT License.
import {
  assertValidEcJwk,
  defaultClock,
  signDetachedJws,
  type AgentNativeInstrument,
  type PaymentMandateIssuer,
  type EcJwk,
  type HmsAlgorithm,
  type PaymentMandate,
  type PaymentMandateRequest,
} from "@steelyard-dev/core";

export const REFERENCE_PAYMENT_HANDLER_ID = "reference";
export const REFERENCE_PAYMENT_INSTRUMENT_TYPE = "delegated_payment_token";
export const REFERENCE_PAYMENT_TOKEN_PREFIX = "dpt_";

export interface ReferencePaymentMandateIssuerOptions {
  signingKey: EcJwk;
  allowInProduction?: boolean;
  clock?: () => Date;
}

export type ReferencePaymentMandateIssuer = PaymentMandateIssuer;

export class ReferencePaymentMandateIssuerInProductionError extends Error {
  constructor() {
    super(
      "createReferencePaymentMandateIssuer() refused outside a known test environment. " +
        "For demo/staging: pass allowInProduction: true AND set STEELYARD_ALLOW_REFERENCE_PSP=1."
    );
    this.name = "ReferencePaymentMandateIssuerInProductionError";
  }
}

export class ReferencePaymentMandateIssuerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferencePaymentMandateIssuerError";
  }
}

export function createReferencePaymentMandateIssuer(opts: ReferencePaymentMandateIssuerOptions): ReferencePaymentMandateIssuer {
  assertReferenceAllowed(opts);
  const signingKey = validSigningKey(opts.signingKey);
  const alg = algorithmForKey(signingKey);
  const clock = defaultClock(opts.clock);
  return {
    instrumentType: REFERENCE_PAYMENT_INSTRUMENT_TYPE,
    async issueMandate(mandate: PaymentMandateRequest): Promise<PaymentMandate> {
      const payload = referenceTokenPayload(mandate, clock);
      const compact = await compactJws({
        payload,
        header: { alg, kid: signingKey.kid },
        privateKey: signingKey
      });
      return {
        id: `${REFERENCE_PAYMENT_TOKEN_PREFIX}${compact}`,
        expires_at: payload.exp,
        max_amount: payload.amount,
        currency: payload.currency,
        scope_proof: {
          type: "reference_delegated_payment_token",
          kid: signingKey.kid,
          transaction_id: payload.transaction_id
        }
      };
    }
  };
}

export function referenceMandate(opts: ReferencePaymentMandateIssuerOptions): AgentNativeInstrument {
  return {
    mode: "agent-native",
    type: REFERENCE_PAYMENT_INSTRUMENT_TYPE,
    label: "Reference mandate",
    issuer: createReferencePaymentMandateIssuer(opts)
  };
}

interface ReferenceTokenPayload {
  merchant_id: string;
  checkout_id: string;
  transaction_id: string;
  amount: number;
  currency: string;
  handler_id: string;
  instrument_type: string;
  exp: number;
}

function referenceTokenPayload(mandate: PaymentMandateRequest, clock: () => Date): ReferenceTokenPayload {
  if (!mandate.merchant_id) throw new ReferencePaymentMandateIssuerError("mandate.merchant_id is required");
  if (!mandate.handler_id) throw new ReferencePaymentMandateIssuerError("mandate.handler_id is required");
  if (!mandate.transaction_id) throw new ReferencePaymentMandateIssuerError("mandate.transaction_id is required");
  if (mandate.instrument_type !== REFERENCE_PAYMENT_INSTRUMENT_TYPE) {
    throw new ReferencePaymentMandateIssuerError(`mandate.instrument_type must be ${REFERENCE_PAYMENT_INSTRUMENT_TYPE}`);
  }
  const payment = mandate.payment;
  if (!payment) throw new ReferencePaymentMandateIssuerError("mandate.payment is required");
  if (!Number.isInteger(payment.amount) || payment.amount < 0) {
    throw new ReferencePaymentMandateIssuerError("mandate.payment.amount must be a non-negative integer");
  }
  if (!/^[A-Z]{3}$/.test(payment.currency)) {
    throw new ReferencePaymentMandateIssuerError("mandate.payment.currency must be ISO 4217 uppercase");
  }
  if (!payment.checkout_id) throw new ReferencePaymentMandateIssuerError("mandate.payment.checkout_id is required");
  const exp = unixSeconds(payment.expires_at);
  const now = Math.floor(clock().getTime() / 1000);
  if (!Number.isSafeInteger(exp) || exp <= now) {
    throw new ReferencePaymentMandateIssuerError("mandate.payment.expires_at must be in the future");
  }
  return {
    merchant_id: mandate.merchant_id,
    checkout_id: payment.checkout_id,
    transaction_id: mandate.transaction_id,
    amount: payment.amount,
    currency: payment.currency,
    handler_id: mandate.handler_id,
    instrument_type: mandate.instrument_type,
    exp
  };
}

function validSigningKey(value: EcJwk): EcJwk & { kid: string; d: string } {
  const key = assertValidEcJwk(value, { allowPrivate: true });
  if (!key.kid) throw new ReferencePaymentMandateIssuerError("signingKey.kid is required");
  if (!key.d) throw new ReferencePaymentMandateIssuerError("signingKey.d is required");
  return key as EcJwk & { kid: string; d: string };
}

function algorithmForKey(key: EcJwk): HmsAlgorithm {
  if (key.alg === "ES256" || key.alg === "ES384") return key.alg;
  if (key.crv === "P-256") return "ES256";
  if (key.crv === "P-384") return "ES384";
  throw new ReferencePaymentMandateIssuerError(`unsupported signingKey.crv: ${key.crv}`);
}

async function compactJws(args: {
  payload: ReferenceTokenPayload;
  header: { alg: HmsAlgorithm; kid: string };
  privateKey: EcJwk;
}): Promise<string> {
  const payload = utf8(JSON.stringify(args.payload));
  const detached = await signDetachedJws({
    payload,
    header: args.header,
    privateKey: args.privateKey
  });
  const [protectedHeader, empty, signature] = detached.split(".");
  if (!protectedHeader || empty !== "" || !signature) throw new ReferencePaymentMandateIssuerError("reference token signing failed");
  return `${protectedHeader}.${base64url(payload)}.${signature}`;
}

function assertReferenceAllowed(opts: ReferencePaymentMandateIssuerOptions): void {
  const isKnownTest = !!process.env.VITEST || !!process.env.JEST_WORKER_ID || !!process.env.STEELYARD_TEST;
  const bothOptIns = opts.allowInProduction === true && process.env.STEELYARD_ALLOW_REFERENCE_PSP === "1";
  if (!isKnownTest && !bothOptIns) throw new ReferencePaymentMandateIssuerInProductionError();
}

function unixSeconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : Math.floor(parsed / 1000);
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
