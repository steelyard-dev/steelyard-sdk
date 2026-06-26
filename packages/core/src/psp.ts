// Copyright (c) Steelyard contributors. MIT License.

export type PspCaptureResult =
  | {
      ok: true;
      psp_payment_id: string;
      psp_charge_id?: string;
      psp_charge_status?: string;
      status: "captured" | "authorized";
    }
  | {
      ok: false;
      reason:
        | "declined"
        | "fraud"
        | "insufficient_funds"
        | "expired_card"
        | "expired"
        | "limit_exceeded"
        | "revoked"
        | "seller_mismatch"
        | "other";
      message: string;
      detail?: string;
    }
  | { ok: false; requires_authentication: true; continue_url: string };
