// Copyright (c) Steelyard contributors. MIT License.
import { createHash } from "node:crypto";
import { SDJwtInstance } from "@sd-jwt/core";
import {
  ecdsaSignRaw,
  jcsCanonicalize,
  signDetachedJws,
  type Ap2ErrorCode,
  type EcJwk,
  type HmsAlgorithm
} from "@steelyard/core";
import type { Checkout } from "@steelyard/protocol/ucp/checkout";
import { describe, expect, it } from "vitest";
import {
  Ap2MandateVerifierConfigError,
  parseSdJwtKbPresentation,
  sdJwtKbVerifier,
  memoryNonceStore,
  type Ap2MandateFailureReason,
  type Ap2MandateVerificationResult
} from "./index.js";

const now = new Date("2026-06-14T12:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const audience = "https://coffee.example/.well-known/ucp";
const issuer = "did:example:bank-dpc-issuer";
const sessionId = "checkout_123";

describe("sdJwtKbVerifier", () => {
  it("verifies SD-JWT, disclosures, KB-JWT, merchant authorization, terms, and nonce replay (VE5-2)", async () => {
    const nonceStore = memoryNonceStore({ clock: () => now });
    const nonce = await nonceStore.issue({ session_id: sessionId });
    const checkout = await signedCheckout();
    const checkoutMandate = await issueCheckoutMandate({ checkout, nonce: nonce.nonce, discloseEmail: true });
    const verifier = verifierFor(nonceStore);

    const result = await verifier.verify({ ap2: { checkout_mandate: checkoutMandate } }, checkout, sessionId);
    expect(result).toMatchObject({
      ok: true,
      subject_id: "buyer_123",
      key_id: holderP256PublicKey.kid,
      issuer
    });
    expect(result.ok && result.claims.buyer).toEqual({ email: "jane@example.com" });

    const replay = await verifier.verify({ ap2: { checkout_mandate: checkoutMandate } }, checkout, sessionId);
    expectFailure(replay, "mandate_invalid_signature", "nonce_already_consumed");
  });

  it("parses SD-JWT+KB presentation shape without applying the broken schema regex (SC5-2 prep)", async () => {
    const checkout = await signedCheckout();
    const nonceStore = memoryNonceStore({ clock: () => now });
    const nonce = await nonceStore.issue({ session_id: sessionId });
    const checkoutMandate = await issueCheckoutMandate({ checkout, nonce: nonce.nonce });
    const parsed = parseSdJwtKbPresentation(checkoutMandate);

    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.kbJwt.split(".")).toHaveLength(3);
      expect(parsed.disclosures).toEqual([]);
    }
    expect(parseSdJwtKbPresentation("issuer-only")).toEqual({ ok: false, reason: "missing_kb_jwt" });
    expect(parseSdJwtKbPresentation(`${parsed.ok ? parsed.sdJwt : "a.b.c"}~`)).toEqual({
      ok: false,
      reason: "missing_kb_jwt"
    });
    expect(parseSdJwtKbPresentation("a.b.c~~d.e.f")).toEqual({ ok: false, reason: "empty_segment" });
    expect(parseSdJwtKbPresentation("not-a-jws~also-not-jws")).toEqual({ ok: false, reason: "shape_invalid" });
    expect(parseSdJwtKbPresentation("a.b.c~abc.def~d.e.f")).toEqual({ ok: false, reason: "shape_invalid" });
  });

  it("maps malformed and untrusted mandates to AP2 error codes", async () => {
    const nonceStore = memoryNonceStore({ clock: () => now });
    const checkout = await signedCheckout();
    const nonce = await nonceStore.issue({ session_id: sessionId });
    const checkoutMandate = await issueCheckoutMandate({ checkout, nonce: nonce.nonce, discloseEmail: true });
    const verifier = verifierFor(nonceStore);

    expectFailure(
      await verifier.verify({}, checkout, sessionId),
      "mandate_required",
      "missing_kb_jwt"
    );
    expectFailure(
      await verifier.verify({ ap2: { checkout_mandate: `${checkoutMandate}~extra` } }, checkout, sessionId),
      "mandate_invalid_signature",
      "shape_invalid"
    );

    expectFailure(
      await verifier.verify({ ap2: { checkout_mandate: tamperIssuerPayload(checkoutMandate) } }, checkout, sessionId),
      "mandate_invalid_signature",
      "sd_jwt_signature_invalid"
    );

    const extraDisclosure = insertDisclosure(checkoutMandate, Buffer.from(JSON.stringify(["salt-x", "name", "Jane"])).toString("base64url"));
    expectFailure(
      await verifier.verify({ ap2: { checkout_mandate: extraDisclosure } }, checkout, sessionId),
      "mandate_invalid_signature",
      "disclosure_hash_not_in_payload"
    );

    const invalidDisclosure = insertDisclosure(checkoutMandate, "not-json");
    expectFailure(
      await verifier.verify({ ap2: { checkout_mandate: invalidDisclosure } }, checkout, sessionId),
      "mandate_invalid_signature",
      "disclosure_invalid"
    );

    const invalidIssuerHeader = await replaceIssuer(checkoutMandate, ({ header }) => {
      header.typ = "jwt";
    });
    expectFailure(
      await verifier.verify({ ap2: { checkout_mandate: invalidIssuerHeader } }, checkout, sessionId),
      "mandate_invalid_signature",
      "sd_jwt_header_invalid"
    );

    expectFailure(
      await verifierFor(nonceStore, { trustedIssuerKey: null }).verify(
        { ap2: { checkout_mandate: checkoutMandate } },
        checkout,
        sessionId
      ),
      "agent_missing_key",
      "issuer_key_missing"
    );
  });

  it("maps KB-JWT, audience, expiry, merchant authorization, and scope failures", async () => {
    const checkout = await signedCheckout();

    await expectVerifierFailure({
      checkout,
      mutate: async (mandate) => await replaceKb(mandate, { header: { typ: "jwt" } }),
      expected: ["mandate_invalid_signature", "kb_jwt_typ_invalid"]
    });
    await expectVerifierFailure({
      checkout,
      mutate: async (mandate) => await replaceKb(mandate, { header: { alg: "none" } }),
      expected: ["mandate_invalid_signature", "kb_jwt_header_invalid"]
    });
    await expectVerifierFailure({
      checkout,
      mutate: async (mandate) => await replaceKb(mandate, { payload: { sd_hash: "wrong" } }),
      expected: ["mandate_invalid_signature", "sd_hash_mismatch"]
    });
    await expectVerifierFailure({
      checkout,
      verifierAudience: "https://other.example/.well-known/ucp",
      expected: ["mandate_scope_mismatch", "audience_mismatch"]
    });
    await expectVerifierFailure({
      checkout,
      mutate: async (mandate) => await replaceKb(mandate, { payload: { iat: nowSeconds + 60 } }),
      expected: ["mandate_invalid_signature", "iat_in_future"]
    });
    await expectVerifierFailure({
      checkout,
      mutate: async (mandate) => await replaceKb(mandate, { payload: { nonce: "" } }),
      expected: ["mandate_invalid_signature", "kb_jwt_claims_invalid"]
    });
    await expectVerifierFailure({
      checkout,
      expiresInSeconds: -1,
      expected: ["mandate_expired", "expired"]
    });
    await expectVerifierFailure({
      checkout,
      mutate: async (mandate) => await replaceIssuer(mandate, ({ payload }) => {
        delete payload.cnf;
      }),
      expected: ["agent_missing_key", "issuer_key_missing"]
    });
    await expectVerifierFailure({
      checkout,
      mutate: async (mandate) => await replaceIssuer(mandate, ({ payload }) => {
        delete payload["ap2:checkout"];
      }, { refreshKbHash: true }),
      expected: ["mandate_scope_mismatch", "checkout_missing"]
    });

    const missingAuthCheckout = { ...sampleCheckout(), ap2: {} };
    await expectVerifierFailure({
      checkout: missingAuthCheckout,
      expectedCheckout: checkout,
      expected: ["merchant_authorization_missing", "merchant_authorization_missing"]
    });

    const invalidAuthCheckout = { ...sampleCheckout(), ap2: { merchant_authorization: "a..b" } };
    await expectVerifierFailure({
      checkout: invalidAuthCheckout,
      expectedCheckout: checkout,
      expected: ["merchant_authorization_invalid", "merchant_authorization_invalid"]
    });

    await expectVerifierFailure({
      checkout,
      expectedCheckout: { ...checkout, totals: [{ type: "total", amount: 999, display_text: "Total" }] },
      expected: ["mandate_scope_mismatch", "checkout_terms_mismatch"]
    });

    const nonceStore = memoryNonceStore({ clock: () => now });
    const missingNonceMandate = await issueCheckoutMandate({ checkout, nonce: "nonce-not-issued" });
    expectFailure(
      await verifierFor(nonceStore).verify({ ap2: { checkout_mandate: missingNonceMandate } }, checkout, sessionId),
      "mandate_invalid_signature",
      "nonce_missing"
    );

    expect(() =>
      sdJwtKbVerifier({
        trustModel: {
          kind: "digital_payment_credential",
          resolveIssuerKey: () => holderP256PublicKey
        },
        expectedAudience: () => audience,
        nonceStore,
        merchantSigningKeys: []
      })
    ).toThrow(Ap2MandateVerifierConfigError);
  });
});

async function expectVerifierFailure(args: {
  checkout: Checkout;
  expectedCheckout?: Checkout;
  mutate?: (mandate: string) => Promise<string>;
  expiresInSeconds?: number;
  verifierAudience?: string;
  expected: [Ap2ErrorCode, Ap2MandateFailureReason];
}): Promise<void> {
  const nonceStore = memoryNonceStore({ clock: () => now });
  const nonce = await nonceStore.issue({ session_id: sessionId });
  const issued = await issueCheckoutMandate({
    checkout: args.checkout,
    nonce: nonce.nonce,
    expiresInSeconds: args.expiresInSeconds
  });
  const mandate = args.mutate ? await args.mutate(issued) : issued;
  const verifier = verifierFor(nonceStore, { audience: args.verifierAudience });
  const result = await verifier.verify({ ap2: { checkout_mandate: mandate } }, args.expectedCheckout ?? args.checkout, sessionId);
  expectFailure(result, args.expected[0], args.expected[1]);
}

function verifierFor(
  nonceStore: ReturnType<typeof memoryNonceStore>,
  opts: { trustedIssuerKey?: EcJwk | null; audience?: string } = {}
) {
  return sdJwtKbVerifier({
    trustModel: {
      kind: "digital_payment_credential",
      resolveIssuerKey: ({ kid, alg }) => {
        const key = opts.trustedIssuerKey === undefined ? holderP256PublicKey : opts.trustedIssuerKey;
        return key?.kid === kid && key.alg === alg ? key : null;
      }
    },
    expectedAudience: () => opts.audience ?? audience,
    nonceStore,
    merchantSigningKeys: [merchantP256PublicKey],
    clock: () => now
  });
}

async function signedCheckout(overrides: Partial<Checkout> = {}): Promise<Checkout> {
  const unsigned = sampleCheckout(overrides);
  const merchantAuthorization = await signDetachedJws({
    payload: jcsCanonicalize(unsigned),
    header: { alg: "ES256", kid: merchantP256PrivateKey.kid },
    privateKey: merchantP256PrivateKey
  });
  return {
    ...unsigned,
    ap2: { ...asRecord(overrides.ap2), merchant_authorization: merchantAuthorization }
  };
}

async function issueCheckoutMandate(args: {
  checkout: Checkout;
  nonce: string;
  discloseEmail?: boolean;
  expiresInSeconds?: number;
}): Promise<string> {
  const exp = nowSeconds + (args.expiresInSeconds ?? 300);
  const claims = {
    iss: issuer,
    sub: "buyer_123",
    iat: nowSeconds,
    exp,
    aud: audience,
    cnf: { jwk: holderP256PublicKey },
    "ap2:checkout": args.checkout,
    buyer: { email: "jane@example.com" }
  };
  const sdJwt = new SDJwtInstance<typeof claims>({
    signer: signerFor(holderP256PrivateKey, "ES256"),
    signAlg: "ES256",
    kbSigner: signerFor(holderP256PrivateKey, "ES256"),
    kbSignAlg: "ES256",
    hasher: sha256Hasher,
    hashAlg: "sha-256",
    saltGenerator: saltSequence()
  });
  const issued = await sdJwt.issue(claims, { buyer: { _sd: ["email"] } }, { header: { typ: "dc+sd-jwt", kid: holderP256PublicKey.kid } });
  return await sdJwt.present(issued, args.discloseEmail ? { buyer: { email: true } } : {}, {
    kb: { payload: { iat: nowSeconds, aud: audience, nonce: args.nonce } }
  });
}

async function replaceKb(
  mandate: string,
  replacement: { header?: Record<string, unknown>; payload?: Record<string, unknown> }
): Promise<string> {
  const parsed = parseSdJwtKbPresentation(mandate);
  if (!parsed.ok) throw new Error("test mandate must be parseable");
  const [encodedHeader, encodedPayload] = parsed.kbJwt.split(".");
  const header = {
    ...JSON.parse(Buffer.from(encodedHeader!, "base64url").toString("utf8")) as Record<string, unknown>,
    ...replacement.header
  };
  const payload = {
    ...JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as Record<string, unknown>,
    ...replacement.payload
  };
  const kbJwt = await signCompactJws(header, payload, holderP256PrivateKey, "ES256");
  return `${parsed.sdJwt}~${parsed.disclosures.map((disclosure) => `${disclosure}~`).join("")}${kbJwt}`;
}

async function replaceIssuer(
  mandate: string,
  mutate: (parts: { header: Record<string, unknown>; payload: Record<string, unknown> }) => void,
  opts: { refreshKbHash?: boolean } = {}
): Promise<string> {
  const parsed = parseSdJwtKbPresentation(mandate);
  if (!parsed.ok) throw new Error("test mandate must be parseable");
  const [encodedHeader, encodedPayload] = parsed.sdJwt.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader!, "base64url").toString("utf8")) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as Record<string, unknown>;
  mutate({ header, payload });
  const sdJwt = await signCompactJws(header, payload, holderP256PrivateKey, "ES256");
  const kbJwt = opts.refreshKbHash ? await kbWithSdHash(parsed.kbJwt, sdHashFor(sdJwt, parsed.disclosures)) : parsed.kbJwt;
  return `${sdJwt}~${parsed.disclosures.map((disclosure) => `${disclosure}~`).join("")}${kbJwt}`;
}

async function kbWithSdHash(kbJwt: string, sd_hash: string): Promise<string> {
  const [encodedHeader, encodedPayload] = kbJwt.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader!, "base64url").toString("utf8")) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as Record<string, unknown>;
  return await signCompactJws(header, { ...payload, sd_hash }, holderP256PrivateKey, "ES256");
}

function sdHashFor(sdJwt: string, disclosures: string[]): string {
  const input = `${sdJwt}~${disclosures.map((disclosure) => `${disclosure}~`).join("")}`;
  return createHash("sha256").update(Buffer.from(input, "utf8")).digest("base64url");
}

function tamperIssuerPayload(mandate: string): string {
  const parsed = parseSdJwtKbPresentation(mandate);
  if (!parsed.ok) throw new Error("test mandate must be parseable");
  const [encodedHeader, encodedPayload, encodedSignature] = parsed.sdJwt.split(".");
  const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as Record<string, unknown>;
  payload.aud = "https://tampered.example/.well-known/ucp";
  const sdJwt = `${encodedHeader}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${encodedSignature}`;
  return `${sdJwt}~${parsed.disclosures.map((disclosure) => `${disclosure}~`).join("")}${parsed.kbJwt}`;
}

function insertDisclosure(mandate: string, disclosure: string): string {
  const parsed = parseSdJwtKbPresentation(mandate);
  if (!parsed.ok) throw new Error("test mandate must be parseable");
  return `${parsed.sdJwt}~${[...parsed.disclosures, disclosure].map((item) => `${item}~`).join("")}${parsed.kbJwt}`;
}

async function signCompactJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: EcJwk,
  algorithm: HmsAlgorithm
): Promise<string> {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = await ecdsaSignRaw({
    algorithm,
    privateKeyJwk: privateKey,
    data: Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8")
  });
  return `${encodedHeader}.${encodedPayload}.${Buffer.from(signature).toString("base64url")}`;
}

function signerFor(privateKey: EcJwk, algorithm: HmsAlgorithm) {
  return async (data: string): Promise<string> => {
    const signature = await ecdsaSignRaw({ algorithm, privateKeyJwk: privateKey, data: Buffer.from(data, "utf8") });
    return Buffer.from(signature).toString("base64url");
  };
}

async function sha256Hasher(data: string | ArrayBuffer, alg: string): Promise<Uint8Array> {
  if (alg !== "sha-256" && alg !== "sha256") throw new Error(`unsupported hash alg: ${alg}`);
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return createHash("sha256").update(bytes).digest();
}

function expectFailure(
  result: Ap2MandateVerificationResult,
  code: Ap2ErrorCode,
  reason: Ap2MandateFailureReason
): void {
  expect(result).toEqual({ ok: false, code, reason });
}

function sampleCheckout(overrides: Partial<Checkout> = {}): Checkout {
  return {
    ucp: { version: "2026-04-17", status: "success", payment_handlers: {} },
    id: sessionId,
    status: "ready_for_complete",
    line_items: [{ id: "line_1", item: { id: "latte", title: "Latte", price: 500 }, quantity: 1 }],
    totals: [{ type: "total", amount: 500, display_text: "Total" }],
    currency: "USD",
    links: [],
    ...overrides
  };
}

function saltSequence(): () => string {
  let index = 0;
  return () => `salt-${index++}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function b64urlHex(value: string): string {
  return Buffer.from(value, "hex").toString("base64url");
}

const merchantP256PublicKey = {
  kid: "merchant-p256",
  kty: "EC",
  crv: "P-256",
  x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
  use: "sig",
  alg: "ES256"
} satisfies EcJwk;

const merchantP256PrivateKey = {
  ...merchantP256PublicKey,
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
} satisfies EcJwk;

const holderP256PublicKey = {
  kid: "holder-p256",
  kty: "EC",
  crv: "P-256",
  x: b64urlHex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"),
  y: b64urlHex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"),
  use: "sig",
  alg: "ES256"
} satisfies EcJwk;

const holderP256PrivateKey = {
  ...holderP256PublicKey,
  d: b64urlHex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
} satisfies EcJwk;
