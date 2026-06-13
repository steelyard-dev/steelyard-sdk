// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import type { IncomingMessage, ServerResponse } from "node:http";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import acpFeedSchema from "../../../protocols/acp/spec/2026-04-17/json-schema/schema.feed.json";
import type { Manifest, Offer, Price } from "@steelyard/core";

export interface AcpPrice {
  amount: number;
  currency: string;
}

export interface AcpAvailability {
  available: boolean;
  status: Offer["availability"];
}

export interface AcpMedia {
  type: "image";
  url: string;
  alt_text?: string;
}

export interface AcpDescription {
  plain: string;
}

export interface AcpVariant {
  id: string;
  title: string;
  description?: AcpDescription;
  url?: string;
  price?: AcpPrice;
  availability: AcpAvailability;
  categories?: { value: string; taxonomy: "merchant" }[];
  media?: AcpMedia[];
  seller?: AcpSeller;
}

export interface AcpProduct {
  id: string;
  title?: string;
  description?: AcpDescription;
  url?: string;
  media?: AcpMedia[];
  variants: AcpVariant[];
}

export interface AcpFeed {
  products: AcpProduct[];
}

export interface AcpSeller {
  name?: string;
  links?: { type: string; title?: string; url: string }[];
}

export interface AcpValidationResult {
  valid: boolean;
  errors: ErrorObject[] | null | undefined;
}

const acpFeedSchemaId = "https://example.com/schemas/feed/bundle.schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(acpFeedSchema, acpFeedSchemaId);

const validateProductsResponse = loadProductsResponseValidator();

export function buildAcpFeed(manifest: Manifest): AcpFeed {
  const seller = mapSeller(manifest);
  const feed = {
    products: manifest.catalog.offers.map((offer) => {
      const media = mapMedia(offer.images);
      const description = mapDescription(offer.description);
      return {
        id: offer.id,
        title: offer.title,
        description,
        url: offer.url,
        media,
        variants: [
          {
            id: offer.id,
            title: offer.title,
            description,
            url: offer.url,
            price: formatPrice(offer.pricing),
            availability: mapAvailability(offer.availability),
            categories: offer.categories.map((value) => ({ value, taxonomy: "merchant" as const })),
            media,
            seller
          }
        ]
      };
    })
  };
  assertValidAcpFeed(feed);
  return feed;
}

export function validateAcpFeed(feed: unknown): AcpValidationResult {
  const valid = validateProductsResponse(feed);
  return {
    valid,
    errors: validateProductsResponse.errors
  };
}

export function assertValidAcpFeed(feed: unknown): asserts feed is AcpFeed {
  const result = validateAcpFeed(feed);
  if (!result.valid) {
    const message = ajv.errorsText(result.errors, { separator: "; " });
    throw new Error(`ACP feed failed ProductsResponse validation: ${message}`);
  }
}

export function createAcpFeedHandler(manifest: Manifest) {
  return function handleAcpFeed(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    const body = JSON.stringify(buildAcpFeed(manifest));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

function loadProductsResponseValidator(): ValidateFunction<AcpFeed> {
  const validate = ajv.getSchema(`${acpFeedSchemaId}#/$defs/ProductsResponse`) as
    | ValidateFunction<AcpFeed>
    | undefined;
  if (!validate) {
    throw new Error("Unable to load ACP ProductsResponse schema");
  }
  return validate;
}

function formatPrice(pricing: Price[]): AcpPrice | undefined {
  const priced = pricing.find(
    (price): price is Extract<Price, { amount: number; currency: string }> => "amount" in price
  );
  if (!priced) return undefined;
  return { amount: priced.amount, currency: priced.currency };
}

function mapAvailability(availability: Offer["availability"]): AcpAvailability {
  return {
    available: availability === "in_stock" || availability === "preorder",
    status: availability
  };
}

function mapMedia(images: string[]): AcpMedia[] | undefined {
  if (!images.length) return undefined;
  return images.map((url) => ({ type: "image", url }));
}

function mapDescription(description?: string): AcpDescription | undefined {
  return description ? { plain: description } : undefined;
}

function mapSeller(manifest: Manifest): AcpSeller {
  return {
    name: manifest.identity.name,
    links: manifest.policies
      .filter((policy) => policy.url)
      .map((policy) => ({
        type: `${policy.type}_policy`,
        title: policy.type,
        url: policy.url!
      }))
  };
}
