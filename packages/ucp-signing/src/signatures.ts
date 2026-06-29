// Copyright (c) Steelyard contributors. MIT License.
import { createHash, timingSafeEqual } from "node:crypto";
import {
  assertValidEcJwk,
  buildSignatureBase,
  contentDigestHeader,
  ecdsaVerifyRaw,
  normalizeAuthority,
  parseSf941Dict,
  serializeSf941Dict,
  type EcJwk,
  type HmsAlgorithm,
  type Sf941InnerList,
  type SignatureParameters
} from "@steelyard-dev/core";
import type { UcpSigner } from "./signer.js";

export interface UcpOpaqueSigningMaterial {
  kid: string;
  algorithm: HmsAlgorithm;
  sign: (data: Uint8Array) => Promise<Uint8Array>;
}

export type UcpSigningMaterial = UcpOpaqueSigningMaterial;

export interface SignUcpRequestArgs {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: Uint8Array;
  signing: UcpSigningMaterial;
  ucpAgent: string;
  now: Date;
}

export interface SignUcpResponseArgs {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array;
  signing: UcpSigningMaterial;
  ucpAgent?: string;
  now: Date;
}

export type UcpRequestVerificationFailureReason =
  | "signature_missing"
  | "signature_invalid"
  | "key_not_found"
  | "digest_mismatch"
  | "algorithm_unsupported";

export type UcpRequestVerificationResult =
  | { ok: true; kid: string; algorithm: HmsAlgorithm; signerProfileUrl: string }
  | { ok: false; reason: UcpRequestVerificationFailureReason; detail?: string };

export interface VerifyUcpRequestArgs {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: Uint8Array;
  resolveKey: (kid: string, signerProfileUrl: string) => Promise<EcJwk | null>;
  now: Date;
}

export type UcpResponseVerificationResult =
  | { ok: true; kid: string; algorithm: HmsAlgorithm }
  | { ok: false; reason: UcpRequestVerificationFailureReason; detail?: string };

export interface VerifyUcpResponseArgs {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array;
  resolveKey: (kid: string) => Promise<EcJwk | null>;
  now: Date;
}

export class UcpSignerMissingHeader extends Error {
  constructor(readonly header: string) {
    super(`UCP request signing requires ${header}`);
    this.name = "UcpSignerMissingHeader";
  }
}

interface ParsedSignatureInput {
  components: string[];
  parameters: SignatureParameters;
}

export async function signingMaterialFromUcpSigner(signer: UcpSigner): Promise<UcpOpaqueSigningMaterial> {
  const publicKey = assertValidEcJwk(await signer.publicJwk());
  const algorithm = algorithmForKey(publicKey);
  return {
    kid: publicKey.kid,
    algorithm,
    sign: (data) => signer.sign(data, algorithm)
  };
}

export async function signUcpRequest(args: SignUcpRequestArgs): Promise<{ headers: Record<string, string> }> {
  const method = args.method.toUpperCase();
  const headers = lowerCaseHeaders(args.headers);
  headers["ucp-agent"] = args.ucpAgent;

  if (isMutatingMethod(method) && !headers["idempotency-key"]) {
    throw new UcpSignerMissingHeader("idempotency-key");
  }
  if (args.body !== undefined) {
    if (!headers["content-type"]) throw new UcpSignerMissingHeader("content-type");
    headers["content-digest"] = contentDigestHeader({ body: args.body });
  }

  const components = ucpRequestComponents(method, args.url, args.body);
  const parameters = { keyid: args.signing.kid };
  const signatureBase = buildSignatureBase({
    method,
    authority: normalizeAuthority(args.url),
    path: args.url.pathname || "/",
    query: args.url.search || undefined,
    headers,
    components,
    parameters
  });
  const signature = await signRaw(args.signing, signatureBase);

  headers["signature-input"] = serializeSf941Dict({
    sig1: {
      kind: "inner-list",
      value: components.map((component) => ({ value: component })),
      params: parameters
    }
  });
  headers.signature = serializeSf941Dict({ sig1: { value: signature } });
  return { headers };
}

export async function signUcpResponse(args: SignUcpResponseArgs): Promise<{ headers: Record<string, string> }> {
  const headers = lowerCaseHeaders(args.headers);
  if (args.body !== undefined) {
    if (!headers["content-type"]) throw new UcpSignerMissingHeader("content-type");
    headers["content-digest"] = contentDigestHeader({ body: args.body });
  }

  const components = ucpResponseComponents(args.body);
  const parameters = { keyid: args.signing.kid };
  const signatureBase = buildSignatureBase({
    status: args.status,
    headers,
    components,
    parameters
  });
  const signature = await signRaw(args.signing, signatureBase);

  headers["signature-input"] = serializeSf941Dict({
    sig1: {
      kind: "inner-list",
      value: components.map((component) => ({ value: component })),
      params: parameters
    }
  });
  headers.signature = serializeSf941Dict({ sig1: { value: signature } });
  return { headers };
}

export async function verifyUcpRequest(args: VerifyUcpRequestArgs): Promise<UcpRequestVerificationResult> {
  const method = args.method.toUpperCase();
  const headers = lowerCaseHeaders(args.headers);
  const signatureInputHeader = headers["signature-input"];
  const signatureHeader = headers.signature;
  if (!signatureInputHeader || !signatureHeader) return { ok: false, reason: "signature_missing" };

  const signatureInput = parseSignatureInput(signatureInputHeader);
  if (!signatureInput) return { ok: false, reason: "signature_invalid", detail: "signature_input_invalid" };
  const signature = parseSignature(signatureHeader);
  if (!signature) return { ok: false, reason: "signature_invalid", detail: "signature_invalid_format" };

  const missing = missingMandatoryHeader(method, headers, args.body);
  if (missing) {
    return { ok: false, reason: "signature_invalid", detail: `mandatory_header_missing: ${missing}` };
  }

  const signerProfileUrl = parseUcpAgentProfileUrl(headers["ucp-agent"]!);
  if (!signerProfileUrl) return { ok: false, reason: "signature_invalid", detail: "ucp_agent_invalid" };

  const missingComponent = missingRequiredComponent(ucpRequestComponents(method, args.url, args.body), signatureInput.components);
  if (missingComponent) {
    return { ok: false, reason: "signature_invalid", detail: `required_component_not_covered: ${missingComponent}` };
  }

  const digestOk = verifyContentDigest(headers["content-digest"], args.body);
  if (!digestOk) return { ok: false, reason: "digest_mismatch" };

  const key = await args.resolveKey(signatureInput.parameters.keyid, signerProfileUrl);
  if (!key) return { ok: false, reason: "key_not_found" };
  let algorithm: HmsAlgorithm;
  try {
    algorithm = algorithmForKey(key);
  } catch (error) {
    return {
      ok: false,
      reason: "algorithm_unsupported",
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  let signatureBase: Uint8Array;
  try {
    signatureBase = buildSignatureBase({
      method,
      authority: normalizeAuthority(args.url),
      path: args.url.pathname || "/",
      query: args.url.search || undefined,
      headers,
      components: signatureInput.components,
      parameters: signatureInput.parameters
    });
  } catch (error) {
    return {
      ok: false,
      reason: "signature_invalid",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
  const ok = await ecdsaVerifyRaw({
    algorithm,
    publicKeyJwk: key,
    data: signatureBase,
    signature
  });
  return ok
    ? { ok: true, kid: signatureInput.parameters.keyid, algorithm, signerProfileUrl }
    : { ok: false, reason: "signature_invalid" };
}

export async function verifyUcpResponse(args: VerifyUcpResponseArgs): Promise<UcpResponseVerificationResult> {
  const headers = lowerCaseHeaders(args.headers);
  const signatureInputHeader = headers["signature-input"];
  const signatureHeader = headers.signature;
  if (!signatureInputHeader || !signatureHeader) return { ok: false, reason: "signature_missing" };

  const signatureInput = parseSignatureInput(signatureInputHeader);
  if (!signatureInput) return { ok: false, reason: "signature_invalid", detail: "signature_input_invalid" };
  const signature = parseSignature(signatureHeader);
  if (!signature) return { ok: false, reason: "signature_invalid", detail: "signature_invalid_format" };

  const missing = missingResponseMandatoryHeader(headers, args.body);
  if (missing) {
    return { ok: false, reason: "signature_invalid", detail: `mandatory_header_missing: ${missing}` };
  }

  const missingComponent = missingRequiredComponent(ucpResponseComponents(args.body), signatureInput.components);
  if (missingComponent) {
    return { ok: false, reason: "signature_invalid", detail: `required_component_not_covered: ${missingComponent}` };
  }

  const digestOk = verifyContentDigest(headers["content-digest"], args.body);
  if (!digestOk) return { ok: false, reason: "digest_mismatch" };

  const key = await args.resolveKey(signatureInput.parameters.keyid);
  if (!key) return { ok: false, reason: "key_not_found" };
  let algorithm: HmsAlgorithm;
  try {
    algorithm = algorithmForKey(key);
  } catch (error) {
    return {
      ok: false,
      reason: "algorithm_unsupported",
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  let signatureBase: Uint8Array;
  try {
    signatureBase = buildSignatureBase({
      status: args.status,
      headers,
      components: signatureInput.components,
      parameters: signatureInput.parameters
    });
  } catch (error) {
    return {
      ok: false,
      reason: "signature_invalid",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
  const ok = await ecdsaVerifyRaw({
    algorithm,
    publicKeyJwk: key,
    data: signatureBase,
    signature
  });
  return ok ? { ok: true, kid: signatureInput.parameters.keyid, algorithm } : { ok: false, reason: "signature_invalid" };
}

export function parseUcpAgentProfileUrl(value: string): string | null {
  try {
    const profile = parseSf941Dict(value).profile;
    if (!profile || "kind" in profile) return null;
    if (typeof profile.value !== "string" || !profile.value) return null;
    new URL(profile.value);
    return profile.value;
  } catch {
    return null;
  }
}

function parseSignatureInput(value: string): ParsedSignatureInput | null {
  try {
    const sig1 = parseSf941Dict(value).sig1;
    if (!sig1 || !isInnerList(sig1)) return null;
    const params = sig1.params ?? {};
    if ("alg" in params) return null;
    const allowed = new Set(["keyid", "created", "expires", "nonce"]);
    for (const name of Object.keys(params)) {
      if (!allowed.has(name)) return null;
    }
    if (typeof params.keyid !== "string" || !params.keyid) return null;
    const parameters: SignatureParameters = { keyid: params.keyid };
    if (params.created !== undefined) {
      if (typeof params.created !== "number" || !Number.isSafeInteger(params.created)) return null;
      parameters.created = params.created;
    }
    if (params.expires !== undefined) {
      if (typeof params.expires !== "number" || !Number.isSafeInteger(params.expires)) return null;
      parameters.expires = params.expires;
    }
    if (params.nonce !== undefined) {
      if (typeof params.nonce !== "string") return null;
      parameters.nonce = params.nonce;
    }
    const components: string[] = [];
    for (const item of sig1.value) {
      if (typeof item.value !== "string" || item.params) return null;
      components.push(item.value);
    }
    return { components, parameters };
  } catch {
    return null;
  }
}

function parseSignature(value: string): Uint8Array | null {
  try {
    const sig1 = parseSf941Dict(value).sig1;
    if (!sig1 || "kind" in sig1 || !(sig1.value instanceof Uint8Array)) return null;
    return sig1.value;
  } catch {
    return null;
  }
}

function ucpRequestComponents(method: string, url: URL, body: Uint8Array | undefined): string[] {
  const components = ["@method", "@authority", "@path"];
  if (url.search) components.push("@query");
  components.push("ucp-agent");
  if (isMutatingMethod(method)) components.push("idempotency-key");
  if (body !== undefined) components.push("content-digest", "content-type");
  return components;
}

function ucpResponseComponents(body: Uint8Array | undefined): string[] {
  const components = ["@status"];
  if (body !== undefined) components.push("content-digest", "content-type");
  return components;
}

function missingMandatoryHeader(
  method: string,
  headers: Record<string, string>,
  body: Uint8Array | undefined
): string | undefined {
  if (!headers["ucp-agent"]) return "ucp-agent";
  if (isMutatingMethod(method) && !headers["idempotency-key"]) return "idempotency-key";
  if (body !== undefined && !headers["content-type"]) return "content-type";
  if (body !== undefined && !headers["content-digest"]) return "content-digest";
  return undefined;
}

function missingResponseMandatoryHeader(headers: Record<string, string>, body: Uint8Array | undefined): string | undefined {
  if (body !== undefined && !headers["content-type"]) return "content-type";
  if (body !== undefined && !headers["content-digest"]) return "content-digest";
  return undefined;
}

function missingRequiredComponent(required: string[], covered: string[]): string | undefined {
  const coveredSet = new Set(covered);
  return required.find((component) => !coveredSet.has(component));
}

function verifyContentDigest(value: string | undefined, body: Uint8Array | undefined): boolean {
  if (!value) return body === undefined;
  try {
    const sha256 = parseSf941Dict(value)["sha-256"];
    if (!sha256 || "kind" in sha256 || !(sha256.value instanceof Uint8Array)) return false;
    const expected = createHash("sha256").update(body ?? Buffer.alloc(0)).digest();
    return sha256.value.byteLength === expected.byteLength && timingSafeEqual(Buffer.from(sha256.value), expected);
  } catch {
    return false;
  }
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value.trim();
  return out;
}

function isMutatingMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH";
}

function algorithmForKey(key: EcJwk): HmsAlgorithm {
  const valid = assertValidEcJwk(key);
  return valid.crv === "P-256" ? "ES256" : "ES384";
}

async function signRaw(signing: UcpSigningMaterial, signatureBase: Uint8Array): Promise<Uint8Array> {
  const signature = await signing.sign(signatureBase);
  const expectedLength = signing.algorithm === "ES256" ? 64 : 96;
  if (signature.byteLength !== expectedLength) {
    throw new Error(`UCP ${signing.algorithm} signer returned ${signature.byteLength} bytes, expected ${expectedLength}`);
  }
  return signature;
}

function isInnerList(value: unknown): value is Sf941InnerList {
  return !!value && typeof value === "object" && "kind" in value && value.kind === "inner-list";
}
