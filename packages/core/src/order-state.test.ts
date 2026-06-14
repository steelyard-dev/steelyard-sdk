// Copyright (c) Steelyard contributors. MIT License.
import { describe, expect, it, vi } from "vitest";
import { mapAcpToOrderState, mapUcpCheckoutStatus } from "./order-state.js";

describe("mapAcpToOrderState", () => {
  it("maps completed ACP orders using the ACP order status table", () => {
    expect(mapAcpToOrderState("completed", "completed")).toBe("completed");
    expect(mapAcpToOrderState("completed", "confirmed")).toBe("captured");
    expect(mapAcpToOrderState("completed", "created")).toBe("captured");
    expect(mapAcpToOrderState("completed", "processing")).toBe("captured");
    expect(mapAcpToOrderState("completed", "shipped")).toBe("completed");
    expect(mapAcpToOrderState("completed", "manual_review")).toBe("pending_approval");
    expect(mapAcpToOrderState("completed", "canceled")).toBe("canceled");
  });

  it("maps session-only ACP statuses and rejects pre-payment statuses", () => {
    expect(mapAcpToOrderState("complete_in_progress")).toBe("captured");
    expect(mapAcpToOrderState("in_progress")).toBe("captured");
    expect(mapAcpToOrderState("canceled")).toBe("canceled");
    expect(mapAcpToOrderState("pending_approval")).toBe("pending_approval");
    expect(mapAcpToOrderState("authentication_required")).toBe("escalation_required");
    expect(mapAcpToOrderState("requires_escalation")).toBe("escalation_required");
    expect(mapAcpToOrderState("expired")).toBe("failed");
    expect(() => mapAcpToOrderState("ready_for_payment")).toThrow(/cannot produce a receipt/);
  });

  it("maps unknown ACP order statuses to captured with a structured warning", () => {
    const warn = vi.fn();

    expect(mapAcpToOrderState("completed", "awaiting_pickup", { warn })).toBe("captured");

    expect(warn).toHaveBeenCalledWith({
      code: "unknown_acp_order_status",
      session_status: "completed",
      order_status: "awaiting_pickup",
      mapped_to: "captured"
    });
    expect(mapAcpToOrderState("completed", undefined, { warn: false })).toBe("captured");
  });
});

describe("mapUcpCheckoutStatus", () => {
  it("maps UCP checkout statuses without reading order status", () => {
    expect(mapUcpCheckoutStatus("completed")).toBe("completed");
    expect(mapUcpCheckoutStatus("complete_in_progress")).toBe("captured");
    expect(mapUcpCheckoutStatus("canceled")).toBe("canceled");
    expect(mapUcpCheckoutStatus("requires_escalation")).toBe("escalation_required");
    expect(() => mapUcpCheckoutStatus("ready_for_complete")).toThrow(/cannot produce a receipt/);
    expect(() => mapUcpCheckoutStatus("incomplete")).toThrow(/cannot produce a receipt/);
  });
});
