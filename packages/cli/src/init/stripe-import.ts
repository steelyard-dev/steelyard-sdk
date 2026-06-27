// Copyright (c) Steelyard contributors. MIT License.
//
// Stripe → manifest catalog import. Reads active Products and active Prices and
// emits a list of offers in manifest shape, plus a list of skipped prices with
// human-readable reasons. The CLI shows the skip list as a warning summary
// at the end of `init`.

import type Stripe from "stripe";
import type { Manifest, Offer, Price } from "@steelyard/core";

export interface StripeLike {
  products: { list: (params?: any) => Promise<{ data: Stripe.Product[]; has_more: boolean }> };
  prices: { list: (params?: any) => Promise<{ data: Stripe.Price[]; has_more: boolean }> };
}

export interface SkippedPrice {
  priceId: string;
  productId: string;
  reason: string;
}

export interface StripeImportResult {
  offers: Array<Offer & { psp: { stripe: { priceId: string } } }>;
  skipped: SkippedPrice[];
  identity: Manifest["identity"];
}

export async function importFromStripeCatalog(stripe: StripeLike): Promise<StripeImportResult> {
  const products = await listAll(stripe.products.list.bind(stripe.products), { active: true, limit: 100 });
  const prices = await listAll(stripe.prices.list.bind(stripe.prices), { active: true, limit: 100 });
  const productsById = new Map(products.map((p) => [p.id, p]));

  const offers: Array<Offer & { psp: { stripe: { priceId: string } } }> = [];
  const skipped: SkippedPrice[] = [];

  for (const price of prices) {
    const productId = typeof price.product === "string" ? price.product : price.product.id;
    const product = productsById.get(productId);
    if (!product) {
      skipped.push({ priceId: price.id, productId, reason: "product not found" });
      continue;
    }
    if (!product.active) {
      skipped.push({ priceId: price.id, productId, reason: "archived product" });
      continue;
    }
    const mapped = mapPrice(price);
    if (mapped.kind === "skip") {
      skipped.push({ priceId: price.id, productId, reason: mapped.reason });
      continue;
    }
    offers.push({
      id: price.id,
      title: product.name,
      kind: "product",
      categories: [],
      attributes: {},
      images: [],
      availability: "in_stock",
      pricing: [mapped.price],
      psp: { stripe: { priceId: price.id } }
    });
  }

  return {
    offers,
    skipped,
    identity: {
      name: "My Shop",
      domain: "shop.example",
      currencies: dedupeCurrencies(offers)
    }
  };
}

type Mapped =
  | { kind: "ok"; price: Price }
  | { kind: "skip"; reason: string };

function mapPrice(price: Stripe.Price): Mapped {
  if (price.type === "one_time") {
    if (typeof price.unit_amount !== "number") {
      return { kind: "skip", reason: "tiered/custom pricing not supported" };
    }
    return {
      kind: "ok",
      price: { kind: "one_time", amount: price.unit_amount, currency: price.currency.toUpperCase() }
    };
  }

  if (price.type === "recurring" && price.recurring) {
    if (price.recurring.trial_period_days != null) {
      return { kind: "skip", reason: "recurring with trial — schema doesn't support trial_days yet" };
    }
    if (price.recurring.interval_count !== 1) {
      return { kind: "skip", reason: "non-unit interval count — schema doesn't support interval_count yet" };
    }
    if (price.recurring.interval !== "month" && price.recurring.interval !== "year") {
      return {
        kind: "skip",
        reason: `recurring interval "${price.recurring.interval}" not supported by schema`
      };
    }
    if (typeof price.unit_amount !== "number") {
      return { kind: "skip", reason: "tiered/custom pricing not supported" };
    }
    return {
      kind: "ok",
      price: {
        kind: "recurring",
        amount: price.unit_amount,
        currency: price.currency.toUpperCase(),
        interval: price.recurring.interval
      }
    };
  }

  return { kind: "skip", reason: `unsupported price type "${price.type}"` };
}

function dedupeCurrencies(offers: Array<{ pricing: Price[] }>): string[] {
  const set = new Set<string>();
  for (const o of offers) {
    for (const p of o.pricing) {
      if ("currency" in p) set.add(p.currency);
    }
  }
  return set.size ? Array.from(set) : ["USD"];
}

async function listAll<T>(
  list: (params: any) => Promise<{ data: T[]; has_more: boolean }>,
  baseParams: Record<string, any>
): Promise<T[]> {
  const out: T[] = [];
  let starting_after: string | undefined;
  for (;;) {
    const page = await list({ ...baseParams, starting_after });
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    const last = page.data[page.data.length - 1] as unknown as { id: string };
    starting_after = last.id;
  }
  return out;
}
