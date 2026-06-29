// Copyright (c) Steelyard contributors. MIT License.
import { createHash, createPublicKey, verify as cryptoVerify, type JsonWebKey as NodeJsonWebKey } from "node:crypto";
import { canonicalizeForSigning, systemClock, type Checkout, type JsonWebKey } from "@steelyard-dev/core";

export interface MandateEnvelope {
  "steelyard.checkout_mandate"?: string;
  ap2?: { checkout_mandate?: string };
  [key: string]: unknown;
}

export type MandateVerificationResult =
  | { ok: true; subject_id: string; key_id: string }
  | { ok: false; reason: string };

export interface MandateVerifier {
  verify(
    envelope: MandateEnvelope,
    expectedCheckout: Checkout,
    expectedAudience: string
  ): Promise<MandateVerificationResult>;
}

export interface JWKSet {
  keys: JsonWebKey[];
}

export type TrustedKeys = JWKSet | ((keyId: string) => Promise<JsonWebKey | null> | JsonWebKey | null);

export interface SteelyardJwsVerifierOptions {
  trustedKeys: TrustedKeys;
  mode: "enabled" | "disabled";
  clock?: () => Date;
}

export interface MockMandateVerifierOptions {
  allowInProduction?: boolean;
  alwaysOk?: boolean | { subject_id?: string; key_id?: string };
  alwaysReason?: string;
}

interface ParsedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Buffer;
  signingInput: string;
}

const STEELYARD_MANDATE_VERSION = "v0.1";

export class MockMandateInProductionError extends Error {
  constructor() {
    super(
      "mockMandateVerifier() refused outside a known test environment. Use steelyardJwsVerifier() for real mandate verification. " +
        "For demo/staging: pass allowInProduction: true AND set STEELYARD_ALLOW_MOCK_MANDATE=1."
    );
    this.name = "MockMandateInProductionError";
  }
}

export function steelyardJwsVerifier(opts: SteelyardJwsVerifierOptions): MandateVerifier {
  return {
    async verify(envelope, expectedCheckout, expectedAudience) {
      const token = envelope["steelyard.checkout_mandate"];
      if (opts.mode === "disabled" && typeof token === "string") return fail("steelyard_mode_not_enabled");
      if (token !== undefined && typeof token !== "string") return fail("invalid_mandate");
      if (!token) return fail(hasAp2Mandate(envelope) ? "wrong_namespace" : "missing_mandate");

      const parsed = parseCompactJws(token);
      if (!parsed.ok) return fail(parsed.reason);
      const { header, payload } = parsed.value;
      if (header.alg !== "EdDSA" || header.typ !== "JWT" || typeof header.kid !== "string") {
        return fail("invalid_header");
      }

      const key = await resolveTrustedKey(opts.trustedKeys, header.kid);
      if (!key) return fail("untrusted_key");
      if (!verifySignature(parsed.value, key)) return fail("invalid_signature");

      const keyId = keyIdForJwk(key);
      if (payload["steelyard:mandate_version"] !== STEELYARD_MANDATE_VERSION) {
        return fail("ap2:mandate_version" in payload ? "wrong_namespace" : "wrong_namespace");
      }
      if (payload.iss !== keyId) return fail("issuer_mismatch");
      if (typeof payload.sub !== "string" || !payload.sub) return fail("invalid_subject");
      if (payload.aud !== expectedAudience) return fail("audience_mismatch");

      const now = Math.floor((opts.clock ?? systemClock)().getTime() / 1000);
      if (typeof payload.iat !== "number" || !Number.isSafeInteger(payload.iat)) return fail("invalid_iat");
      if (payload.iat > now) return fail("issued_in_future");
      if (typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp)) return fail("invalid_exp");
      if (payload.exp <= now) return fail("expired");

      if (!sameCanonical(payload["steelyard:checkout"], canonicalMandateCheckout(expectedCheckout))) {
        return fail("checkout_mismatch");
      }
      const selected = selectedPaymentInstrument(expectedCheckout);
      if (!selected) return fail("selected_payment_missing");
      const credentialToken = credentialTokenFromInstrument(selected);
      if (!credentialToken) return fail("payment_credential_missing");
      const payment = asRecord(payload["steelyard:payment"]);
      if (payment.credential_id !== credentialToken) return fail("payment_credential_mismatch");
      if (payment.handler_id !== selected.handler_id) return fail("payment_handler_mismatch");

      return { ok: true, subject_id: payload.sub, key_id: keyId };
    }
  };
}

export function mockMandateVerifier(opts: MockMandateVerifierOptions = {}): MandateVerifier {
  assertMockAllowed(opts);
  return {
    async verify() {
      if (opts.alwaysReason) return fail(opts.alwaysReason);
      if (opts.alwaysOk === false) return fail("mock_mandate_rejected");
      const success = typeof opts.alwaysOk === "object" ? opts.alwaysOk : {};
      return {
        ok: true,
        subject_id: success.subject_id ?? "mock_subject",
        key_id: success.key_id ?? "mock_key"
      };
    }
  };
}

export function canonicalMandateCheckout(checkout: Checkout): unknown {
  return canonicalizeForSigning({
    id: checkout.id,
    line_items: checkout.line_items,
    totals: checkout.totals,
    currency: checkout.currency
  });
}

function fail(reason: string): MandateVerificationResult {
  return { ok: false, reason };
}

function parseCompactJws(jwt: string): { ok: true; value: ParsedJws } | { ok: false; reason: string } {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return { ok: false, reason: "invalid_jws" };
  try {
    return {
      ok: true,
      value: {
        header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>,
        payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>,
        signature: Buffer.from(parts[2], "base64url"),
        signingInput: `${parts[0]}.${parts[1]}`
      }
    };
  } catch {
    return { ok: false, reason: "invalid_jws" };
  }
}

async function resolveTrustedKey(trustedKeys: TrustedKeys, keyId: string): Promise<JsonWebKey | null> {
  if (typeof trustedKeys === "function") {
    const key = await trustedKeys(keyId);
    return key && keyIdForJwk(key) === keyId ? key : null;
  }
  for (const key of trustedKeys.keys) {
    if (keyIdForJwk(key) === keyId) return key;
  }
  return null;
}

function verifySignature(jws: ParsedJws, key: JsonWebKey): boolean {
  try {
    const publicKey = createPublicKey({ key: key as NodeJsonWebKey, format: "jwk" });
    return cryptoVerify(null, Buffer.from(jws.signingInput, "utf8"), publicKey, jws.signature);
  } catch {
    return false;
  }
}

function selectedPaymentInstrument(checkout: Checkout): Record<string, unknown> | undefined {
  const payment = asRecord(checkout.payment);
  const instruments = payment.instruments;
  if (!Array.isArray(instruments)) return undefined;
  const selected = instruments.find((instrument) => asRecord(instrument).selected === true);
  if (selected) return asRecord(selected);
  return instruments.length === 1 ? asRecord(instruments[0]) : undefined;
}

function credentialTokenFromInstrument(instrument: Record<string, unknown>): string | undefined {
  const credential = asRecord(instrument.credential);
  return typeof credential.token === "string" ? credential.token : undefined;
}

function hasAp2Mandate(envelope: MandateEnvelope): boolean {
  return (
    typeof asRecord(envelope.ap2).checkout_mandate === "string" ||
    typeof envelope["ap2.checkout_mandate"] === "string"
  );
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return (
      JSON.stringify(canonicalizeForSigning(left as Checkout)) ===
      JSON.stringify(canonicalizeForSigning(right as Checkout))
    );
  } catch {
    return false;
  }
}

function keyIdForJwk(jwk: JsonWebKey): string {
  const explicit = jwk.kid ?? jwk.key_id;
  if (typeof explicit === "string" && explicit) return explicit;
  const thumbprint = {
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x
  };
  return `mk_${createHash("sha256").update(JSON.stringify(thumbprint)).digest("base64url").slice(0, 32)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function assertMockAllowed(opts: MockMandateVerifierOptions): void {
  const isKnownTest = !!process.env.VITEST || !!process.env.JEST_WORKER_ID || !!process.env.STEELYARD_TEST;
  const bothOptIns = opts.allowInProduction === true && process.env.STEELYARD_ALLOW_MOCK_MANDATE === "1";
  if (!isKnownTest && !bothOptIns) throw new MockMandateInProductionError();
}
