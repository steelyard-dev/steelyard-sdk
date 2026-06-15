// Copyright (c) Steelyard contributors. MIT License.
import { createHash } from "node:crypto";
import { SDJwtInstance } from "@sd-jwt/core";
import {
  assertValidEcJwk,
  defaultClock,
  ecdsaVerifyRaw,
  jcsCanonicalize,
  verifyDetachedJws,
  type Ap2ErrorCode,
  type EcJwk,
  type HmsAlgorithm
} from "@steelyard/core";
import type { Checkout } from "@steelyard/protocol/ucp/checkout";
import { checkoutWithoutAp2 } from "./ap2.js";
import type { NonceStore } from "./nonce.js";
import type { MandateEnvelope } from "./verifier.js";

export type Ap2MandateFailureReason =
  | "shape_invalid"
  | "missing_kb_jwt"
  | "empty_segment"
  | "sd_jwt_header_invalid"
  | "sd_jwt_signature_invalid"
  | "issuer_key_missing"
  | "disclosure_invalid"
  | "disclosure_hash_not_in_payload"
  | "kb_jwt_typ_invalid"
  | "kb_jwt_header_invalid"
  | "kb_jwt_signature_invalid"
  | "kb_jwt_claims_invalid"
  | "sd_hash_mismatch"
  | "audience_mismatch"
  | "nonce_missing"
  | "nonce_expired"
  | "nonce_session_mismatch"
  | "nonce_already_consumed"
  | "iat_in_future"
  | "expired"
  | "checkout_missing"
  | "checkout_terms_mismatch"
  | "merchant_authorization_missing"
  | "merchant_authorization_invalid";

export type Ap2MandateVerificationResult =
  | {
      ok: true;
      subject_id: string;
      key_id: string;
      issuer: string;
      checkout: Checkout;
      claims: Record<string, unknown>;
    }
  | { ok: false; code: Ap2ErrorCode; reason: Ap2MandateFailureReason };

export interface Ap2MandateVerifier {
  verify(
    envelope: MandateEnvelope,
    expectedCheckout: Checkout,
    session_id: string
  ): Promise<Ap2MandateVerificationResult>;
}

export interface Ap2DigitalPaymentCredentialTrustModel {
  kind: "digital_payment_credential";
  resolveIssuerKey(args: {
    issuer: string;
    kid: string;
    alg: HmsAlgorithm;
    claims: Record<string, unknown>;
  }): Promise<EcJwk | null> | EcJwk | null;
}

export type Ap2MandateTrustModel = Ap2DigitalPaymentCredentialTrustModel;

export interface SdJwtKbVerifierOptions {
  trustModel: Ap2MandateTrustModel;
  expectedAudience: (checkout: Checkout) => string;
  nonceStore: NonceStore;
  merchantSigningKeys: EcJwk[];
  clock?: () => Date;
}

export type ParseSdJwtKbPresentationResult =
  | { ok: true; sdJwt: string; disclosures: string[]; kbJwt: string }
  | { ok: false; reason: "shape_invalid" | "missing_kb_jwt" | "empty_segment" };

export class Ap2MandateVerifierConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ap2MandateVerifierConfigError";
  }
}

export function sdJwtKbVerifier(opts: SdJwtKbVerifierOptions): Ap2MandateVerifier {
  const merchantKeys = publicKeyMap(opts.merchantSigningKeys);
  const clock = defaultClock(opts.clock);

  return {
    async verify(envelope, expectedCheckout, session_id) {
      const token = checkoutMandateFromEnvelope(envelope);
      if (token === undefined) return fail("mandate_required", "missing_kb_jwt");
      if (typeof token !== "string" || !token) return fail("mandate_invalid_signature", "shape_invalid");

      const parsed = parseSdJwtKbPresentation(token);
      if (!parsed.ok) return fail("mandate_invalid_signature", parsed.reason);

      const issuerJwt = decodeCompactJws(parsed.sdJwt);
      if (!issuerJwt) return fail("mandate_invalid_signature", "shape_invalid");
      const issuerAlg = hmsAlgorithm(issuerJwt.header.alg);
      const issuerKid = typeof issuerJwt.header.kid === "string" ? issuerJwt.header.kid : "";
      if (issuerJwt.header.typ !== "dc+sd-jwt" || !issuerAlg || !issuerKid) {
        return fail("mandate_invalid_signature", "sd_jwt_header_invalid");
      }
      const issuer = typeof issuerJwt.payload.iss === "string" ? issuerJwt.payload.iss : "";
      if (!issuer) return fail("mandate_invalid_signature", "sd_jwt_header_invalid");

      const issuerKey = await resolveIssuerKey(opts.trustModel, {
        issuer,
        kid: issuerKid,
        alg: issuerAlg,
        claims: issuerJwt.payload
      });
      if (!issuerKey) return fail("agent_missing_key", "issuer_key_missing");
      if (!(await verifyJwsSignature(issuerJwt, issuerAlg, issuerKey))) {
        return fail("mandate_invalid_signature", "sd_jwt_signature_invalid");
      }

      const disclosureCheck = await verifyDisclosureDigests(parsed.disclosures, issuerJwt.payload);
      if (!disclosureCheck.ok) return fail("mandate_invalid_signature", disclosureCheck.reason);

      const claims = await unpackClaims(token);
      if (!claims) return fail("mandate_invalid_signature", "disclosure_invalid");

      const kbJwt = decodeCompactJws(parsed.kbJwt);
      if (!kbJwt) return fail("mandate_invalid_signature", "shape_invalid");
      if (kbJwt.header.typ !== "kb+jwt") return fail("mandate_invalid_signature", "kb_jwt_typ_invalid");
      const kbAlg = hmsAlgorithm(kbJwt.header.alg);
      if (!kbAlg) return fail("mandate_invalid_signature", "kb_jwt_header_invalid");
      const holderKey = holderKeyFromClaims(claims);
      if (!holderKey) return fail("agent_missing_key", "issuer_key_missing");
      if (!(await verifyJwsSignature(kbJwt, kbAlg, holderKey))) {
        return fail("mandate_invalid_signature", "kb_jwt_signature_invalid");
      }

      const kbClaims = kbJwt.payload;
      const now = Math.floor(clock().getTime() / 1000);
      if (!validNumber(kbClaims.iat) || kbClaims.iat > now) {
        return fail("mandate_invalid_signature", "iat_in_future");
      }
      if (kbClaims.aud !== opts.expectedAudience(expectedCheckout)) {
        return fail("mandate_scope_mismatch", "audience_mismatch");
      }
      if (typeof kbClaims.nonce !== "string" || !kbClaims.nonce || typeof kbClaims.sd_hash !== "string") {
        return fail("mandate_invalid_signature", "kb_jwt_claims_invalid");
      }
      if (kbClaims.sd_hash !== sdHash(parsed)) {
        return fail("mandate_invalid_signature", "sd_hash_mismatch");
      }

      if (!validNumber(claims.exp)) return fail("mandate_invalid_signature", "kb_jwt_claims_invalid");
      if (claims.exp <= now) return fail("mandate_expired", "expired");

      const embeddedCheckout = checkoutFromClaims(claims);
      if (!embeddedCheckout) return fail("mandate_scope_mismatch", "checkout_missing");
      const merchantAuthorization = asRecord(asRecord(embeddedCheckout).ap2).merchant_authorization;
      if (typeof merchantAuthorization !== "string" || !merchantAuthorization) {
        return fail("merchant_authorization_missing", "merchant_authorization_missing");
      }
      const merchantAuthorizationResult = await verifyDetachedJws({
        jws: merchantAuthorization,
        payload: jcsCanonicalize(checkoutWithoutAp2(embeddedCheckout)),
        resolveKey: async (kid, alg) => merchantKeys.get(`${kid}:${alg}`) ?? null
      });
      if (!merchantAuthorizationResult.ok) {
        return fail("merchant_authorization_invalid", "merchant_authorization_invalid");
      }
      if (!checkoutTermsMatch(embeddedCheckout, expectedCheckout)) {
        return fail("mandate_scope_mismatch", "checkout_terms_mismatch");
      }

      const nonceResult = await opts.nonceStore.consume({ nonce: kbClaims.nonce, session_id });
      if (!nonceResult.ok) {
        return fail("mandate_invalid_signature", `nonce_${nonceResult.reason}` as Ap2MandateFailureReason);
      }

      return {
        ok: true,
        subject_id: typeof claims.sub === "string" && claims.sub ? claims.sub : issuer,
        key_id: holderKey.kid,
        issuer,
        checkout: embeddedCheckout,
        claims
      };
    }
  };
}

export function parseSdJwtKbPresentation(value: string): ParseSdJwtKbPresentationResult {
  const segments = value.split("~");
  if (segments.length < 2) return { ok: false, reason: "missing_kb_jwt" };
  if (!segments[segments.length - 1]) return { ok: false, reason: "missing_kb_jwt" };
  if (segments.some((segment) => segment === "")) return { ok: false, reason: "empty_segment" };
  const sdJwt = segments[0]!;
  const kbJwt = segments[segments.length - 1]!;
  const disclosures = segments.slice(1, -1);
  if (!isCompactJws(sdJwt) || !isCompactJws(kbJwt)) return { ok: false, reason: "shape_invalid" };
  if (!disclosures.every(isDisclosureSegment)) return { ok: false, reason: "shape_invalid" };
  return { ok: true, sdJwt, disclosures, kbJwt };
}

function checkoutMandateFromEnvelope(envelope: MandateEnvelope): unknown {
  const nested = asRecord(envelope.ap2).checkout_mandate;
  return nested ?? envelope["ap2.checkout_mandate"];
}

async function resolveIssuerKey(
  trustModel: Ap2MandateTrustModel,
  args: { issuer: string; kid: string; alg: HmsAlgorithm; claims: Record<string, unknown> }
): Promise<EcJwk | null> {
  if (trustModel.kind !== "digital_payment_credential") return null;
  const key = await trustModel.resolveIssuerKey(args);
  if (!key) return null;
  try {
    const valid = assertValidEcJwk(key);
    return valid.kid === args.kid && algorithmForKey(valid) === args.alg ? valid : null;
  } catch {
    return null;
  }
}

function publicKeyMap(keys: EcJwk[]): Map<string, EcJwk> {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Ap2MandateVerifierConfigError("AP2 mandate verifier merchantSigningKeys is required");
  }
  const map = new Map<string, EcJwk>();
  for (const key of keys) {
    const valid = assertValidEcJwk(key);
    map.set(`${valid.kid}:${algorithmForKey(valid)}`, valid);
  }
  return map;
}

interface DecodedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Uint8Array;
  signingInput: string;
}

function decodeCompactJws(value: string): DecodedJws | null {
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (!isRecord(header) || !isRecord(payload)) return null;
    return {
      header,
      payload,
      signature: Buffer.from(parts[2], "base64url"),
      signingInput: `${parts[0]}.${parts[1]}`
    };
  } catch {
    return null;
  }
}

async function verifyJwsSignature(jws: DecodedJws, alg: HmsAlgorithm, key: EcJwk): Promise<boolean> {
  try {
    return await ecdsaVerifyRaw({
      algorithm: alg,
      publicKeyJwk: key,
      data: Buffer.from(jws.signingInput, "utf8"),
      signature: jws.signature
    });
  } catch {
    return false;
  }
}

async function verifyDisclosureDigests(
  disclosures: string[],
  payload: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; reason: "disclosure_invalid" | "disclosure_hash_not_in_payload" }> {
  const alg = typeof payload._sd_alg === "string" ? payload._sd_alg : "sha-256";
  if (alg !== "sha-256") return { ok: false, reason: "disclosure_invalid" };
  const digests = collectSdDigests(payload);
  for (const disclosure of disclosures) {
    if (!validDisclosureJson(disclosure)) return { ok: false, reason: "disclosure_invalid" };
    const digest = createHash("sha256").update(Buffer.from(disclosure, "utf8")).digest("base64url");
    if (!digests.has(digest)) return { ok: false, reason: "disclosure_hash_not_in_payload" };
  }
  return { ok: true };
}

function collectSdDigests(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectSdDigests(item, out);
    return out;
  }
  if (!isRecord(value)) return out;
  const sd = value._sd;
  if (Array.isArray(sd)) {
    for (const digest of sd) if (typeof digest === "string") out.add(digest);
  }
  for (const item of Object.values(value)) collectSdDigests(item, out);
  return out;
}

function validDisclosureJson(value: string): boolean {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    return Array.isArray(decoded) && (decoded.length === 2 || decoded.length === 3);
  } catch {
    return false;
  }
}

async function unpackClaims(value: string): Promise<Record<string, unknown> | null> {
  try {
    const sdJwt = new SDJwtInstance<Record<string, unknown>>({
      hasher: sha256Hasher,
      hashAlg: "sha-256"
    });
    const claims = await sdJwt.getClaims(value);
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

function holderKeyFromClaims(claims: Record<string, unknown>): EcJwk | null {
  try {
    return assertValidEcJwk(asRecord(claims.cnf).jwk);
  } catch {
    return null;
  }
}

function checkoutFromClaims(claims: Record<string, unknown>): Checkout | null {
  const checkout = claims["ap2:checkout"];
  return isRecord(checkout) ? cloneJson(checkout) as Checkout : null;
}

function checkoutTermsMatch(left: Checkout, right: Checkout): boolean {
  return (
    sameCanonical(asRecord(left).id, asRecord(right).id) &&
    sameCanonical(asRecord(left).currency, asRecord(right).currency) &&
    sameCanonical(asRecord(left).line_items, asRecord(right).line_items) &&
    sameCanonical(asRecord(left).totals, asRecord(right).totals)
  );
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return Buffer.from(jcsCanonicalize(left)).equals(Buffer.from(jcsCanonicalize(right)));
  } catch {
    return false;
  }
}

function sdHash(parsed: { sdJwt: string; disclosures: string[] }): string {
  const input = `${parsed.sdJwt}~${parsed.disclosures.map((disclosure) => `${disclosure}~`).join("")}`;
  return createHash("sha256").update(Buffer.from(input, "utf8")).digest("base64url");
}

async function sha256Hasher(data: string | ArrayBuffer, alg: string): Promise<Uint8Array> {
  const normalized = alg.toLowerCase();
  if (normalized !== "sha-256" && normalized !== "sha256") {
    throw new Error(`unsupported SD-JWT hash algorithm: ${alg}`);
  }
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return createHash("sha256").update(bytes).digest();
}

function hmsAlgorithm(value: unknown): HmsAlgorithm | null {
  return value === "ES256" || value === "ES384" ? value : null;
}

function algorithmForKey(key: EcJwk): HmsAlgorithm {
  return key.crv === "P-384" || key.alg === "ES384" ? "ES384" : "ES256";
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isCompactJws(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part));
}

function isDisclosureSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value) && !value.includes(".");
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fail(code: Ap2ErrorCode, reason: Ap2MandateFailureReason): Ap2MandateVerificationResult {
  return { ok: false, code, reason };
}
