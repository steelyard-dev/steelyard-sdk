import type Stripe from "stripe";
import type { CredentialConstraints, IssuedCredential } from "@steelyard-dev/policy";

export interface MintArgs {
  stripe: Pick<Stripe, "issuing">;
  cardholderId: string;
  authorization_hash: string;
  constraints: CredentialConstraints;
}

export async function mintCard(args: MintArgs): Promise<IssuedCredential> {
  if (args.constraints.mid_allowed?.length) {
    throw new Error("Stripe Issuing adapter cannot enforce MID-locked credentials");
  }
  const amount = safeStripeAmount(args.constraints.amount_minor);
  const spending_controls: Stripe.Issuing.CardCreateParams.SpendingControls = {
    spending_limits: [{ amount, interval: "all_time" }]
  };
  if (args.constraints.mcc_allowed?.length) {
    spending_controls.allowed_categories =
      args.constraints.mcc_allowed as Stripe.Issuing.CardCreateParams.SpendingControls.AllowedCategory[];
  }

  const created = await args.stripe.issuing.cards.create(
    {
      type: "virtual",
      cardholder: args.cardholderId,
      currency: args.constraints.currency.toLowerCase(),
      status: "active",
      spending_controls,
      metadata: {
        authorization_hash: args.authorization_hash,
        steelyard_expires_at: args.constraints.expires_at
      }
    },
    { idempotencyKey: args.authorization_hash }
  );

  return {
    credential_id: created.id,
    authorization_hash: args.authorization_hash,
    rail: "virtual_card",
    payload: cardPayload(created),
    expires_at: args.constraints.expires_at
  };
}

function safeStripeAmount(value: bigint): number {
  if (value < 0n) throw new Error("Stripe Issuing amount must be non-negative");
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Stripe Issuing amount exceeds safe integer range");
  return Number(value);
}

function cardPayload(card: Stripe.Issuing.Card): Record<string, unknown> {
  const record = card as unknown as Record<string, unknown>;
  return {
    pan: record.number,
    cvv: record.cvc,
    expiry: expiry(record.exp_month, record.exp_year),
    billing_zip: billingZip(record),
    raw: card
  };
}

function expiry(month: unknown, year: unknown): string | undefined {
  if (typeof month !== "number" || typeof year !== "number") return undefined;
  return `${String(month).padStart(2, "0")}/${year}`;
}

function billingZip(card: Record<string, unknown>): string | undefined {
  const shipping = card.shipping;
  if (!isRecord(shipping)) return undefined;
  const address = shipping.address;
  if (!isRecord(address)) return undefined;
  return typeof address.postal_code === "string" ? address.postal_code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
