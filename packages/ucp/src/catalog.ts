// Copyright (c) Steelyard contributors. MIT License.
import type { Manifest, Offer, Price } from "@steelyard/core";
import {
  UCP_CATALOG_LOOKUP_CAPABILITY,
  UCP_CATALOG_SEARCH_CAPABILITY,
  UCP_VERSION
} from "./discovery.js";

export interface UcpPrice {
  amount: number;
  currency: string;
}

export interface UcpProduct {
  id: string;
  title: string;
  description: { plain: string };
  url?: string;
  categories: { value: string; taxonomy: "merchant" }[];
  price_range: { min: UcpPrice; max: UcpPrice };
  media: { type: "image"; url: string }[];
  variants: UcpVariant[];
  tags: string[];
}

export interface UcpVariant {
  id: string;
  title: string;
  description: { plain: string };
  url?: string;
  categories: { value: string; taxonomy: "merchant" }[];
  price: UcpPrice;
  availability: { available: boolean; status: Offer["availability"] };
  media: { type: "image"; url: string }[];
  tags: string[];
}

export interface UcpCatalogResponse {
  ucp: ReturnType<typeof responseUcp>;
  products: UcpProduct[];
}

export interface UcpProductResponse {
  ucp: ReturnType<typeof responseUcp>;
  product: UcpProduct;
}

export function searchCatalog(manifest: Manifest, body: unknown): UcpCatalogResponse {
  const request = asRecord(body);
  const query = typeof request.query === "string" ? request.query.trim().toLowerCase() : "";
  const offers = query
    ? manifest.catalog.offers.filter((offer) => offerMatchesQuery(offer, query))
    : manifest.catalog.offers;
  return { ucp: responseUcp(), products: offers.map((offer) => offerToProduct(manifest, offer)) };
}

export function lookupCatalog(manifest: Manifest, body: unknown): UcpCatalogResponse {
  const ids = readIds(body);
  const selected = manifest.catalog.offers.filter((offer) => ids.includes(offer.id));
  return { ucp: responseUcp(), products: selected.map((offer) => offerToProduct(manifest, offer)) };
}

export function getProduct(manifest: Manifest, body: unknown): UcpProduct | undefined {
  const request = asRecord(body);
  const id = typeof request.id === "string" ? request.id : "";
  const offer = manifest.catalog.offers.find((item) => item.id === id);
  return offer ? offerToProduct(manifest, offer) : undefined;
}

function responseUcp() {
  return {
    version: UCP_VERSION,
    status: "success" as const,
    capabilities: {
      [UCP_CATALOG_SEARCH_CAPABILITY]: [{ version: UCP_VERSION }],
      [UCP_CATALOG_LOOKUP_CAPABILITY]: [{ version: UCP_VERSION }]
    }
  };
}

function offerToProduct(manifest: Manifest, offer: Offer): UcpProduct {
  const price = firstPrice(offer, manifest.identity.currencies[0] ?? "USD");
  const categories = offer.categories.map((value) => ({ value, taxonomy: "merchant" as const }));
  const media = offer.images.map((url) => ({ type: "image" as const, url }));
  const description = { plain: offer.description ?? offer.title };
  const tags = offer.categories;
  return {
    id: offer.id,
    title: offer.title,
    description,
    url: offer.url,
    categories,
    price_range: { min: price, max: price },
    media,
    variants: [
      {
        id: offer.id,
        title: offer.title,
        description,
        url: offer.url,
        categories,
        price,
        availability: {
          available: offer.availability === "in_stock" || offer.availability === "preorder",
          status: offer.availability
        },
        media,
        tags
      }
    ],
    tags
  };
}

function firstPrice(offer: Offer, fallbackCurrency: string): UcpPrice {
  const priced = offer.pricing.find(
    (price): price is Extract<Price, { amount: number; currency: string }> => "amount" in price
  );
  return priced
    ? { amount: priced.amount, currency: priced.currency }
    : { amount: 0, currency: fallbackCurrency };
}

function offerMatchesQuery(offer: Offer, query: string): boolean {
  return [offer.id, offer.title, offer.description, ...offer.categories]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function readIds(body: unknown): string[] {
  const request = asRecord(body);
  return Array.isArray(request.ids) ? request.ids.filter((id): id is string => typeof id === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
