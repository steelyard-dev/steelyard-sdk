// Copyright (c) Steelyard contributors. MIT License.
import { createHash, randomBytes } from "node:crypto";
import {
  assertValidEcJwk,
  defaultClock,
  ecdsaVerifyRaw,
  jcsCanonicalize,
  verifyDetachedJws,
  type Ap2ErrorCode,
  type DisclosureTree,
  type EcJwk,
  type HmsAlgorithm,
  type PaymentCapability
} from "@steelyard/core";
import type { UcpSigner } from "./signer.js";

export type Checkout = Record<string, unknown>;
const PRIVATE_JWK_MEMBER = "d";

export interface Ap2CheckoutMandateSigner {
  exportUcpSigningPublicKey(): Promise<EcJwk>;
  signWithUcpKey(args: { data: Uint8Array; algorithm: HmsAlgorithm }): Promise<Uint8Array>;
}

export type Ap2MandateIssuerSigner = UcpSigner | Ap2CheckoutMandateSigner;

export interface Ap2CheckoutMandateBuyerClaims {
  email?: string;
  name?: string;
  address?: Record<string, unknown>;
}

export interface Ap2CheckoutMandateDisclosures {
  buyer?: {
    email?: boolean;
    name?: boolean;
    address?: boolean | string[];
  };
}

export interface IssueAp2CheckoutMandateArgs {
  signer: Ap2MandateIssuerSigner;
  checkout: Checkout;
  issuer: string;
  audience: string;
  nonce: string;
  buyer?: Ap2CheckoutMandateBuyerClaims;
  clock?: () => Date;
  expiresInSeconds?: number;
  disclosureTree?: DisclosureTree;
  disclose?: Ap2CheckoutMandateDisclosures;
  saltGenerator?: () => string;
}

export interface Ap2CheckoutMandateClaims extends Record<string, unknown> {
  iss: string;
  iat: number;
  exp: number;
  aud: string;
  cnf: { jwk: EcJwk };
  "ap2:checkout": Checkout;
  buyer?: Ap2CheckoutMandateBuyerClaims;
}

export interface IssuedAp2CheckoutMandate {
  checkout_mandate: string;
  issuer_jwt: string;
  disclosures: string[];
  kb_jwt: string;
  claims: Ap2CheckoutMandateClaims;
}

export interface ParsedAp2CheckoutMandate {
  sdJwt: string;
  disclosures: string[];
  kbJwt: string;
  issuerHeader: Record<string, unknown>;
  issuerPayload: Record<string, unknown>;
  kbHeader: Record<string, unknown>;
  kbPayload: Record<string, unknown>;
}

export interface Ap2PaymentAmount {
  amount: number;
  currency: string;
}

export interface Ap2PaymentMerchant {
  id: string;
  name: string;
  website?: string;
}

export interface Ap2PaymentInstrument {
  id: string;
  type: string;
  description?: string;
}

export interface Ap2PaymentIntent {
  amount: number;
  currency: string;
  checkout_id: string;
  expires_at: string;
}

export interface Ap2PaymentHandlerBinding {
  handler: string;
}

export interface IssueAp2PaymentMandateArgs {
  signer: Ap2MandateIssuerSigner;
  checkout: Checkout;
  issuer: string;
  audience: string;
  nonce: string;
  payment: Ap2PaymentIntent;
  payee: Ap2PaymentMerchant;
  paymentInstrument: Ap2PaymentInstrument;
  handlerId?: string;
  clock?: () => Date;
  expiresInSeconds?: number;
  saltGenerator?: () => string;
}

export interface Ap2PspPaymentIntent {
  amount: number;
  currency: string;
  checkout_id: string;
  expires_at: string;
  transaction_id?: string;
}

export interface Ap2PspPaymentMandate {
  format: "ap2-sd-jwt-kb";
  payload: string;
  holder_jwk: EcJwk;
  payment_intent: Ap2PspPaymentIntent;
}

export interface Ap2PaymentMandateClaims extends Record<string, unknown> {
  iss: string;
  iat: number;
  exp: number;
  aud: string;
  cnf: { jwk: EcJwk };
  vct: "mandate.payment.1";
  transaction_id: string;
  payee: Ap2PaymentMerchant;
  payment?: Ap2PaymentHandlerBinding;
  payment_amount: Ap2PaymentAmount;
  payment_instrument: Ap2PaymentInstrument;
  execution_date?: string;
}

export interface IssuedAp2PaymentMandate {
  payment_mandate: string;
  issuer_jwt: string;
  disclosures: string[];
  kb_jwt: string;
  transaction_id: string;
  claims: Ap2PaymentMandateClaims;
}

export type ParsedAp2PaymentMandate = ParsedAp2CheckoutMandate;

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
    envelope: Ap2MandateEnvelope,
    expectedCheckout: Checkout,
    session_id: string
  ): Promise<Ap2MandateVerificationResult>;
}

export interface Ap2MandateTrustModel {
  kind: "digital_payment_credential";
  resolveIssuerKey(args: {
    issuer: string;
    kid: string;
    alg: HmsAlgorithm;
    claims: Record<string, unknown>;
  }): Promise<EcJwk | null> | EcJwk | null;
}

export type Ap2NonceConsumeFailureReason = "missing" | "expired" | "session_mismatch" | "already_consumed";

export type Ap2NonceConsumeResult =
  | { ok: true }
  | { ok: false; reason: Ap2NonceConsumeFailureReason };

export interface Ap2NonceStore {
  consume(args: { nonce: string; session_id: string }): Promise<Ap2NonceConsumeResult> | Ap2NonceConsumeResult;
}

export interface Ap2MandateEnvelope {
  ap2?: {
    checkout_mandate?: unknown;
    [key: string]: unknown;
  };
  "ap2.checkout_mandate"?: unknown;
  [key: string]: unknown;
}

export interface SdJwtKbVerifierOptions {
  trustModel: Ap2MandateTrustModel;
  expectedAudience: (checkout: Checkout) => string;
  nonceStore: Ap2NonceStore;
  merchantSigningKeys: EcJwk[];
  clock?: () => Date;
}

export type ParseSdJwtKbPresentationResult =
  | { ok: true; sdJwt: string; disclosures: string[]; kbJwt: string }
  | { ok: false; reason: "shape_invalid" | "missing_kb_jwt" | "empty_segment" };

export type Ap2PaymentMandateVerificationResult =
  | { ok: true; claims: Record<string, unknown> }
  | {
      ok: false;
      reason:
        | "shape_invalid"
        | "issuer_header_invalid"
        | "issuer_signature_invalid"
        | "holder_key_invalid"
        | "claims_invalid"
        | "kb_header_invalid"
        | "kb_signature_invalid"
        | "sd_hash_mismatch"
        | "iat_in_future"
        | "expired"
        | "transaction_mismatch"
        | "amount_mismatch"
        | "currency_mismatch"
        | "handler_mismatch";
    };

export interface MerchantAuthorizationSigner {
  sign(checkout: Checkout): Promise<string>;
}

export interface Ap2MerchantAuthorizationSignerOptions {
  signer: UcpSigner;
}

export class Ap2MerchantAuthorizationSignerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ap2MerchantAuthorizationSignerConfigError";
  }
}

export class Ap2MandateVerifierConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ap2MandateVerifierConfigError";
  }
}

export const AP2_CHECKOUT_MANDATE_DISCLOSURE_TREE: DisclosureTree = {
  alwaysDisclosed: [
    "$.iss",
    "$.iat",
    "$.exp",
    "$.aud",
    "$.cnf",
    "$.ap2:checkout.id",
    "$.ap2:checkout.currency",
    "$.ap2:checkout.line_items",
    "$.ap2:checkout.totals",
    "$.ap2:checkout.ap2.merchant_authorization"
  ],
  selectivelyDisclosed: ["$.buyer.email", "$.buyer.name", "$.buyer.address.*"]
};

const REQUIRED_ALWAYS_DISCLOSED = [
  "$.ap2:checkout.id",
  "$.ap2:checkout.currency",
  "$.ap2:checkout.line_items",
  "$.ap2:checkout.totals",
  "$.ap2:checkout.ap2.merchant_authorization"
] as const;

interface DisclosureRecord {
  path: string[];
  key: string;
  encoded: string;
}

export async function issueAp2CheckoutMandate(
  args: IssueAp2CheckoutMandateArgs
): Promise<IssuedAp2CheckoutMandate> {
  const publicKey = publicHolderKey(await publicJwkForSigner(args.signer));
  const algorithm = algorithmForKey(publicKey);
  const now = defaultClock(args.clock)();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + validExpiresInSeconds(args.expiresInSeconds ?? 300);
  const disclosureTree = args.disclosureTree ?? AP2_CHECKOUT_MANDATE_DISCLOSURE_TREE;
  validateDisclosureTree(disclosureTree);
  const checkout = cloneJson(args.checkout);
  assertCheckoutCarriesMerchantAuthorization(checkout);

  const claims: Ap2CheckoutMandateClaims = {
    iss: requiredString(args.issuer, "issuer"),
    iat,
    exp,
    aud: requiredString(args.audience, "audience"),
    cnf: { jwk: publicKey },
    "ap2:checkout": checkout,
    ...(args.buyer ? { buyer: cloneJson(args.buyer) } : {})
  };

  const issued = await issueSdJwtKbPresentation({
    claims,
    signer: args.signer,
    algorithm,
    kid: publicKey.kid,
    typ: "dc+sd-jwt",
    kbPayload: {
      iat,
      aud: requiredString(args.audience, "audience"),
      nonce: requiredString(args.nonce, "nonce")
    },
    disclosureFrame: disclosureFrame(claims, disclosureTree),
    presentationFrame: presentationFrame(args.disclose, claims),
    saltGenerator: args.saltGenerator ?? randomSalt
  });
  const parsed = parseAp2CheckoutMandate(issued.presentation);
  return {
    checkout_mandate: issued.presentation,
    issuer_jwt: parsed.sdJwt,
    disclosures: parsed.disclosures,
    kb_jwt: parsed.kbJwt,
    claims
  };
}

export async function issueAp2PaymentMandate(
  args: IssueAp2PaymentMandateArgs
): Promise<IssuedAp2PaymentMandate> {
  const publicKey = publicHolderKey(await publicJwkForSigner(args.signer));
  const algorithm = algorithmForKey(publicKey);
  const now = defaultClock(args.clock)();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + validExpiresInSeconds(args.expiresInSeconds ?? 300);
  const transaction_id = ucpAp2PaymentTransactionId(args.checkout);
  const payment = validPaymentIntent(args.payment);

  const claims: Ap2PaymentMandateClaims = {
    iss: requiredString(args.issuer, "issuer"),
    iat,
    exp,
    aud: requiredString(args.audience, "audience"),
    cnf: { jwk: publicKey },
    vct: "mandate.payment.1",
    transaction_id,
    payee: validPayee(args.payee),
    ...(args.handlerId ? { payment: validPaymentHandlerBinding(args.handlerId) } : {}),
    payment_amount: {
      amount: payment.amount,
      currency: payment.currency
    },
    payment_instrument: validPaymentInstrument(args.paymentInstrument)
  };

  const issued = await issueSdJwtKbPresentation({
    claims,
    signer: args.signer,
    algorithm,
    kid: publicKey.kid,
    typ: "dc+sd-jwt",
    kbPayload: {
      iat,
      aud: requiredString(args.audience, "audience"),
      nonce: requiredString(args.nonce, "nonce")
    },
    disclosureFrame: {},
    presentationFrame: {},
    saltGenerator: args.saltGenerator ?? randomSalt
  });
  const parsed = parseAp2PaymentMandate(issued.presentation);
  return {
    payment_mandate: issued.presentation,
    issuer_jwt: parsed.sdJwt,
    disclosures: parsed.disclosures,
    kb_jwt: parsed.kbJwt,
    transaction_id,
    claims
  };
}

export function parseAp2CheckoutMandate(value: string): ParsedAp2CheckoutMandate {
  return parseAp2SdJwtKbPresentation(value, "checkout mandate");
}

export function parseAp2PaymentMandate(value: string): ParsedAp2PaymentMandate {
  return parseAp2SdJwtKbPresentation(value, "payment mandate");
}

export function ucpAp2PaymentTransactionId(checkout: Checkout): string {
  const merchantAuthorization = asRecord(asRecord(checkout).ap2).merchant_authorization;
  if (typeof merchantAuthorization !== "string" || !merchantAuthorization) {
    throw new Error("AP2 payment mandate requires checkout.ap2.merchant_authorization");
  }
  return createHash("sha256").update(Buffer.from(merchantAuthorization, "utf8")).digest("base64url");
}

export function ap2CheckoutMandateSdHashInput(value: string | ParsedAp2CheckoutMandate): string {
  const parsed = typeof value === "string" ? parseAp2CheckoutMandate(value) : value;
  return sdHashInput(parsed);
}

export function ap2CheckoutMandateSdHash(value: string | ParsedAp2CheckoutMandate): string {
  const parsed = typeof value === "string" ? parseAp2CheckoutMandate(value) : value;
  return sdHash(parsed);
}

export function ap2MerchantAuthorizationSigner(
  opts: Ap2MerchantAuthorizationSignerOptions
): MerchantAuthorizationSigner {
  return {
    async sign(checkout) {
      const publicKey = assertValidEcJwk(await opts.signer.publicJwk());
      const algorithm = algorithmForKey(publicKey);
      return await signDetachedJwsWithUcpSigner({
        payload: jcsCanonicalize(checkoutWithoutAp2(checkout)),
        header: { alg: algorithm, kid: publicKey.kid },
        signer: opts.signer
      });
    }
  };
}

export function checkoutWithoutAp2<T extends Checkout>(checkout: T): T {
  const { ap2: _ap2, ...payload } = checkout;
  return payload as T;
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

      const claims = unpackClaims(token);
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

export async function verifyAp2PaymentMandate(args: {
  mandate: Ap2PspPaymentMandate;
  expectedHandlerId?: string;
  clock: () => Date;
  capabilities: readonly PaymentCapability[];
}): Promise<Ap2PaymentMandateVerificationResult> {
  const { mandate } = args;
  if ((mandate as { format?: string }).format !== "ap2-sd-jwt-kb" || !mandate.payload) {
    return { ok: false, reason: "shape_invalid" };
  }
  const parsed = parseSdJwtKbPresentation(mandate.payload);
  if (!parsed.ok) return { ok: false, reason: "shape_invalid" };
  const issuerJwt = decodeCompactJws(parsed.sdJwt);
  const kbJwt = decodeCompactJws(parsed.kbJwt);
  if (!issuerJwt || !kbJwt) return { ok: false, reason: "shape_invalid" };
  const holderKey = validHolderKey(mandate.holder_jwk);
  if (!holderKey) return { ok: false, reason: "holder_key_invalid" };
  const issuerAlg = hmsAlgorithm(issuerJwt.header.alg);
  const issuerKid = typeof issuerJwt.header.kid === "string" ? issuerJwt.header.kid : "";
  if (issuerJwt.header.typ !== "dc+sd-jwt" || !issuerAlg || issuerKid !== holderKey.kid) {
    return { ok: false, reason: "issuer_header_invalid" };
  }
  if (!(await verifyJwsSignature(issuerJwt, issuerAlg, holderKey))) {
    return { ok: false, reason: "issuer_signature_invalid" };
  }
  const claims = unpackClaims(mandate.payload);
  if (!claims) return { ok: false, reason: "claims_invalid" };

  const kbAlg = hmsAlgorithm(kbJwt.header.alg);
  if (kbJwt.header.typ !== "kb+jwt" || !kbAlg) return { ok: false, reason: "kb_header_invalid" };
  if (!(await verifyJwsSignature(kbJwt, kbAlg, holderKey))) {
    return { ok: false, reason: "kb_signature_invalid" };
  }
  if (kbJwt.payload.sd_hash !== sdHash(parsed)) return { ok: false, reason: "sd_hash_mismatch" };

  const now = Math.floor(args.clock().getTime() / 1000);
  if (!validNumber(kbJwt.payload.iat) || kbJwt.payload.iat > now) return { ok: false, reason: "iat_in_future" };
  if (!validNumber(claims.exp) || claims.exp <= now) return { ok: false, reason: "expired" };
  if (claims.vct !== "mandate.payment.1") return { ok: false, reason: "claims_invalid" };

  const paymentHandler = stringValue(asRecord(claims.payment).handler, "");
  const paymentInstrument = asRecord(claims.payment_instrument);
  const instrumentType = stringValue(paymentInstrument.type, "");
  if (instrumentType) {
    const declaredForInstrument = args.capabilities.filter((capability) => capability.instrumentType === instrumentType);
    if (declaredForInstrument.length) {
      if (!paymentHandler || !args.expectedHandlerId || paymentHandler !== args.expectedHandlerId) {
        return { ok: false, reason: "handler_mismatch" };
      }
      const capability = declaredForInstrument.find((candidate) => candidate.handlerId === paymentHandler);
      if (!capability) {
        return { ok: false, reason: "handler_mismatch" };
      }
      const tokenId = stringValue(paymentInstrument.id, "");
      if (capability.idPrefix && !tokenId.startsWith(capability.idPrefix)) return { ok: false, reason: "claims_invalid" };
    } else if (paymentHandler && args.expectedHandlerId && paymentHandler !== args.expectedHandlerId) {
      return { ok: false, reason: "handler_mismatch" };
    }
  } else if (paymentHandler && args.expectedHandlerId && paymentHandler !== args.expectedHandlerId) {
    return { ok: false, reason: "handler_mismatch" };
  }

  const intent = mandate.payment_intent;
  if (!intent?.transaction_id || claims.transaction_id !== intent.transaction_id) {
    return { ok: false, reason: "transaction_mismatch" };
  }
  const amount = asRecord(claims.payment_amount);
  if (amount.amount !== intent.amount) return { ok: false, reason: "amount_mismatch" };
  if (amount.currency !== intent.currency) return { ok: false, reason: "currency_mismatch" };
  if (Date.parse(intent.expires_at) <= args.clock().getTime()) return { ok: false, reason: "expired" };
  return { ok: true, claims };
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

async function issueSdJwtKbPresentation(args: {
  claims: Record<string, unknown>;
  signer: Ap2MandateIssuerSigner;
  algorithm: HmsAlgorithm;
  kid: string;
  typ: "dc+sd-jwt";
  kbPayload: Record<string, unknown>;
  disclosureFrame: Record<string, unknown>;
  presentationFrame: Record<string, unknown>;
  saltGenerator: () => string;
}): Promise<{ presentation: string }> {
  const { payload, disclosureRecords } = applyDisclosureFrame(args.claims, args.disclosureFrame, args.saltGenerator);
  if (disclosureRecords.length > 0) payload._sd_alg = "sha-256";
  const sdJwt = await signCompactJwsWithMandateSigner({
    header: { alg: args.algorithm, typ: args.typ, kid: args.kid },
    payload,
    signer: args.signer,
    algorithm: args.algorithm
  });
  const selectedDisclosures = disclosureRecords
    .filter((record) => presentationFrameAllows(args.presentationFrame, record.path, record.key))
    .map((record) => record.encoded);
  const kbJwt = await signCompactJwsWithMandateSigner({
    header: { alg: args.algorithm, typ: "kb+jwt" },
    payload: {
      ...args.kbPayload,
      sd_hash: sdHash({ sdJwt, disclosures: selectedDisclosures })
    },
    signer: args.signer,
    algorithm: args.algorithm
  });
  return {
    presentation: `${sdJwt}~${selectedDisclosures.map((disclosure) => `${disclosure}~`).join("")}${kbJwt}`
  };
}

function applyDisclosureFrame(
  claims: Record<string, unknown>,
  frame: Record<string, unknown>,
  saltGenerator: () => string
): { payload: Record<string, unknown>; disclosureRecords: DisclosureRecord[] } {
  const payload = cloneJson(claims);
  const disclosureRecords: DisclosureRecord[] = [];
  applyDisclosureFrameToRecord(payload, frame, [], saltGenerator, disclosureRecords);
  return { payload, disclosureRecords };
}

function applyDisclosureFrameToRecord(
  target: Record<string, unknown>,
  frame: Record<string, unknown>,
  path: string[],
  saltGenerator: () => string,
  disclosureRecords: DisclosureRecord[]
): void {
  const sd = frame._sd;
  if (Array.isArray(sd)) {
    for (const key of sd) {
      if (typeof key !== "string" || !Object.hasOwn(target, key)) continue;
      const value = target[key];
      delete target[key];
      const encoded = encodeDisclosure([saltGenerator(), key, value]);
      const digests = Array.isArray(target._sd) ? target._sd : [];
      digests.push(createHash("sha256").update(Buffer.from(encoded, "utf8")).digest("base64url"));
      target._sd = digests;
      disclosureRecords.push({ path, key, encoded });
    }
  }
  for (const [key, childFrame] of Object.entries(frame)) {
    if (key === "_sd" || !isRecord(childFrame) || !isRecord(target[key])) continue;
    applyDisclosureFrameToRecord(target[key], childFrame, [...path, key], saltGenerator, disclosureRecords);
  }
}

function presentationFrameAllows(frame: Record<string, unknown>, path: string[], key: string): boolean {
  let current: unknown = frame;
  for (const segment of path) {
    current = asRecord(current)[segment];
  }
  return asRecord(current)[key] === true;
}

function encodeDisclosure(value: unknown[]): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseAp2SdJwtKbPresentation(value: string, label: string): ParsedAp2CheckoutMandate {
  const segments = value.split("~");
  if (segments.length < 2) throw new Error(`AP2 ${label} must contain SD-JWT and KB-JWT segments`);
  const sdJwt = requiredSegment(segments[0], "SD-JWT");
  const kbJwt = requiredSegment(segments[segments.length - 1], "KB-JWT");
  const disclosures = segments.slice(1, -1);
  const issuer = decodeCompactJwsForParse(sdJwt, "SD-JWT");
  const kb = decodeCompactJwsForParse(kbJwt, "KB-JWT");
  return {
    sdJwt,
    disclosures,
    kbJwt,
    issuerHeader: issuer.header,
    issuerPayload: issuer.payload,
    kbHeader: kb.header,
    kbPayload: kb.payload
  };
}

function disclosureFrame(
  claims: Ap2CheckoutMandateClaims,
  tree: DisclosureTree
): Record<string, unknown> {
  if (!claims.buyer) return {};
  const buyerFrame: Record<string, unknown> = {};
  const buyerSd: string[] = [];
  if (claims.buyer.email && tree.selectivelyDisclosed.includes("$.buyer.email")) buyerSd.push("email");
  if (claims.buyer.name && tree.selectivelyDisclosed.includes("$.buyer.name")) buyerSd.push("name");
  if (buyerSd.length) buyerFrame._sd = buyerSd;

  if (claims.buyer.address && tree.selectivelyDisclosed.includes("$.buyer.address.*")) {
    buyerFrame.address = { _sd: Object.keys(claims.buyer.address) };
  }

  return Object.keys(buyerFrame).length ? { buyer: buyerFrame } : {};
}

function presentationFrame(
  disclose: Ap2CheckoutMandateDisclosures | undefined,
  claims: Ap2CheckoutMandateClaims
): Record<string, unknown> {
  const buyer: Record<string, unknown> = {};
  if (disclose?.buyer?.email) buyer.email = true;
  if (disclose?.buyer?.name) buyer.name = true;
  if (disclose?.buyer?.address === true) {
    buyer.address = Object.fromEntries(Object.keys(claims.buyer?.address ?? {}).map((key) => [key, true]));
  } else if (Array.isArray(disclose?.buyer?.address)) {
    buyer.address = Object.fromEntries(disclose.buyer.address.map((key) => [key, true]));
  }
  return Object.keys(buyer).length ? { buyer } : {};
}

function validateDisclosureTree(tree: DisclosureTree): void {
  for (const path of REQUIRED_ALWAYS_DISCLOSED) {
    if (!tree.alwaysDisclosed.includes(path)) {
      throw new Error(`AP2 checkout mandate disclosure tree must always disclose ${path}`);
    }
    if (tree.selectivelyDisclosed.includes(path)) {
      throw new Error(`AP2 checkout mandate disclosure tree must not selectively disclose ${path}`);
    }
  }
}

function assertCheckoutCarriesMerchantAuthorization(checkout: Checkout): void {
  const merchantAuthorization = asRecord(asRecord(checkout).ap2).merchant_authorization;
  if (typeof merchantAuthorization !== "string" || !merchantAuthorization) {
    throw new Error("AP2 checkout mandate requires checkout.ap2.merchant_authorization");
  }
}

async function publicJwkForSigner(signer: Ap2MandateIssuerSigner): Promise<EcJwk> {
  if (isUcpSigner(signer)) return await signer.publicJwk();
  return await signer.exportUcpSigningPublicKey();
}

async function signCompactJwsWithMandateSigner(args: {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signer: Ap2MandateIssuerSigner;
  algorithm: HmsAlgorithm;
}): Promise<string> {
  const encodedHeader = Buffer.from(JSON.stringify(args.header), "utf8").toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(args.payload), "utf8").toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const data = Buffer.from(signingInput, "utf8");
  const signature = isUcpSigner(args.signer)
    ? await args.signer.sign(data, args.algorithm)
    : await args.signer.signWithUcpKey({ data, algorithm: args.algorithm });
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

async function signDetachedJwsWithUcpSigner(args: {
  payload: Uint8Array;
  header: { alg: HmsAlgorithm; kid: string };
  signer: UcpSigner;
}): Promise<string> {
  const encodedHeader = Buffer.from(JSON.stringify(args.header), "utf8").toString("base64url");
  const encodedPayload = Buffer.from(args.payload).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await args.signer.sign(Buffer.from(signingInput, "utf8"), args.header.alg);
  return `${encodedHeader}..${Buffer.from(signature).toString("base64url")}`;
}

function isUcpSigner(value: Ap2MandateIssuerSigner): value is UcpSigner {
  return "publicJwk" in value && "sign" in value;
}

function randomSalt(): string {
  return randomBytes(16).toString("base64url");
}

function publicHolderKey(key: EcJwk): EcJwk {
  const publicKey = cloneJson(key) as Record<string, unknown>;
  if (Object.hasOwn(publicKey, PRIVATE_JWK_MEMBER)) {
    throw new Error("AP2 holder public key must not include private d");
  }
  return publicKey as EcJwk;
}

function algorithmForKey(key: EcJwk): HmsAlgorithm {
  if (key.alg === "ES256" || key.crv === "P-256") return "ES256";
  if (key.alg === "ES384" || key.crv === "P-384") return "ES384";
  throw new Error(`unsupported AP2 holder key algorithm: ${key.alg ?? key.crv}`);
}

function validExpiresInSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("AP2 checkout mandate expiresInSeconds must be a positive integer");
  }
  return value;
}

function validPaymentIntent(value: Ap2PaymentIntent): Ap2PaymentIntent {
  if (!Number.isSafeInteger(value.amount) || value.amount < 0) {
    throw new Error("AP2 payment mandate amount must be a non-negative integer");
  }
  if (!/^[A-Z]{3}$/.test(value.currency)) {
    throw new Error("AP2 payment mandate currency must be ISO 4217 uppercase");
  }
  requiredString(value.checkout_id, "checkout_id");
  requiredString(value.expires_at, "expires_at");
  if (Number.isNaN(Date.parse(value.expires_at))) {
    throw new Error("AP2 payment mandate expires_at must be an ISO date string");
  }
  return cloneJson(value);
}

function validPayee(value: Ap2PaymentMerchant): Ap2PaymentMerchant {
  const payee = cloneJson(value);
  requiredString(payee.id, "payee.id");
  requiredString(payee.name, "payee.name");
  if (payee.website !== undefined) requiredString(payee.website, "payee.website");
  return payee;
}

function validPaymentHandlerBinding(handlerId: string): Ap2PaymentHandlerBinding {
  return { handler: requiredString(handlerId, "payment.handler") };
}

function validPaymentInstrument(value: Ap2PaymentInstrument): Ap2PaymentInstrument {
  const instrument = cloneJson(value);
  requiredString(instrument.id, "payment_instrument.id");
  requiredString(instrument.type, "payment_instrument.type");
  if (instrument.description !== undefined) requiredString(instrument.description, "payment_instrument.description");
  return instrument;
}

function decodeCompactJwsForParse(value: string, label: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
} {
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error(`AP2 checkout mandate ${label} must use compact JWS serialization`);
  }
  return {
    header: decodeJsonPart(parts[0], `${label} header`),
    payload: decodeJsonPart(parts[1], `${label} payload`),
    signature: parts[2]
  };
}

function decodeJsonPart(value: string, label: string): Record<string, unknown> {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("not an object");
    return decoded as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`AP2 checkout mandate ${label} is invalid JSON`, { cause });
  }
}

function checkoutMandateFromEnvelope(envelope: Ap2MandateEnvelope): unknown {
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

function unpackClaims(value: string): Record<string, unknown> | null {
  const parsed = parseSdJwtKbPresentation(value);
  if (!parsed.ok) return null;
  const issuerJwt = decodeCompactJws(parsed.sdJwt);
  if (!issuerJwt) return null;
  const claims = cloneJson(issuerJwt.payload);
  for (const disclosure of parsed.disclosures) {
    if (!applyDisclosure(claims, disclosure)) return null;
  }
  stripSdMetadata(claims);
  return claims;
}

function applyDisclosure(claims: Record<string, unknown>, disclosure: string): boolean {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(disclosure, "base64url").toString("utf8")) as unknown;
  } catch {
    return false;
  }
  if (!Array.isArray(decoded) || decoded.length !== 3 || typeof decoded[1] !== "string") return false;
  const digest = createHash("sha256").update(Buffer.from(disclosure, "utf8")).digest("base64url");
  const container = findDisclosureContainer(claims, digest);
  if (!container) return false;
  container[decoded[1]] = decoded[2];
  return true;
}

function findDisclosureContainer(value: unknown, digest: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const sd = value._sd;
  if (Array.isArray(sd) && sd.includes(digest)) return value;
  for (const item of Object.values(value)) {
    const found = findDisclosureContainer(item, digest);
    if (found) return found;
  }
  return null;
}

function stripSdMetadata(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripSdMetadata(item);
    return;
  }
  if (!isRecord(value)) return;
  delete value._sd;
  delete value._sd_alg;
  for (const item of Object.values(value)) stripSdMetadata(item);
}

function holderKeyFromClaims(claims: Record<string, unknown>): EcJwk | null {
  try {
    return assertValidEcJwk(asRecord(claims.cnf).jwk);
  } catch {
    return null;
  }
}

function validHolderKey(value: EcJwk): EcJwk | null {
  try {
    return assertValidEcJwk(value);
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
  return createHash("sha256").update(Buffer.from(sdHashInput(parsed), "utf8")).digest("base64url");
}

function sdHashInput(parsed: { sdJwt: string; disclosures: string[] }): string {
  return `${parsed.sdJwt}~${parsed.disclosures.map((disclosure) => `${disclosure}~`).join("")}`;
}

function hmsAlgorithm(value: unknown): HmsAlgorithm | null {
  return value === "ES256" || value === "ES384" ? value : null;
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

function requiredSegment(value: string | undefined, label: string): string {
  if (!value) throw new Error(`AP2 checkout mandate ${label} segment is required`);
  return value;
}

function requiredString(value: string, name: string): string {
  if (!value) throw new Error(`AP2 checkout mandate ${name} is required`);
  return value;
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

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function fail(code: Ap2ErrorCode, reason: Ap2MandateFailureReason): Ap2MandateVerificationResult {
  return { ok: false, code, reason };
}
