// Copyright (c) Steelyard contributors. MIT License.
import {
  systemClock,
  type AgentNativeInstrument,
  type PaymentMandateIssuer,
  type PaymentMandateRequest,
  type SptHandle
} from "@steelyard-dev/core";
import {
  STRIPE_API_VERSION,
  assertStripeTestSecretKey,
  mintSharedPaymentToken
} from "@steelyard-dev/core/stripe";

export const STRIPE_TEST_NETWORK_BUSINESS_PROFILE =
  "profile_test_61TU90nIeGjU7NNVXA6TU90m7ISQWsBxpcx9lASWWXTk";

export interface StripeSptPaymentMandateIssuerOptions {
  apiKey: string;
  paymentMethod?: string;
  sellerProfile?: string;
  apiVersion?: string;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  clock?: () => Date;
}

export type StripeSptPaymentMandateIssuer = PaymentMandateIssuer;

export class Ap2MandateScopeIncomplete extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ap2MandateScopeIncomplete";
  }
}

export class StripeSptScopeMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeSptScopeMismatch";
  }
}

export function createStripeSptPaymentMandateIssuer(opts: StripeSptPaymentMandateIssuerOptions): StripeSptPaymentMandateIssuer {
  assertStripeTestSecretKey(opts.apiKey);
  const paymentMethod = opts.paymentMethod ?? "pm_card_visa";
  const sellerProfile = opts.sellerProfile ?? STRIPE_TEST_NETWORK_BUSINESS_PROFILE;
  const apiVersion = opts.apiVersion ?? STRIPE_API_VERSION;
  const clock = opts.clock ?? systemClock;

  return {
    instrumentType: "shared_payment_token",
    async issueMandate(mandate: PaymentMandateRequest): Promise<SptHandle> {
      const scope = mandateScope(mandate, clock);
      const idempotencyKey = await mandateIdempotencyKey(mandate);
      const result = await mintSharedPaymentToken({
        apiKey: opts.apiKey,
        paymentMethod,
        sellerProfile,
        usageLimits: {
          currency: scope.currency,
          maxAmount: scope.maxAmount,
          expiresAt: scope.expiresAt
        },
        apiVersion,
        idempotencyKey,
        fetch: opts.fetch,
        apiBaseUrl: opts.apiBaseUrl
      });

      assertReturnedScope(result, scope);
      return {
        id: result.id,
        expires_at: result.expires_at,
        max_amount: result.max_amount,
        currency: result.currency,
        scope_proof: {
          type: "stripe_spt_usage_limits",
          idempotency_key: idempotencyKey
        }
      };
    }
  };
}

export function stripeSpt(opts: StripeSptPaymentMandateIssuerOptions): AgentNativeInstrument {
  return {
    mode: "agent-native",
    type: "shared_payment_token",
    label: "Stripe SPT",
    issuer: createStripeSptPaymentMandateIssuer(opts)
  };
}

function mandateScope(
  mandate: PaymentMandateRequest,
  clock: () => Date
): { currency: string; maxAmount: number; expiresAt: number } {
  if (!Number.isSafeInteger(mandate.iat)) throw new Ap2MandateScopeIncomplete("mandate.iat is required");
  if (!mandate.nonce) throw new Ap2MandateScopeIncomplete("mandate.nonce is required");
  const payment = mandate.payment;
  if (!payment) throw new Ap2MandateScopeIncomplete("mandate.payment is required");
  if (!Number.isInteger(payment.amount) || payment.amount < 0) {
    throw new Ap2MandateScopeIncomplete("mandate.payment.amount must be a non-negative integer");
  }
  if (!/^[A-Z]{3}$/.test(payment.currency)) {
    throw new Ap2MandateScopeIncomplete("mandate.payment.currency must be ISO 4217 uppercase");
  }
  if (!payment.checkout_id) throw new Ap2MandateScopeIncomplete("mandate.payment.checkout_id is required");
  const expiresAt = unixSeconds(payment.expires_at);
  const now = Math.floor(clock().getTime() / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Ap2MandateScopeIncomplete("mandate.payment.expires_at must be in the future");
  }
  if (expiresAt > now + 24 * 60 * 60) {
    throw new Ap2MandateScopeIncomplete("mandate.payment.expires_at must be within 24 hours");
  }
  return { currency: payment.currency, maxAmount: payment.amount, expiresAt };
}

function assertReturnedScope(
  result: { currency: string; max_amount: number; expires_at: number },
  expected: { currency: string; maxAmount: number; expiresAt: number }
): void {
  if (result.currency.toUpperCase() !== expected.currency) {
    throw new StripeSptScopeMismatch("Stripe SPT currency does not match mandate scope");
  }
  if (result.max_amount > expected.maxAmount) {
    throw new StripeSptScopeMismatch("Stripe SPT max_amount widens mandate scope");
  }
  if (result.expires_at > expected.expiresAt) {
    throw new StripeSptScopeMismatch("Stripe SPT expires_at widens mandate scope");
  }
}

async function mandateIdempotencyKey(mandate: PaymentMandateRequest): Promise<string> {
  return `spt_${await sha256Hex(`${mandate.iat}:${mandate.nonce}`)}`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unixSeconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : Math.floor(parsed / 1000);
}
