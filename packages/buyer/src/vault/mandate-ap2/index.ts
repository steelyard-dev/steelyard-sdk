// Copyright (c) Steelyard contributors. MIT License.
import { createHash, randomBytes } from "node:crypto";
import { SDJwtInstance } from "@sd-jwt/core";
import type { Checkout } from "@steelyard/protocol/ucp/checkout";
import {
  defaultClock,
  type DisclosureTree,
  type EcJwk,
  type HmsAlgorithm
} from "@steelyard/core";

export interface Ap2CheckoutMandateSigner {
  exportUcpSigningPublicKey(): Promise<EcJwk>;
  signWithUcpKey(args: { data: Uint8Array; algorithm: HmsAlgorithm }): Promise<Uint8Array>;
}

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
  signer: Ap2CheckoutMandateSigner;
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
  signer: Ap2CheckoutMandateSigner;
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

type CoreDisclosureFrame<T extends Record<string, unknown>> = Parameters<SDJwtInstance<T>["issue"]>[1];
type CorePresentationFrame<T extends Record<string, unknown>> = Parameters<SDJwtInstance<T>["present"]>[1];

export async function issueAp2CheckoutMandate(
  args: IssueAp2CheckoutMandateArgs
): Promise<IssuedAp2CheckoutMandate> {
  const publicKey = publicHolderKey(await args.signer.exportUcpSigningPublicKey());
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

  const signer = signerForVault(args.signer, algorithm);
  const sdJwt = new SDJwtInstance<Ap2CheckoutMandateClaims>({
    signer,
    signAlg: algorithm,
    kbSigner: signer,
    kbSignAlg: algorithm,
    hasher: sha256Hasher,
    hashAlg: "sha-256",
    saltGenerator: args.saltGenerator ?? randomSalt
  });
  const issued = await sdJwt.issue(
    claims,
    disclosureFrame(claims, disclosureTree) as CoreDisclosureFrame<Ap2CheckoutMandateClaims>,
    { header: { typ: "dc+sd-jwt", kid: publicKey.kid } }
  );
  const checkoutMandate = await sdJwt.present(
    issued,
    presentationFrame(args.disclose, claims) as CorePresentationFrame<Ap2CheckoutMandateClaims>,
    {
      kb: {
        payload: {
          iat,
          aud: requiredString(args.audience, "audience"),
          nonce: requiredString(args.nonce, "nonce")
        }
      }
    }
  );
  const parsed = parseAp2CheckoutMandate(checkoutMandate);
  return {
    checkout_mandate: checkoutMandate,
    issuer_jwt: parsed.sdJwt,
    disclosures: parsed.disclosures,
    kb_jwt: parsed.kbJwt,
    claims
  };
}

export async function issueAp2PaymentMandate(
  args: IssueAp2PaymentMandateArgs
): Promise<IssuedAp2PaymentMandate> {
  const publicKey = publicHolderKey(await args.signer.exportUcpSigningPublicKey());
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

  const signer = signerForVault(args.signer, algorithm);
  const sdJwt = new SDJwtInstance<Ap2PaymentMandateClaims>({
    signer,
    signAlg: algorithm,
    kbSigner: signer,
    kbSignAlg: algorithm,
    hasher: sha256Hasher,
    hashAlg: "sha-256",
    saltGenerator: args.saltGenerator ?? randomSalt
  });
  const issued = await sdJwt.issue(claims, {}, { header: { typ: "dc+sd-jwt", kid: publicKey.kid } });
  const paymentMandate = await sdJwt.present(issued, {}, {
    kb: {
      payload: {
        iat,
        aud: requiredString(args.audience, "audience"),
        nonce: requiredString(args.nonce, "nonce")
      }
    }
  });
  const parsed = parseAp2PaymentMandate(paymentMandate);
  return {
    payment_mandate: paymentMandate,
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

function parseAp2SdJwtKbPresentation(value: string, label: string): ParsedAp2CheckoutMandate {
  const segments = value.split("~");
  if (segments.length < 2) throw new Error(`AP2 ${label} must contain SD-JWT and KB-JWT segments`);
  const sdJwt = requiredSegment(segments[0], "SD-JWT");
  const kbJwt = requiredSegment(segments[segments.length - 1], "KB-JWT");
  const disclosures = segments.slice(1, -1);
  const issuer = decodeCompactJws(sdJwt, "SD-JWT");
  const kb = decodeCompactJws(kbJwt, "KB-JWT");
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

export function ucpAp2PaymentTransactionId(checkout: Checkout): string {
  const merchantAuthorization = asRecord(asRecord(checkout).ap2).merchant_authorization;
  if (typeof merchantAuthorization !== "string" || !merchantAuthorization) {
    throw new Error("AP2 payment mandate requires checkout.ap2.merchant_authorization");
  }
  return createHash("sha256").update(Buffer.from(merchantAuthorization, "utf8")).digest("base64url");
}

export function ap2CheckoutMandateSdHashInput(value: string | ParsedAp2CheckoutMandate): string {
  const parsed = typeof value === "string" ? parseAp2CheckoutMandate(value) : value;
  return `${parsed.sdJwt}~${parsed.disclosures.map((disclosure) => `${disclosure}~`).join("")}`;
}

export function ap2CheckoutMandateSdHash(value: string | ParsedAp2CheckoutMandate): string {
  return createHash("sha256")
    .update(Buffer.from(ap2CheckoutMandateSdHashInput(value), "utf8"))
    .digest("base64url");
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

function signerForVault(signer: Ap2CheckoutMandateSigner, algorithm: HmsAlgorithm): (data: string) => Promise<string> {
  return async (data: string) => {
    const signature = await signer.signWithUcpKey({
      algorithm,
      data: Buffer.from(data, "utf8")
    });
    return Buffer.from(signature).toString("base64url");
  };
}

async function sha256Hasher(data: string | ArrayBuffer, alg: string): Promise<Uint8Array> {
  const normalized = alg.toLowerCase();
  if (normalized !== "sha-256" && normalized !== "sha256") {
    throw new Error(`unsupported SD-JWT hash algorithm: ${alg}`);
  }
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return createHash("sha256").update(bytes).digest();
}

function randomSalt(): string {
  return randomBytes(16).toString("base64url");
}

function publicHolderKey(key: EcJwk): EcJwk {
  const { d: _private, ...publicKey } = key as EcJwk & { d?: string };
  return cloneJson(publicKey) as EcJwk;
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

function decodeCompactJws(value: string, label: string): {
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

function requiredSegment(value: string | undefined, label: string): string {
  if (!value) throw new Error(`AP2 checkout mandate ${label} segment is required`);
  return value;
}

function requiredString(value: string, name: string): string {
  if (!value) throw new Error(`AP2 checkout mandate ${name} is required`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
