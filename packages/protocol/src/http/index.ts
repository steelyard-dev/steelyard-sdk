// Copyright (c) Steelyard contributors. MIT License.
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  commerceManifest,
  type CommerceManifestOpts,
  type CommerceManifestPeer,
  type Manifest,
  type Offer
} from "@steelyard-dev/core";
import commerceManifestSchema from "../../../core/spec/commerce-manifest/0.1/commerce-manifest.schema.json";
import capabilitiesResponseSchema from "../../../core/spec/http/0.1/capabilities_response.schema.json";
import errorSchema from "../../../core/spec/http/0.1/error.schema.json";
import indexResponseSchema from "../../../core/spec/http/0.1/index_response.schema.json";
import offerSchema from "../../../core/spec/http/0.1/offer.schema.json";
import policiesResponseSchema from "../../../core/spec/http/0.1/policies_response.schema.json";
import policySchema from "../../../core/spec/http/0.1/policy.schema.json";
import productsResponseSchema from "../../../core/spec/http/0.1/products_response.schema.json";
import {
  type CorsOpts,
  type ErrorEnvelope,
  type Fallthrough,
  invokeFallthrough,
  requestUrl,
  sendError,
  sendJson,
  sendOptions
} from "../internal/http.js";

export const HTTP_API_DEFAULT_PREFIX = "/commerce" as const;

export interface HttpApiHandlerOptions extends CommerceManifestOpts {
  prefix?: string;
  cors?: CorsOpts;
  fallthrough?: Fallthrough;
}

type ResponseSchema =
  | "capabilities"
  | "error"
  | "index"
  | "offer"
  | "policies"
  | "policy"
  | "products";
type Route = "index" | "products" | "policies" | "capabilities";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const schema of [
  commerceManifestSchema,
  capabilitiesResponseSchema,
  errorSchema,
  indexResponseSchema,
  offerSchema,
  policiesResponseSchema,
  policySchema,
  productsResponseSchema
]) {
  ajv.addSchema(schema);
}

const validators: Record<ResponseSchema, ValidateFunction> = {
  capabilities: loadValidator("https://steelyard.dev/schemas/http/0.1/capabilities_response.json"),
  error: loadValidator("https://steelyard.dev/schemas/http/0.1/error.json"),
  index: loadValidator("https://steelyard.dev/schemas/http/0.1/index_response.json"),
  offer: loadValidator("https://steelyard.dev/schemas/http/0.1/offer.json"),
  policies: loadValidator("https://steelyard.dev/schemas/http/0.1/policies_response.json"),
  policy: loadValidator("https://steelyard.dev/schemas/http/0.1/policy.json"),
  products: loadValidator("https://steelyard.dev/schemas/http/0.1/products_response.json")
};

export function createHttpApiHandler(manifest: Manifest, opts: HttpApiHandlerOptions = {}): RequestListener {
  const prefix = normalizePrefix(opts.prefix ?? HTTP_API_DEFAULT_PREFIX);
  const doc = commerceManifest(manifest, opts);
  const offers = doc.offers.map((offer) => structuredClone(offer));
  const policies = doc.policies.map((policy) => structuredClone(policy));
  const peers = structuredClone(doc.peers);

  return async function handleHttpApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = requestUrl(req);
    if (!isUnderPrefix(url.pathname, prefix)) {
      await invokeFallthrough(req, res, opts.fallthrough);
      return;
    }

    const route = routeFor(url.pathname, prefix);
    if (!route) {
      sendHttpError(req, res, 404, "not_found", "Not found", opts.cors);
      return;
    }

    if (req.method === "OPTIONS") {
      if (opts.cors) {
        sendOptions(req, res, opts.cors, ["GET", "HEAD", "OPTIONS"]);
        return;
      }
      sendHttpError(req, res, 405, "method_not_allowed", "Method not allowed", undefined, {
        allow: "GET, HEAD, OPTIONS"
      });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendHttpError(req, res, 405, "method_not_allowed", "Method not allowed", opts.cors, {
        allow: "GET, HEAD, OPTIONS"
      });
      return;
    }

    if (route === "index") {
      sendValidated(req, res, "index", {
        schema_version: doc.schema_version,
        links: {
          products: `${prefix}/products`,
          policies: `${prefix}/policies`,
          capabilities: `${prefix}/capabilities`
        }
      }, opts.cors);
      return;
    }

    if (route === "products") {
      const id = url.searchParams.get("id");
      if (id !== null) {
        const offer = offers.find((item) => item.id === id);
        if (!offer) {
          sendHttpError(req, res, 404, "not_found", `Unknown product id: ${id}`, opts.cors);
          return;
        }
        sendValidated(req, res, "offer", offer, opts.cors);
        return;
      }

      const filtered = filterOffers(offers, url);
      const offset = boundedInt(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER);
      const limit = boundedInt(url.searchParams.get("limit"), offers.length, 1000);
      sendValidated(
        req,
        res,
        "products",
        {
          products: filtered.slice(offset, offset + limit),
          total: filtered.length,
          offset,
          limit
        },
        opts.cors
      );
      return;
    }

    if (route === "policies") {
      const id = url.searchParams.get("id");
      if (id !== null) {
        const policy = policies.find((item) => item.id === id);
        if (!policy) {
          sendHttpError(req, res, 404, "not_found", `Unknown policy id: ${id}`, opts.cors);
          return;
        }
        sendValidated(req, res, "policy", policy, opts.cors);
        return;
      }

      sendValidated(req, res, "policies", { policies }, opts.cors);
      return;
    }

    sendValidated(req, res, "capabilities", { peers }, opts.cors);
  };
}

export type { CommerceManifestPeer, CorsOpts };

function filterOffers(offers: Offer[], url: URL): Offer[] {
  const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
  const category = url.searchParams.get("category");
  return offers.filter((offer) => {
    if (query && !offerMatchesQuery(offer, query)) return false;
    if (category && !offer.categories.includes(category)) return false;
    return true;
  });
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

function sendValidated(
  req: IncomingMessage,
  res: ServerResponse,
  schema: Exclude<ResponseSchema, "error">,
  body: unknown,
  cors?: CorsOpts
): void {
  const validate = validators[schema];
  if (!validate(body)) {
    sendHttpError(req, res, 500, "internal_error", "Internal error", cors, undefined, {
      validation: ajv.errorsText(validate.errors, { separator: "; " })
    });
    return;
  }

  sendJson(req, res, 200, body, { cors });
}

function sendHttpError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  code: ErrorEnvelope["error"]["code"],
  message: string,
  cors?: CorsOpts,
  headers?: Record<string, string | number>,
  details?: unknown
): void {
  const body: ErrorEnvelope = {
    error: details === undefined ? { code, message } : { code, message, details }
  };
  if (!validators.error(body)) {
    sendError(req, res, 500, "internal_error", "Internal error", { cors, headers });
    return;
  }
  sendJson(req, res, status, body, { cors, headers });
}

function routeFor(pathname: string, prefix: string): Route | undefined {
  if (pathname === prefix) return "index";
  if (pathname === `${prefix}/products`) return "products";
  if (pathname === `${prefix}/policies`) return "policies";
  if (pathname === `${prefix}/capabilities`) return "capabilities";
  return undefined;
}

function isUnderPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function normalizePrefix(prefix: string): string {
  const withSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

function boundedInt(value: string | null, defaultValue: number, max: number): number {
  if (value === null || value.trim() === "") return Math.min(defaultValue, max);

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.min(defaultValue, max);
  return Math.min(Math.max(Math.trunc(parsed), 0), max);
}

function loadValidator(schemaId: string): ValidateFunction {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`Unable to load HTTP response schema: ${schemaId}`);
  return validate;
}
