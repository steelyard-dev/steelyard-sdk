// Copyright (c) Steelyard contributors. MIT License.
import type {
  BillingPayload,
  CardMetadata,
  PurchaseIntent,
  SimpleCard
} from "./schemas.js";
import { newIdempotencyKey, type IdempotencyKey } from "./idempotency/index.js";
import type { OrderState } from "./order-state.js";

export type Protocol = "mcp" | "acp" | "ucp";
export type JsonWebKey = Record<string, unknown>;

export interface RawCard extends CardMetadata {
  pan: string;
  cvc?: string;
}

export interface FulfillmentSummary {
  status?: string;
  method?: string;
  tracking?: string | string[];
  [key: string]: unknown;
}

export interface Receipt {
  intent: PurchaseIntent;
  protocol: "acp" | "ucp";
  order_id: string;
  merchant_order_id?: string;
  status: OrderState;
  charged_amount: number;
  charged_currency: string;
  created_at: string;
  reference: {
    acp?: { checkout_session_id: string; vault_token_id: string; psp_payment_id?: string };
    ucp?: { checkout_id: string; mandate_id?: string; vault_token_id: string; psp_payment_id?: string };
  };
  fulfillment?: FulfillmentSummary;
}

export interface MandateRef {
  kind: "steelyard.v0.1";
  jwt: string;
  key_id: string;
  expires_at: string;
}

export interface Allowance {
  merchant_id: string;
  max_amount: number;
  currency: string;
  expires_at: string;
  checkout_session_id?: string;
}

export interface ApprovalProof {
  kind: "3ds" | "step_up" | "manual";
  token?: string;
  receipt?: string;
}

export interface ApprovalResume {
  protocol: "acp" | "ucp";
  checkout_id: string;
  idempotency_key: string;
  expires_at: string;
  reservation_id: string;
}

export interface WalletDriverPort {
  withRawCard<T>(fn: (card: RawCard) => Promise<T>): Promise<T>;
  billing: BillingPayload;
  signMandate(payload: object): Promise<{ jwt: string; key_id: string }>;
  pairwiseSubject(audience: string): Promise<string>;
  mandatePublicKey(): Promise<{ jwk: JsonWebKey; key_id: string }>;
}

export interface Total {
  type: string;
  amount: number;
  [key: string]: unknown;
}

export interface Merchant {
  id: string;
  protocol: Protocol;
  origin?: string;
  url?: string;
  baseUrl?: string;
  base_url?: string;
  transport_url?: string;
  discoveryUrl?: string;
  discovery_url?: string;
  discoveryPath?: string;
  discovery_path?: string;
}

export type Checkout = Record<string, unknown>;

export { newIdempotencyKey, type IdempotencyKey, type OrderState };

export function totalAmount(totals: Total[]): number {
  if (!Array.isArray(totals)) {
    throw new Error("totals must be an array");
  }
  const totalRows = totals.filter((total) => total?.type === "total");
  if (totalRows.length !== 1) {
    throw new Error(`expected exactly one total row, received ${totalRows.length}`);
  }
  const amount = totalRows[0]!.amount;
  if (!Number.isSafeInteger(amount)) {
    throw new Error("total amount must be a safe integer");
  }
  return amount;
}

export function canonicalMerchantAudience(merchant: Merchant): string {
  const discoveryUrl = merchant.discoveryUrl ?? merchant.discovery_url;
  if (discoveryUrl) return canonicalUrl(discoveryUrl);

  const base = merchant.origin ?? merchant.baseUrl ?? merchant.base_url ?? merchant.transport_url ?? merchant.url;
  if (!base) {
    throw new Error("merchant audience requires an origin, base URL, transport URL, or discovery URL");
  }
  const path = merchant.discoveryPath ?? merchant.discovery_path ?? defaultDiscoveryPath(merchant.protocol);
  return `${canonicalOrigin(base)}${normalizePath(path)}`;
}

export function canonicalizeForSigning(checkout: Checkout): unknown {
  return canonicalizeJsonValue(checkout);
}

export function redactCardData(s: string): string {
  return s
    .replace(
      /\b(cvc|cvv|security[_ -]?code)\b(["']?\s*[:=]\s*)(["']?)\d{3,4}\3/gi,
      (_match, key: string, sep: string, quote: string) => `${key}${sep}${quote}[REDACTED_CVC]${quote}`
    )
    .replace(
      /\b(pan|card[_ -]?number|cardNumber)\b(["']?\s*[:=]\s*)(["']?)\d(?:[ -]?\d){12,18}\3/gi,
      (_match, key: string, sep: string, quote: string) => `${key}${sep}${quote}[REDACTED_PAN]${quote}`
    )
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, (candidate) => {
      const digits = candidate.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 ? "[REDACTED_PAN]" : candidate;
    });
}

export function rawCardFromSimple(card: SimpleCard & { cvc?: string }, metadata: CardMetadata): RawCard {
  return {
    ...metadata,
    pan: card.number.replace(/\s+/g, ""),
    exp: card.exp,
    name_on_card: card.name,
    cvc: card.cvc
  };
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalizeJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot canonicalize non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = canonicalizeJsonValue(child);
    }
    return out;
  }
  throw new Error(`cannot canonicalize ${typeof value}`);
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function canonicalOrigin(value: string): string {
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  return url.origin;
}

function normalizePath(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return new URL(value).pathname;
  return value.startsWith("/") ? value : `/${value}`;
}

function defaultDiscoveryPath(protocol: Protocol): string {
  if (protocol === "ucp") return "/.well-known/ucp";
  if (protocol === "acp") return "/.well-known/acp.json";
  return "/.well-known/mcp";
}
