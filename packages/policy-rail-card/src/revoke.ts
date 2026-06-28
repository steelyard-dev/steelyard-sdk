import type Stripe from "stripe";

export async function revokeCard(stripe: Pick<Stripe, "issuing">, cardId: string): Promise<void> {
  await stripe.issuing.cards.update(cardId, { status: "canceled" });
}
