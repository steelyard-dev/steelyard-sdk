// Copyright (c) Steelyard contributors. MIT License.
import { createHash } from "node:crypto";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import canonicalize from "canonicalize";
import commerceManifestSchema from "../spec/commerce-manifest/0.1/commerce-manifest.schema.json";
import { defaultClock } from "./clock.js";
import type { Manifest, Policy } from "./schemas.js";
import type {
  CommerceManifestDoc,
  CommerceManifestPeer,
  PeerName
} from "./generated/commerce-manifest.types.js";

export const COMMERCE_MANIFEST_PATH = "/.well-known/commerce.json" as const;
export const COMMERCE_MANIFEST_SCHEMA_VERSION = "0.1" as const;

export interface CommerceManifestOpts {
  peers?: Partial<Record<PeerName, CommerceManifestPeer>>;
  clock?: () => Date;
  generatedAt?: string;
}

export interface CommerceManifestValidationResult {
  valid: boolean;
  errors: ErrorObject[];
  doc?: CommerceManifestDoc;
}

export class DuplicateExplicitPolicyId extends Error {
  constructor(id: string) {
    super(`Duplicate explicit policy id: ${id}`);
    this.name = "DuplicateExplicitPolicyId";
  }
}

const DOMAIN_TAG = "CommerceManifest:v0.1:";
const UTC_INSTANT_WITH_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PEER_NAMES: PeerName[] = ["acp", "ucp", "mcp", "http"];

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(commerceManifestSchema);

const validateCommerceManifestDoc = loadCommerceManifestValidator();

export function commerceManifest(manifest: Manifest, opts: CommerceManifestOpts = {}): CommerceManifestDoc {
  const generatedAt = opts.generatedAt ?? defaultClock(opts.clock)().toISOString();
  if (!UTC_INSTANT_WITH_MILLIS.test(generatedAt)) {
    throw new Error("generatedAt must be a UTC ISO 8601 timestamp with milliseconds");
  }

  const doc: CommerceManifestDoc = {
    $schema: "https://steelyard.dev/schemas/commerce-manifest/0.1.json",
    schema_version: COMMERCE_MANIFEST_SCHEMA_VERSION,
    generated_at: generatedAt,
    identity: toJson(manifest.identity),
    offers: toJson(manifest.catalog.offers),
    policies: normalizePolicies(manifest.policies),
    peers: normalizePeers(opts.peers),
    content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  };
  doc.content_hash = canonicalCommerceManifestHash(doc);

  const result = validateCommerceManifest(doc);
  if (!result.valid) {
    throw new Error(`Commerce manifest failed validation: ${ajv.errorsText(result.errors)}`);
  }

  return doc;
}

export function validateCommerceManifest(doc: unknown): CommerceManifestValidationResult {
  const valid = validateCommerceManifestDoc(doc);
  const errors = validateCommerceManifestDoc.errors ? [...validateCommerceManifestDoc.errors] : [];
  if (!valid) return { valid: false, errors };

  const typedDoc = doc as CommerceManifestDoc;
  const expectedHash = canonicalCommerceManifestHash(typedDoc);
  if (typedDoc.content_hash !== expectedHash) {
    return {
      valid: false,
      errors: [
        {
          instancePath: "/content_hash",
          schemaPath: "#/properties/content_hash/checksum",
          keyword: "checksum",
          params: { expected: expectedHash },
          message: `must equal ${expectedHash}`
        }
      ]
    };
  }

  return { valid: true, errors: [], doc: typedDoc };
}

export function canonicalCommerceManifestHash(doc: CommerceManifestDoc): string {
  const { content_hash: _contentHash, ...withoutHash } = doc;
  const canonical = canonicalize(withoutHash);
  if (canonical === undefined) {
    throw new Error("Commerce manifest cannot be canonicalized");
  }

  const digest = createHash("sha256")
    .update(DOMAIN_TAG, "utf8")
    .update(canonical, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

type CommerceManifestPolicy = CommerceManifestDoc["policies"][number];

function normalizePolicies(policies: Policy[]): CommerceManifestDoc["policies"] {
  const reserved = new Set<string>();
  for (const policy of policies) {
    if (!policy.id) continue;
    if (reserved.has(policy.id)) throw new DuplicateExplicitPolicyId(policy.id);
    reserved.add(policy.id);
  }

  return policies.map((policy) => {
    const normalized = toJson(policy);
    if (normalized.id) return normalized as CommerceManifestPolicy;

    let candidate: string = normalized.type;
    let suffix = 2;
    while (reserved.has(candidate)) {
      candidate = `${normalized.type}-${suffix}`;
      suffix += 1;
    }
    reserved.add(candidate);

    return {
      ...normalized,
      id: candidate
    };
  });
}

function normalizePeers(peers: CommerceManifestOpts["peers"]): CommerceManifestDoc["peers"] {
  const normalized: CommerceManifestDoc["peers"] = {};
  if (!peers) return normalized;

  for (const peerName of PEER_NAMES) {
    const peer = peers[peerName];
    if (peer) normalized[peerName] = toJson(peer);
  }

  return normalized;
}

function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function loadCommerceManifestValidator(): ValidateFunction {
  const validate = ajv.getSchema("https://steelyard.dev/schemas/commerce-manifest/0.1.json");
  if (!validate) throw new Error("Commerce manifest schema failed to load");
  return validate;
}
