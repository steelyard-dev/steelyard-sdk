import { stripePsp } from "@steelyard/merchant/psp";

const apiKey = process.env.STRIPE_SECRET_KEY;
if (!apiKey) {
  throw new Error("STRIPE_SECRET_KEY is required. Use Stripe test-mode credentials.");
}

const psp = stripePsp({ apiKey });
const result = await psp.capture({
  vault_token: process.env.STRIPE_PAYMENT_METHOD ?? "pm_card_visa",
  amount: Number(process.env.STRIPE_AMOUNT ?? 500),
  currency: process.env.STRIPE_CURRENCY ?? "USD",
  metadata: { source: "steelyard-coffee-shop-smoke" },
  idempotencyKey: process.env.STRIPE_IDEMPOTENCY_KEY ?? `coffee_shop_smoke_${Date.now()}`,
  session_id: "coffee_shop_smoke",
  merchant_id: "coffee.example",
  handler_id: "stripe"
});

console.log(JSON.stringify(result, null, 2));
