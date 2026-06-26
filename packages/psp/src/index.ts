// Copyright (c) Steelyard contributors. MIT License.
import type {
  EcJwk,
  PaymentCapability,
  PspCaptureResult
} from "@steelyard/core";

export type {
  PaymentCapability,
  PaymentIssuerMandateDraft,
  PspCaptureResult,
  SptHandle,
  WalletPaymentIssuer
} from "@steelyard/core";

export interface PspPaymentIntent {
  amount: number;
  currency: string;
  checkout_id: string;
  expires_at: string;
  transaction_id?: string;
}

export interface PspPaymentMandate {
  format: "ap2-sd-jwt-kb";
  payload: string;
  holder_jwk: EcJwk;
  payment_intent: PspPaymentIntent;
}

export interface PspCaptureArgs {
  vault_token: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
  session_id: string;
  merchant_id: string;
  handler_id?: string;
  instrument_type?: string;
  payment_mandate?: PspPaymentMandate;
}

export interface PspAdapter {
  name: string;
  capabilities: readonly PaymentCapability[];
  supportsHandler(handlerId: string): boolean;
  capture(args: PspCaptureArgs): Promise<PspCaptureResult>;
  cancel(args: { psp_payment_id: string; idempotencyKey: string }): Promise<void>;
}
