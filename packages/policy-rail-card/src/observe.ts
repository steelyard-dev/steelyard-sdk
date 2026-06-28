import type { SettlementEvent, SettlementEventKind } from "@steelyard/policy";

export interface StripeIssuingEvent {
  id: string;
  type: string;
  created: number;
  data: { object: StripeIssuingObject };
}

export interface StripeIssuingObject {
  card?: string | { id?: string };
  amount?: number;
  currency?: string;
  approved?: boolean;
}

const EVENT_KIND: Record<string, SettlementEventKind> = {
  "issuing_authorization.request": "authorized",
  "issuing_authorization.created": "authorized",
  "issuing_transaction.created": "captured",
  "issuing_card.updated": "cancelled"
};

export class WebhookEventBus {
  private readonly byCard = new Map<string, Map<string, StripeIssuingEvent>>();

  ingest(event: StripeIssuingEvent): void {
    const cardId = cardIdFor(event);
    if (!cardId) return;
    const events = this.byCard.get(cardId) ?? new Map<string, StripeIssuingEvent>();
    events.set(event.id, event);
    this.byCard.set(cardId, events);
  }

  eventsFor(cardId: string): SettlementEvent[] {
    const events = this.byCard.get(cardId);
    if (!events) return [];
    return [...events.values()]
      .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
      .map((event) => normalizeEvent(event));
  }
}

function normalizeEvent(event: StripeIssuingEvent): SettlementEvent {
  return {
    event_id: event.id,
    ts: new Date(event.created * 1000).toISOString(),
    kind: kindFor(event),
    amount_minor: event.data.object.amount === undefined ? undefined : BigInt(event.data.object.amount),
    currency: event.data.object.currency?.toUpperCase(),
    raw: event
  };
}

function kindFor(event: StripeIssuingEvent): SettlementEventKind {
  if (event.type.startsWith("issuing_authorization.") && event.data.object.approved === false) return "declined";
  return EVENT_KIND[event.type] ?? "authorized";
}

function cardIdFor(event: StripeIssuingEvent): string | undefined {
  const card = event.data.object.card;
  if (typeof card === "string") return card;
  return card?.id;
}
