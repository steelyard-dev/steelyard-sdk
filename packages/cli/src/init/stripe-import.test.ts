import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { importFromStripeCatalog, type StripeLike } from "./stripe-import.js";

function fakeStripe(products: Stripe.Product[], prices: Stripe.Price[]): StripeLike {
  return {
    products: {
      list: async () => ({ data: products, has_more: false }) as any
    },
    prices: {
      list: async () => ({ data: prices, has_more: false }) as any
    }
  };
}

const PRODUCT = (id: string, name: string, archived = false): Stripe.Product => ({
  id,
  name,
  active: !archived,
  description: null,
  images: [],
  metadata: {}
} as unknown as Stripe.Product);

const ONE_TIME = (id: string, productId: string, amount: number, currency = "usd"): Stripe.Price => ({
  id,
  product: productId,
  active: true,
  type: "one_time",
  unit_amount: amount,
  currency,
  recurring: null
} as unknown as Stripe.Price);

const RECURRING = (
  id: string,
  productId: string,
  amount: number,
  interval: "month" | "year" | "week" | "day" = "month",
  trialDays: number | null = null
): Stripe.Price =>
  ({
    id,
    product: productId,
    active: true,
    type: "recurring",
    unit_amount: amount,
    currency: "usd",
    recurring: { interval, interval_count: 1, trial_period_days: trialDays }
  } as unknown as Stripe.Price);

describe("importFromStripeCatalog", () => {
  it("maps one-time prices into manifest offers", async () => {
    const s = fakeStripe(
      [PRODUCT("prod_a", "Espresso")],
      [ONE_TIME("price_a", "prod_a", 300)]
    );
    const result = await importFromStripeCatalog(s);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]!.id).toBe("price_a");
    expect(result.offers[0]!.title).toBe("Espresso");
    expect(result.offers[0]!.pricing[0]).toMatchObject({ kind: "one_time", amount: 300, currency: "USD" });
    expect(result.offers[0]!.psp?.stripe?.priceId).toBe("price_a");
    expect(result.skipped).toHaveLength(0);
  });

  it("maps recurring monthly/yearly cleanly", async () => {
    const s = fakeStripe(
      [PRODUCT("prod_a", "Pro")],
      [RECURRING("price_m", "prod_a", 1000, "month")]
    );
    const r = await importFromStripeCatalog(s);
    expect(r.offers[0]!.pricing[0]).toMatchObject({ kind: "recurring", interval: "month", amount: 1000 });
    expect(r.skipped).toHaveLength(0);
  });

  it("skips recurring with trial and reports the reason", async () => {
    const s = fakeStripe(
      [PRODUCT("prod_a", "Pro")],
      [RECURRING("price_trial", "prod_a", 1000, "month", 14)]
    );
    const r = await importFromStripeCatalog(s);
    expect(r.offers).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.priceId).toBe("price_trial");
    expect(r.skipped[0]!.reason).toContain("trial");
  });

  it("skips recurring with non month/year intervals", async () => {
    const s = fakeStripe(
      [PRODUCT("prod_a", "Daily")],
      [RECURRING("price_day", "prod_a", 100, "day")]
    );
    const r = await importFromStripeCatalog(s);
    expect(r.skipped[0]!.reason).toContain("interval");
  });

  it("skips archived products", async () => {
    const s = fakeStripe(
      [PRODUCT("prod_a", "Old", true)],
      [ONE_TIME("price_a", "prod_a", 300)]
    );
    const r = await importFromStripeCatalog(s);
    expect(r.offers).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain("archived");
  });
});
