// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import type { Manifest, Offer } from "@steelyard/core";

export interface ToolResult {
  ok: true;
  content: unknown;
}

export interface ToolError {
  ok: false;
  error: string;
}

export type ToolResponse = ToolResult | ToolError;

export interface ListOffersArgs {
  query?: string;
  limit?: number;
}

export interface GetOfferArgs {
  id: string;
}

export function listOffers(manifest: Manifest, args: ListOffersArgs = {}): ToolResponse {
  const query = (args.query ?? "").trim().toLowerCase();
  const limit = args.limit ?? manifest.catalog.offers.length;
  const offers = query
    ? manifest.catalog.offers.filter((offer) => offerMatchesQuery(offer, query))
    : manifest.catalog.offers;

  return { ok: true, content: offers.slice(0, limit) };
}

export function getOffer(manifest: Manifest, args: GetOfferArgs): ToolResponse {
  const offer = manifest.catalog.offers.find((item) => item.id === args.id);
  if (!offer) return { ok: false, error: `Unknown offer id: ${args.id}` };
  return { ok: true, content: offer };
}

function offerMatchesQuery(offer: Offer, query: string): boolean {
  const searchable = [
    offer.id,
    offer.title,
    offer.description,
    ...offer.categories,
    ...Object.values(offer.attributes).flatMap((value) => stringifyAttribute(value))
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return searchable.includes(query);
}

function stringifyAttribute(value: Offer["attributes"][string]): string[] {
  return Array.isArray(value) ? value : [String(value)];
}
