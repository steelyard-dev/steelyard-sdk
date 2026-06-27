import Stripe from "stripe";
import { NextResponse } from "next/server";
import { PRODUCTS } from "../../lib/products";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const form = await req.formData();
  const id = String(form.get("id") ?? "");
  const product = PRODUCTS.find((p) => p.id === id);
  if (!product) return NextResponse.json({ error: "unknown product" }, { status: 400 });

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "STRIPE_SECRET_KEY not set — see README" },
      { status: 500 }
    );
  }
  const stripe = new Stripe(key);
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: product.currency.toLowerCase(),
          product_data: { name: product.title },
          unit_amount: product.amount
        },
        quantity: 1
      }
    ],
    success_url: `${origin}/success?id=${product.id}`,
    cancel_url: `${origin}/`
  });
  return NextResponse.redirect(session.url!, { status: 303 });
}
