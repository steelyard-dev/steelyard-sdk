// Copyright (c) Steelyard contributors. MIT License.

export type OrderState =
  | "authorized"
  | "captured"
  | "completed"
  | "pending_approval"
  | "escalation_required"
  | "canceled"
  | "failed";

export type AcpCheckoutSessionStatus =
  | "incomplete"
  | "not_ready_for_payment"
  | "requires_escalation"
  | "authentication_required"
  | "ready_for_payment"
  | "pending_approval"
  | "complete_in_progress"
  | "completed"
  | "canceled"
  | "in_progress"
  | "expired";

export type AcpOrderStatus =
  | "created"
  | "confirmed"
  | "manual_review"
  | "processing"
  | "shipped"
  | "completed"
  | "canceled"
  | (string & {});

export type UcpCheckoutStatus =
  | "incomplete"
  | "requires_escalation"
  | "ready_for_complete"
  | "complete_in_progress"
  | "completed"
  | "canceled";

export interface UnknownAcpOrderStatusWarning {
  code: "unknown_acp_order_status";
  session_status: "completed";
  order_status: string;
  mapped_to: "captured";
}

export interface OrderStateMapOptions {
  warn?: false | ((warning: UnknownAcpOrderStatusWarning) => void);
}

export function mapAcpToOrderState(
  sessionStatus: AcpCheckoutSessionStatus | string,
  orderStatus?: AcpOrderStatus | null,
  opts: OrderStateMapOptions = {}
): OrderState {
  switch (sessionStatus) {
    case "completed":
      return mapCompletedAcpOrderStatus(orderStatus, opts);
    case "complete_in_progress":
    case "in_progress":
      return "captured";
    case "canceled":
      return "canceled";
    case "pending_approval":
      return "pending_approval";
    case "authentication_required":
    case "requires_escalation":
      return "escalation_required";
    case "expired":
      return "failed";
    default:
      throw new Error(`ACP checkout status cannot produce a receipt: ${sessionStatus}`);
  }
}

export function mapUcpCheckoutStatus(checkoutStatus: UcpCheckoutStatus | string): OrderState {
  switch (checkoutStatus) {
    case "completed":
      return "completed";
    case "complete_in_progress":
      return "captured";
    case "canceled":
      return "canceled";
    case "requires_escalation":
      return "escalation_required";
    default:
      throw new Error(`UCP checkout status cannot produce a receipt: ${checkoutStatus}`);
  }
}

function mapCompletedAcpOrderStatus(
  orderStatus: AcpOrderStatus | null | undefined,
  opts: OrderStateMapOptions
): OrderState {
  switch (orderStatus) {
    case "completed":
    case "shipped":
      return "completed";
    case "confirmed":
    case "created":
    case "processing":
      return "captured";
    case "manual_review":
      return "pending_approval";
    case "canceled":
      return "canceled";
    default:
      warnUnknownAcpOrderStatus(String(orderStatus ?? "<missing>"), opts);
      return "captured";
  }
}

function warnUnknownAcpOrderStatus(orderStatus: string, opts: OrderStateMapOptions): void {
  const warning: UnknownAcpOrderStatusWarning = {
    code: "unknown_acp_order_status",
    session_status: "completed",
    order_status: orderStatus,
    mapped_to: "captured"
  };
  if (opts.warn === false) return;
  if (opts.warn) {
    opts.warn(warning);
    return;
  }
  console.warn(JSON.stringify(warning));
}
