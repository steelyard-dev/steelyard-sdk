// Copyright (c) Mercato contributors. MIT License.
// Copyright (c) Steelyard contributors. MIT License.
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import availableInstrumentSchema from "../../spec/ucp/2026-04-17/schemas/shopping/types/available_payment_instrument.json";
import capabilitySchema from "../../spec/ucp/2026-04-17/schemas/capability.json";
import embeddedConfigSchema from "../../spec/ucp/2026-04-17/schemas/transports/embedded_config.json";
import handlerSchema from "../../spec/ucp/2026-04-17/schemas/payment_handler.json";
import profileSchema from "../../spec/ucp/2026-04-17/schemas/profile.json";
import reverseDomainNameSchema from "../../spec/ucp/2026-04-17/schemas/common/types/reverse_domain_name.json";
import serviceSchema from "../../spec/ucp/2026-04-17/schemas/service.json";
import ucpSchema from "../../spec/ucp/2026-04-17/schemas/ucp.json";
import { COMMERCE_MANIFEST_PATH, assertValidEcJwk, type EcJwk, type Manifest } from "@steelyard/core";

export const UCP_WELL_KNOWN_PATH = "/.well-known/ucp";
export const UCP_API_PATH = "/api";
export const UCP_VERSION = "2026-04-17";
export const UCP_SHOPPING_SERVICE = "dev.ucp.shopping";
export const UCP_CHECKOUT_CAPABILITY = "dev.ucp.shopping.checkout";
export const UCP_CATALOG_SEARCH_CAPABILITY = "dev.ucp.shopping.catalog.search";
export const UCP_CATALOG_LOOKUP_CAPABILITY = "dev.ucp.shopping.catalog.lookup";
export const STEELYARD_CHECKOUT_MANDATE_V01 = "net.steelyard.checkout_mandate.v0_1";

export interface UcpEntity {
  id?: string;
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
  signing_keys?: UcpPublicSigningKey[];
  merchant: { name: string; domain?: string };
  links: { commerce_manifest: string };
}

export type UcpPublicSigningKey = Omit<EcJwk, "d">;

export interface UcpDiscoveryHmsConfig {
  enabled: boolean;
  signingKeys: readonly EcJwk[];
}

export interface UcpDiscoveryOptions {
  baseUrl: string;
  checkout?: boolean;
  steelyardMandate?: boolean;
  ucp?: {
    auth?: {
      hms?: UcpDiscoveryHmsConfig;
    };
  };
}

export interface UcpValidationResult {
  valid: boolean;
  errors: ErrorObject[] | null | undefined;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const discoverySchemas = [
  reverseDomainNameSchema,
  embeddedConfigSchema,
  availableInstrumentSchema,
  ucpSchema,
  serviceSchema,
  capabilitySchema,
  handlerSchema,
  profileSchema
];
for (const schema of discoverySchemas) {
  ajv.addSchema(schema);
}

const validateBusinessProfile = loadBusinessProfileValidator();

export function buildUcpDiscovery(
  manifest: Manifest,
  opts: UcpDiscoveryOptions
): UcpDiscoveryDoc {
  const base = opts.baseUrl.replace(/\/$/, "");
  const capabilities: Record<string, UcpEntity[]> = {};
  if (opts.checkout) {
    capabilities[UCP_CHECKOUT_CAPABILITY] = [{
      version: UCP_VERSION,
      spec: `https://ucp.dev/${UCP_VERSION}/specification/checkout`,
      schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/checkout.json`
    }];
  }
  capabilities[UCP_CATALOG_SEARCH_CAPABILITY] = [{
    version: UCP_VERSION,
    spec: `https://ucp.dev/${UCP_VERSION}/specification/catalog-search`,
    schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_search.json`
  }];
  capabilities[UCP_CATALOG_LOOKUP_CAPABILITY] = [{
    version: UCP_VERSION,
    spec: `https://ucp.dev/${UCP_VERSION}/specification/catalog-lookup`,
    schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_lookup.json`
  }];
  if (opts.steelyardMandate) {
    capabilities[STEELYARD_CHECKOUT_MANDATE_V01] = [
      {
        version: UCP_VERSION,
        spec: "https://steelyard.dev/specification/checkout-mandate-v0.1",
        schema: "https://steelyard.dev/schemas/checkout-mandate-v0.1.json"
      }
    ];
  }
  const doc: UcpDiscoveryDoc = {
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
      capabilities,
      payment_handlers: {}
    },
    merchant: { name: manifest.identity.name, domain: manifest.identity.domain },
    links: {
      // Steelyard-defined UCP profile link relation; not a UCP core relation.
      commerce_manifest: `${base}${COMMERCE_MANIFEST_PATH}`
    }
  };
  const hms = opts.ucp?.auth?.hms;
  if (hms?.enabled) {
    if (hms.signingKeys.length === 0) {
      throw new Error("ucp.auth.hms.signingKeys is required when HMS is enabled");
    }
    doc.signing_keys = hms.signingKeys.map(publicSigningKey);
  }
  return doc;
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

function publicSigningKey(value: EcJwk): UcpPublicSigningKey {
  const jwk = assertValidEcJwk(value, { allowPrivate: true });
  return {
    kid: jwk.kid,
    kty: "EC",
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    ...(jwk.use ? { use: jwk.use } : {}),
    ...(jwk.alg ? { alg: jwk.alg } : {})
  };
}
