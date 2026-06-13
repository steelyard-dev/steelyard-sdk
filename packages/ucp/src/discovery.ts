// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import availableInstrumentSchema from "../spec/2026-04-08/schemas/shopping/types/available_payment_instrument.json";
import capabilitySchema from "../spec/2026-04-08/schemas/capability.json";
import embeddedConfigSchema from "../spec/2026-04-08/schemas/transports/embedded_config.json";
import handlerSchema from "../spec/2026-04-08/schemas/payment_handler.json";
import profileSchema from "../spec/2026-04-08/schemas/profile.json";
import reverseDomainNameSchema from "../spec/2026-04-08/schemas/common/types/reverse_domain_name.json";
import serviceSchema from "../spec/2026-04-08/schemas/service.json";
import ucpSchema from "../spec/2026-04-08/schemas/ucp.json";
import type { Manifest } from "@steelyard/core";

export const UCP_WELL_KNOWN_PATH = "/.well-known/ucp";
export const UCP_API_PATH = "/api";
export const UCP_VERSION = "2026-04-08";
export const UCP_SHOPPING_SERVICE = "dev.ucp.shopping";
export const UCP_CATALOG_SEARCH_CAPABILITY = "dev.ucp.shopping.catalog.search";
export const UCP_CATALOG_LOOKUP_CAPABILITY = "dev.ucp.shopping.catalog.lookup";

export interface UcpEntity {
  version: string;
  spec?: string;
  schema?: string;
  endpoint?: string;
  transport?: "rest" | "mcp" | "a2a" | "embedded";
  extends?: string | string[];
  config?: Record<string, unknown>;
}

export interface UcpDiscoveryDoc {
  ucp: {
    version: string;
    services: Record<string, UcpEntity[]>;
    capabilities: Record<string, UcpEntity[]>;
    payment_handlers: Record<string, UcpEntity[]>;
  };
  merchant: { name: string; domain?: string };
  links: { commerce_manifest: string };
}

export interface UcpValidationResult {
  valid: boolean;
  errors: ErrorObject[] | null | undefined;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
[
  reverseDomainNameSchema,
  embeddedConfigSchema,
  availableInstrumentSchema,
  ucpSchema,
  serviceSchema,
  capabilitySchema,
  handlerSchema,
  profileSchema
].forEach((schema) => ajv.addSchema(schema));

const validateBusinessProfile = loadBusinessProfileValidator();

export function buildUcpDiscovery(
  manifest: Manifest,
  opts: { baseUrl: string }
): UcpDiscoveryDoc {
  const base = opts.baseUrl.replace(/\/$/, "");
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        [UCP_SHOPPING_SERVICE]: [
          {
            version: UCP_VERSION,
            spec: `https://ucp.dev/${UCP_VERSION}/specification/overview`,
            transport: "rest",
            schema: `https://ucp.dev/${UCP_VERSION}/services/shopping/rest.openapi.json`,
            endpoint: `${base}${UCP_API_PATH}`
          },
          {
            version: UCP_VERSION,
            spec: `https://ucp.dev/${UCP_VERSION}/specification/overview`,
            transport: "mcp",
            schema: `https://ucp.dev/${UCP_VERSION}/services/shopping/mcp.openrpc.json`,
            endpoint: `${base}/mcp`
          }
        ]
      },
      capabilities: {
        [UCP_CATALOG_SEARCH_CAPABILITY]: [
          {
            version: UCP_VERSION,
            spec: `https://ucp.dev/${UCP_VERSION}/specification/catalog-search`,
            schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_search.json`
          }
        ],
        [UCP_CATALOG_LOOKUP_CAPABILITY]: [
          {
            version: UCP_VERSION,
            spec: `https://ucp.dev/${UCP_VERSION}/specification/catalog-lookup`,
            schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_lookup.json`
          }
        ]
      },
      payment_handlers: {}
    },
    merchant: { name: manifest.identity.name, domain: manifest.identity.domain },
    links: { commerce_manifest: `${base}/commerce/manifest` }
  };
}

export function validateUcpDiscovery(doc: unknown): UcpValidationResult {
  const valid = validateBusinessProfile(doc);
  return { valid, errors: validateBusinessProfile.errors };
}

export function assertValidUcpDiscovery(doc: unknown): asserts doc is UcpDiscoveryDoc {
  const result = validateUcpDiscovery(doc);
  if (!result.valid) {
    throw new Error(`UCP discovery failed business profile validation: ${ajv.errorsText(result.errors)}`);
  }
}

function loadBusinessProfileValidator(): ValidateFunction<UcpDiscoveryDoc> {
  const validate = ajv.getSchema("https://ucp.dev/schemas/profile.json#/$defs/business_schema") as
    | ValidateFunction<UcpDiscoveryDoc>
    | undefined;
  if (!validate) throw new Error("Unable to load UCP business profile schema");
  return validate;
}
