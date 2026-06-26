// Copyright (c) Steelyard contributors. MIT License.
import type {
  PaymentCapability,
  PaymentIssuerMandateDraft,
  PspAdapter,
  PspCaptureArgs,
  PspCaptureResult,
  WalletPaymentIssuer
} from "@steelyard/psp";

export const TEMPLATE_HANDLER_ID = "template";
export const TEMPLATE_INSTRUMENT_TYPE = "template_payment_token";
export const TEMPLATE_TOKEN_PREFIX = "tpl_";

const capabilities = [{
  handlerId: TEMPLATE_HANDLER_ID,
  instrumentType: TEMPLATE_INSTRUMENT_TYPE,
  idPrefix: TEMPLATE_TOKEN_PREFIX
}] satisfies PaymentCapability[];

export function createTemplatePsp(): PspAdapter {
  const captures = new Map<string, PspCaptureResult>();
  return {
    name: "template",
    capabilities,
    supportsHandler: (handlerId) => handlerId === TEMPLATE_HANDLER_ID,
    async capture(args) {
      const cached = captures.get(args.idempotencyKey);
      if (cached) return clone(cached);
      const validation = validateCapture(args);
      if (!validation.ok) {
        captures.set(args.idempotencyKey, validation);
        return clone(validation);
      }
      const result: PspCaptureResult = {
        ok: true,
        psp_payment_id: `psp_template_${shortId(args.idempotencyKey)}`,
        psp_charge_status: "succeeded",
        status: "captured"
      };
      captures.set(args.idempotencyKey, result);
      return clone(result);
    },
    async cancel(args) {
      if (!args.psp_payment_id) throw new Error("psp_payment_id is required");
      if (!args.idempotencyKey) throw new Error("idempotencyKey is required");
    }
  };
}

export function createTemplateIssuer(): WalletPaymentIssuer {
  return {
    instrumentType: TEMPLATE_INSTRUMENT_TYPE,
    async mintForMandate(mandate) {
      const scope = scopeFromDraft(mandate);
      return {
        id: `${TEMPLATE_TOKEN_PREFIX}${encode(JSON.stringify(scope))}`,
        expires_at: scope.exp,
        max_amount: scope.amount,
        currency: scope.currency,
        scope_proof: {
          type: "template_payment_scope",
          checkout_id: scope.checkout_id
        }
      };
    }
  };
}

interface TemplateScope {
  merchant_id: string;
  checkout_id: string;
  transaction_id: string;
  amount: number;
  currency: string;
  handler_id: string;
  instrument_type: string;
  exp: number;
}

function validateCapture(args: PspCaptureArgs): PspCaptureResult {
  if (!Number.isInteger(args.amount) || args.amount < 0) return failure("amount_invalid");
  if (!/^[A-Z]{3}$/.test(args.currency)) return failure("currency_invalid");
  if (args.handler_id !== TEMPLATE_HANDLER_ID) return failure("handler_mismatch");
  if (args.instrument_type !== TEMPLATE_INSTRUMENT_TYPE) return failure("instrument_mismatch");
  const scope = decodeScope(args.vault_token);
  if (!scope) return failure("token_invalid");
  if (scope.merchant_id !== args.merchant_id) return failure("merchant_mismatch");
  if (scope.checkout_id !== args.session_id) return failure("checkout_mismatch");
  if (scope.transaction_id !== (args.payment_mandate?.payment_intent.transaction_id ?? args.session_id)) {
    return failure("transaction_mismatch");
  }
  if (scope.amount !== args.amount) return failure("amount_mismatch");
  if (scope.currency !== args.currency) return failure("currency_mismatch");
  if (scope.handler_id !== args.handler_id) return failure("handler_mismatch");
  if (scope.instrument_type !== args.instrument_type) return failure("instrument_mismatch");
  if (scope.exp <= Math.floor(Date.now() / 1000)) return failure("expired");
  return { ok: true, psp_payment_id: "validated", status: "captured" };
}

function scopeFromDraft(mandate: PaymentIssuerMandateDraft): TemplateScope {
  if (!mandate.merchant_id) throw new Error("mandate.merchant_id is required");
  if (!mandate.handler_id) throw new Error("mandate.handler_id is required");
  if (!mandate.transaction_id) throw new Error("mandate.transaction_id is required");
  if (mandate.instrument_type !== TEMPLATE_INSTRUMENT_TYPE) throw new Error(`mandate.instrument_type must be ${TEMPLATE_INSTRUMENT_TYPE}`);
  const payment = mandate.payment;
  if (!Number.isInteger(payment.amount) || payment.amount < 0) throw new Error("mandate.payment.amount must be non-negative");
  if (!/^[A-Z]{3}$/.test(payment.currency)) throw new Error("mandate.payment.currency must be ISO 4217 uppercase");
  if (!payment.checkout_id) throw new Error("mandate.payment.checkout_id is required");
  const exp = Math.floor(Date.parse(payment.expires_at) / 1000);
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000)) throw new Error("mandate.payment.expires_at must be in the future");
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

function decodeScope(token: string): TemplateScope | null {
  if (!token.startsWith(TEMPLATE_TOKEN_PREFIX)) return null;
  try {
    return JSON.parse(decode(token.slice(TEMPLATE_TOKEN_PREFIX.length))) as TemplateScope;
  } catch {
    return null;
  }
}

function failure(detail: string): PspCaptureResult {
  return { ok: false, reason: detail === "expired" ? "expired" : "other", detail, message: `template PSP rejected token: ${detail}` };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function shortId(value: string): string {
  return Buffer.from(value, "utf8").toString("hex").slice(0, 16);
}
