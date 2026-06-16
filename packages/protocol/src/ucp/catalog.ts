// Copyright (c) Steelyard contributors. MIT License.
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Manifest, Offer, Price } from "@steelyard/core";
import {
  UCP_CATALOG_LOOKUP_CAPABILITY,
  UCP_CATALOG_SEARCH_CAPABILITY,
  UCP_VERSION,
  type UcpValidationResult
} from "./discovery.js";
import {
  ALL_SCHEMAS,
  CATALOG_LOOKUP_SCHEMA_ID,
  CATALOG_SEARCH_SCHEMA_ID
} from "./spec-schemas.js";

// TODO: upstream issue link: https://github.com/Universal-Commerce-Protocol/js-sdk/issues
// @ucp-js/sdk@0.1.0 does not export catalog Product/Variant/Search/Lookup
// aliases matching the vendored 2026-04-17 catalog schemas. Keep these local
// response builders tied to the vendored AJV validators until upstream exposes
// matching generated types.
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

/**
 * Lookup-only variant: identical to {@link UcpVariant} plus the spec-required
 * `inputs` array correlating request identifiers to the variant per
 * `catalog_lookup.json#/$defs/lookup_variant`.
 */
export interface UcpLookupVariant extends UcpVariant {
  inputs: { id: string; match: "exact" }[];
}

export interface UcpLookupProduct extends Omit<UcpProduct, "variants"> {
  variants: UcpLookupVariant[];
}

export interface UcpCatalogResponse {
  ucp: ReturnType<typeof responseUcp>;
  products: UcpProduct[];
}

/** Lookup responses carry products whose variants include `inputs` correlation. */
export interface UcpLookupResponse {
  ucp: ReturnType<typeof responseUcp>;
  products: UcpLookupProduct[];
}

export interface UcpProductResponse {
  ucp: ReturnType<typeof responseUcp>;
  product: UcpProduct;
}

// AJV instance loaded with the full UCP schema graph that catalog responses
// transitively reference. The vendored runtime spec under
// packages/protocol/spec/ucp/2026-04-17 is the source of truth; spec-schemas.ts
// owns the import list.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const schema of ALL_SCHEMAS) {
  ajv.addSchema(schema);
}

const validateSearchResponseFn = loadValidator(
  `${CATALOG_SEARCH_SCHEMA_ID}#/$defs/search_response`,
  "search_response"
);
const validateLookupResponseFn = loadValidator(
  `${CATALOG_LOOKUP_SCHEMA_ID}#/$defs/lookup_response`,
  "lookup_response"
);
const validateGetProductResponseFn = loadValidator(
  `${CATALOG_LOOKUP_SCHEMA_ID}#/$defs/get_product_response`,
  "get_product_response"
);

export function searchCatalog(manifest: Manifest, body: unknown): UcpCatalogResponse {
  const request = asRecord(body);
  const query = typeof request.query === "string" ? request.query.trim().toLowerCase() : "";
  const offers = query
    ? manifest.catalog.offers.filter((offer) => offerMatchesQuery(offer, query))
    : manifest.catalog.offers;
  const response: UcpCatalogResponse = {
    ucp: responseUcp(),
    products: offers.map((offer) => offerToProduct(manifest, offer))
  };
  assertValidSearchResponse(response);
  return response;
}

export function lookupCatalog(manifest: Manifest, body: unknown): UcpLookupResponse {
  const ids = readIds(body);
  const selected = manifest.catalog.offers.filter((offer) => ids.includes(offer.id));
  const response: UcpLookupResponse = {
    ucp: responseUcp(),
    products: selected.map((offer) => offerToLookupProduct(manifest, offer))
  };
  assertValidLookupResponse(response);
  return response;
}

export function getProduct(manifest: Manifest, body: unknown): UcpProduct | undefined {
  const request = asRecord(body);
  const id = typeof request.id === "string" ? request.id : "";
  const offer = manifest.catalog.offers.find((item) => item.id === id);
  if (!offer) return undefined;
  const response: UcpProductResponse = {
    ucp: responseUcp(),
    product: offerToProduct(manifest, offer)
  };
  assertValidGetProductResponse(response);
  return response.product;
}

/**
 * Validates a UCP catalog `search_response` against the vendored
 * shopping/catalog_search.json#/$defs/search_response schema.
 */
export function validateSearchResponse(payload: unknown): UcpValidationResult {
  const valid = validateSearchResponseFn(payload);
  return { valid, errors: validateSearchResponseFn.errors };
}

/**
 * Validates a UCP catalog `lookup_response` against the vendored
 * shopping/catalog_lookup.json#/$defs/lookup_response schema.
 */
export function validateLookupResponse(payload: unknown): UcpValidationResult {
  const valid = validateLookupResponseFn(payload);
  return { valid, errors: validateLookupResponseFn.errors };
}

/**
 * Validates a UCP catalog `get_product_response` against the vendored
 * shopping/catalog_lookup.json#/$defs/get_product_response schema.
 */
export function validateGetProductResponse(payload: unknown): UcpValidationResult {
  const valid = validateGetProductResponseFn(payload);
  return { valid, errors: validateGetProductResponseFn.errors };
}

/** Throws if the search response does not conform to the vendored spec. */
export function assertValidSearchResponse(response: unknown): void {
  const result = validateSearchResponse(response);
  if (!result.valid) {
    throw new Error(
      `UCP catalog search response failed spec validation: ${formatErrors(result.errors)}`
    );
  }
}

/** Throws if the lookup response does not conform to the vendored spec. */
export function assertValidLookupResponse(response: unknown): void {
  const result = validateLookupResponse(response);
  if (!result.valid) {
    throw new Error(
      `UCP catalog lookup response failed spec validation: ${formatErrors(result.errors)}`
    );
  }
}

/** Throws if the get_product response does not conform to the vendored spec. */
export function assertValidGetProductResponse(response: unknown): void {
  const result = validateGetProductResponse(response);
  if (!result.valid) {
    throw new Error(
      `UCP catalog get_product response failed spec validation: ${formatErrors(result.errors)}`
    );
  }
}

function loadValidator(schemaRef: string, label: string): ValidateFunction {
  const validator = ajv.getSchema(schemaRef);
  /* c8 ignore next 3 — defensive: this fires at module load if the schema
     graph in spec-schemas.ts ever lost a required schema. Module would fail
     to import, so no test can reach this state once the module is loaded. */
  if (!validator) {
    throw new Error(`Unable to load UCP ${label} validator at ${schemaRef}`);
  }
  return validator;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  /* c8 ignore next — defensive: AJV always populates errors when valid=false,
     so this fallback only fires if AJV's API contract is broken. */
  if (!errors || errors.length === 0) return "(no AJV errors reported)";
  return ajv.errorsText(errors, { separator: "; " });
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

function offerToLookupProduct(manifest: Manifest, offer: Offer): UcpLookupProduct {
  const product = offerToProduct(manifest, offer);
  // The lookup spec requires `inputs` on each variant: which request identifier
  // resolved to this variant, with match semantics. Since v0 only resolves by
  // offer id, each variant correlates to its own id with `match: "exact"`.
  const variantsWithInputs: UcpLookupVariant[] = product.variants.map((variant) => ({
    ...variant,
    inputs: [{ id: offer.id, match: "exact" }]
  }));
  return { ...product, variants: variantsWithInputs };
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
