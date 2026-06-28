import { describe, expect, it } from "vitest";
import { WebhookEventBus, type StripeIssuingEvent } from "../src/observe.js";

describe("WebhookEventBus", () => {
  it("dedups by Stripe event id", () => {
    const bus = new WebhookEventBus();

    bus.ingest(evt("evt_1", "issuing_authorization.created", "ic_a", 1000));
    bus.ingest(evt("evt_1", "issuing_authorization.created", "ic_a", 1000));

    expect(bus.eventsFor("ic_a")).toHaveLength(1);
  });

  it("orders by event.created ascending and normalizes amount, currency, and kind", () => {
    const bus = new WebhookEventBus();

    bus.ingest(evt("evt_2", "issuing_transaction.created", "ic_a", 2000, { amount: 5500, currency: "usd" }));
    bus.ingest(evt("evt_1", "issuing_authorization.request", "ic_a", 1000, { amount: 5500, currency: "usd" }));
    bus.ingest(evt("evt_3", "issuing_authorization.created", "ic_a", 3000, { approved: false }));

    expect(bus.eventsFor("ic_a")).toEqual([
      expect.objectContaining({ event_id: "evt_1", ts: "1970-01-01T00:16:40.000Z", kind: "authorized", amount_minor: 5500n, currency: "USD" }),
      expect.objectContaining({ event_id: "evt_2", ts: "1970-01-01T00:33:20.000Z", kind: "captured", amount_minor: 5500n, currency: "USD" }),
      expect.objectContaining({ event_id: "evt_3", ts: "1970-01-01T00:50:00.000Z", kind: "declined" })
    ]);
  });

  it("supports card object ids, cancellation events, and missing-card drops", () => {
    const bus = new WebhookEventBus();

    bus.ingest({ id: "evt_missing", type: "issuing_card.updated", created: 1, data: { object: {} } });
    bus.ingest({ id: "evt_card", type: "issuing_card.updated", created: 2, data: { object: { card: { id: "ic_obj" } } } });

    expect(bus.eventsFor("missing")).toEqual([]);
    expect(bus.eventsFor("ic_obj")).toEqual([expect.objectContaining({ event_id: "evt_card", kind: "cancelled" })]);
  });
});

function evt(
  id: string,
  type: string,
  card: string,
  created: number,
  object: Omit<StripeIssuingEvent["data"]["object"], "card"> = {}
): StripeIssuingEvent {
  return { id, type, created, data: { object: { card, ...object } } };
}
